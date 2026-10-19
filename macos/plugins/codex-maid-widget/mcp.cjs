'use strict';

// The MCP process never starts the desktop app or reads Codex credentials.
// stdout belongs exclusively to newline-delimited JSON-RPC messages.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');

const ACTIONS = ['show', 'hide', 'refresh', 'bounce', 'settings'];
const CHARACTER_NAMES = new Map([['mint-maid', '薄荷女仆'], ['lilac-dragon', '紫晶龙女仆'], ['frost-glass-idle', '小龙娘-端庄'], ['frost-glass-cheek', '小龙娘-托腮']]);
const MAX_BYTES = 1024 * 1024;
const TOOLS = [
  {
    name: 'get_widget_status',
    description: '查看正在运行的 Codex 女仆挂件的安全状态、额度快照和本地用量。请先打开桌面应用；Windows 可用 start.cmd，macOS 可用应用或 start.command。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: '查看女仆挂件状态', readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'control_widget',
    description: '控制本机女仆挂件：show 显示、hide 隐藏、refresh 刷新、bounce 互动、settings 打开设置。',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
    annotations: { title: '控制女仆挂件', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];

function dataHome(env = process.env, platform = process.platform) {
  const stable=path.join(os.homedir(),'.codex-maid-widget');
  return env.CODEX_MAID_HOME || (platform !== 'win32' || fs.existsSync(stable) ? stable : path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codex-maid-widget'));
}

function endpoint() {
  let value;
  try {
    const file = path.join(dataHome(), 'control.json');
    if (fs.statSync(file).size > 16384) throw new Error('invalid');
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('桌面挂件尚未运行。请先打开桌面应用（Windows：start.cmd；macOS：应用或 start.command），再重试。');
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(value.token)) {
    throw new Error('挂件控制信息无效。请退出并重新打开桌面应用。');
  }
  return value;
}

function desktopRequest(route, body) {
  let target;
  try { target = endpoint(); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: target.port, path: route,
      method: encoded ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json',
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}) }
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new Error('挂件返回的状态过大，请重启挂件。')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('挂件连接中断，请重新打开桌面应用。')));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(res.statusCode === 401 ? '挂件认证已更新，请重试；若持续失败请重新启动挂件。' : '挂件暂时无法完成操作，请在桌面挂件中重试。'));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('挂件返回了无效状态，请重启挂件。')); }
      });
    });
    req.setTimeout(body?.action === 'refresh' ? 40000 : 5000, () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new Error('未连接到桌面挂件。请先打开桌面应用，或在托盘/菜单栏恢复挂件后重试。')));
    if (encoded) req.write(encoded);
    req.end();
  });
}

// A future desktop status must not accidentally add credentials to MCP output.
function safeValue(value, depth = 0) {
  if (depth > 16) return null;
  if (Array.isArray(value)) return value.map(item => safeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:token|secret|password|api[_-]?key|authorization|cookie|access_token|refresh_token|controlFile|codexHome|dataHome)$/i.test(key)) continue;
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      // Local names can come from imported filenames or user-entered labels.
      if (key === 'characterName') {
        result[key] = CHARACTER_NAMES.get(value.activeCharacterId) || '自定义形象';
        continue;
      }
      result[key] = safeValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(safeValue(value), null, 2) }], ...(isError ? { isError: true } : {}) });

async function dispatch(message) {
  const validId = message && (typeof message.id === 'string' || Number.isInteger(message.id));
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && !validId)) {
    return { jsonrpc: '2.0', id: validId ? message.id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (!Object.hasOwn(message, 'id')) return null; // Notifications never receive replies.
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return reply({ protocolVersion: supported.includes(requested) ? requested : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'codex-maid-widget', version: require('./.codex-plugin/plugin.json').version },
      instructions: '本机桌面挂件控制器。额度为已观测的本机快照；没有数据时请如实说明，不推算人民币余额。' });
  }
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools: TOOLS });
  if (message.method !== 'tools/call') return fail(-32601, 'Method not found');
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, '工具参数必须是对象。');
  if (name === 'get_widget_status') {
    if (Object.keys(args).length) return fail(-32602, 'get_widget_status 不接受参数。');
    try { return reply(toolResult(await desktopRequest('/status'))); }
    catch (error) { return reply(toolResult(error.message, true)); }
  }
  if (name === 'control_widget') {
    if (!ACTIONS.includes(args.action) || Object.keys(args).some(key => key !== 'action')) return fail(-32602, 'action 必须为 show、hide、refresh、bounce 或 settings。');
    try { return reply(toolResult(await desktopRequest('/action', { action: args.action }))); }
    catch (error) { return reply(toolResult(error.message, true)); }
  }
  return fail(-32602, 'Unknown tool');
}

function runStdio() {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  const send = value => { if (value !== null) process.stdout.write(JSON.stringify(value) + '\n'); };
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_BYTES && !buffer.includes('\n')) { process.stderr.write('MCP input is too large.\n'); process.exit(1); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_BYTES) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); continue; }
      let message;
      try { message = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      dispatch(message).then(send, () => send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'Internal error' } }));
    }
  });
}

if (require.main === module) runStdio();
module.exports = { ACTIONS, TOOLS, dataHome, dispatch, safeValue };
