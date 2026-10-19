'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');
const { displayText, workspaceDisplay } = require('./conversation-display.cjs');

// Inspect JSON structure without deserializing unrelated state or project backing
// identities. Only property names and explicitly selected string fields are decoded.
const white = character => character === ' ' || character === '\n' || character === '\r' || character === '\t';
function spaces(text, position) { while (white(text[position])) position++; return position; }
function stringEnd(text, position) {
  if (text[position] !== '"') throw Error('string');
  for (let index = position + 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32) throw Error('control');
    if (text[index] === '"') return index + 1;
    if (text[index] === '\\') {
      const escape = text[++index];
      if (escape === 'u') {
        if (!/^[\da-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) throw Error('escape');
        index += 4;
      } else if (!'"\\/bfnrt'.includes(escape || '\0')) throw Error('escape');
    }
  }
  throw Error('incomplete');
}
function valueEnd(text, position, depth = 0) {
  if (depth > 64) throw Error('depth');
  position = spaces(text, position);
  if (text[position] === '"') return stringEnd(text, position);
  const opening = text[position];
  if (opening === '{' || opening === '[') {
    const object = opening === '{', closing = object ? '}' : ']';
    position = spaces(text, position + 1);
    if (text[position] === closing) return position + 1;
    while (position < text.length) {
      if (object) {
        position = spaces(text, stringEnd(text, position));
        if (text[position++] !== ':') throw Error('colon');
      }
      position = spaces(text, valueEnd(text, position, depth + 1));
      if (text[position] === closing) return position + 1;
      if (text[position++] !== ',') throw Error('comma');
      position = spaces(text, position);
    }
    throw Error('incomplete');
  }
  const primitive = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  primitive.lastIndex = position;
  if (!primitive.exec(text)) throw Error('value');
  return primitive.lastIndex;
}
function* entries(text, start, end) {
  if (text[start] !== '{') throw Error('object');
  let position = spaces(text, start + 1);
  while (position < end && text[position] !== '}') {
    const keyEnd = stringEnd(text, position);
    const key = keyEnd - position <= 1024 ? JSON.parse(text.slice(position, keyEnd)) : null;
    position = spaces(text, keyEnd);
    if (text[position++] !== ':') throw Error('colon');
    position = spaces(text, position);
    const finish = valueEnd(text, position);
    yield [key, position, finish];
    position = spaces(text, finish);
    if (text[position] === '}') break;
    if (text[position++] !== ',') throw Error('comma');
    position = spaces(text, position);
  }
}
function selectedString(text, start, end, limit = 4096) {
  if (text[start] !== '"' || end - start > limit) return null;
  const value = JSON.parse(text.slice(start, end));
  return typeof value === 'string' && !value.includes('\0') ? value : null;
}
function strings(text, start, end, limit = 65536) {
  if (text[start] !== '[' || end - start > limit) return null;
  const result = [];
  let position = spaces(text, start + 1);
  while (position < end && text[position] !== ']') {
    const finish = valueEnd(text, position), value = selectedString(text, position, finish);
    if (value === null || result.length >= 256) return null;
    result.push(value);
    position = spaces(text, finish);
    if (text[position] === ']') break;
    if (text[position++] !== ',') return null;
    position = spaces(text, position);
  }
  return result;
}
function project(text, start, end, key) {
  if (text[start] !== '{') return null;
  let id = key, name = null, roots = null;
  const seen = new Set();
  for (const [field, begin, finish] of entries(text, start, end)) {
    if (['id', 'name', 'rootPaths'].includes(field)) {
      if (seen.has(field)) throw Error('duplicate');
      seen.add(field);
    }
    if (field === 'id') id = selectedString(text, begin, finish, 1024);
    else if (field === 'name') name = selectedString(text, begin, finish, 4096);
    else if (field === 'rootPaths') roots = strings(text, begin, finish);
  }
  return id === key && displayText(name) && roots ? { id, name: displayText(name), roots } : null;
}
function location(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const flavor = /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
  if (!flavor.isAbsolute(value)) return null;
  const full = flavor.normalize(value), base = flavor.parse(full).root;
  const normalized = full.length > base.length ? full.replace(flavor === path.win32 ? /[\\/]+$/ : /\/+$/, '') : full;
  const canonical = flavor === path.win32 ? normalized.toLowerCase() : normalized;
  return { flavor, normalized, canonical };
}
function contains(root, cwd) {
  if (!root || !cwd || root.flavor !== cwd.flavor) return false;
  const relative = root.flavor.relative(root.canonical, cwd.canonical);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${root.flavor.sep}`) && !root.flavor.isAbsolute(relative);
}
function present(name, root, cwd, source) {
  const detail = root && root.canonical !== cwd.canonical
    ? `${root.normalized} · ${cwd.normalized}` : cwd.normalized;
  return { label: displayText(name), detail: displayText(detail, 2048), source };
}
function projectDisplay(text, cwdValue, threadId) {
  const cwd = location(cwdValue);
  if (!cwd) return null;
  const start = spaces(text, 0), end = valueEnd(text, start);
  if (spaces(text, end) !== text.length || text[start] !== '{') throw Error('document');
  let projects = null, assignments = null, labels = null, projectless = null;
  const seen = new Set();
  for (const [key, begin, finish] of entries(text, start, end)) {
    if (!['local-projects', 'thread-project-assignments', 'electron-workspace-root-labels', 'projectless-thread-ids'].includes(key)) continue;
    if (seen.has(key)) throw Error('duplicate');
    seen.add(key);
    if (key === 'local-projects') projects = [begin, finish];
    else if (key === 'thread-project-assignments') assignments = [begin, finish];
    else if (key === 'projectless-thread-ids') projectless = [begin, finish];
    else labels = [begin, finish];
  }
  if (projectless) {
    const ids = strings(text, ...projectless);
    if (!ids || ids.includes(threadId)) return null;
  }
  let assigned = null, hasAssignment = false;
  if (assignments && typeof threadId === 'string') {
    for (const [id, begin, finish] of entries(text, ...assignments)) if (id === threadId) {
      if (hasAssignment) throw Error('duplicate');
      hasAssignment = true;
      if (text[begin] !== '{') return null;
      let kind = null;
      const fields = new Set();
      for (const [key, from, to] of entries(text, begin, finish)) {
        if (['projectKind', 'projectId'].includes(key)) {
          if (fields.has(key)) throw Error('duplicate');
          fields.add(key);
        }
        if (key === 'projectKind') kind = selectedString(text, from, to, 128);
        else if (key === 'projectId') assigned = selectedString(text, from, to, 1024);
      }
      if (kind !== 'local' || !assigned) return null;
    }
  }
  let best = null, ambiguous = false, assignedDisplay = null;
  const projectIds = new Set();
  if (projects) for (const [id, begin, finish] of entries(text, ...projects)) {
    if (projectIds.has(id)) throw Error('duplicate');
    projectIds.add(id);
    if (hasAssignment && id !== assigned) continue;
    const item = project(text, begin, finish, id);
    if (!item) continue;
    const roots = item.roots.map(location).filter(Boolean);
    if (hasAssignment) {
      const root = roots.filter(root => contains(root, cwd)).sort((left, right) => right.canonical.length - left.canonical.length)[0] || roots[0];
      assignedDisplay = present(item.name, root, cwd, 'project-assignment');
      continue;
    }
    for (const root of roots) if (contains(root, cwd)) {
      if (!best || root.canonical.length > best.root.canonical.length) { best = { item, root }; ambiguous = false; }
      else if (root.canonical.length === best.root.canonical.length && item.id !== best.item.id) ambiguous = true;
    }
  }
  if (hasAssignment) return assignedDisplay;
  if (ambiguous) return null;
  if (best) return present(best.item.name, best.root, cwd, 'project-root');
  if (labels) {
    let legacy = null;
    for (const [key, begin, finish] of entries(text, ...labels)) {
      const root = location(key), name = selectedString(text, begin, finish);
      if (!displayText(name) || !contains(root, cwd)) continue;
      if (!legacy || root.canonical.length > legacy.root.canonical.length) { legacy = { name, root }; ambiguous = false; }
      else if (root.canonical.length === legacy.root.canonical.length) ambiguous = true;
    }
    if (legacy && !ambiguous) return present(legacy.name, legacy.root, cwd, 'legacy-root');
  }
  return null;
}

const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
class ProjectLabels {
  constructor({ codexHome, filesystem = fs, maxBytes = 2 * 1024 * 1024, timeoutMs = 250 } = {}) {
    this.codexHome = typeof codexHome === 'string' ? path.resolve(codexHome) : null;
    this.filesystem = filesystem;
    this.maxBytes = Math.max(0, Math.min(2 * 1024 * 1024, maxBytes));
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.pending = new Map();
  }
  read(cwd, threadId) {
    const fallback = workspaceDisplay(cwd), key = JSON.stringify([cwd, threadId]);
    if (!this.codexHome || !location(cwd)) return Promise.resolve(fallback);
    if (this.pending.has(key)) return this.pending.get(key);
    const request = { active: true, deadline: performance.now() + this.timeoutMs };
    let timer;
    const result = Promise.race([
      this._read(cwd, threadId, key, request).catch(() => fallback),
      new Promise(resolve => { timer = setTimeout(() => { request.active = false; resolve(fallback); }, this.timeoutMs); }),
    ]).finally(() => {
      request.active = false;
      clearTimeout(timer);
      if (this.pending.get(key) === result) this.pending.delete(key);
    });
    this.pending.set(key, result);
    return result;
  }
  async _read(cwd, threadId, key, request) {
    const fallback = workspaceDisplay(cwd), filesystem = this.filesystem;
    const check = () => { if (!request.active || performance.now() >= request.deadline) throw Error('expired'); };
    const home = await filesystem.realpath(this.codexHome); check();
    const filename = path.join(home, '.codex-global-state.json');
    const info = await filesystem.lstat(filename); check();
    if (!info.isFile() || info.isSymbolicLink?.() || info.size > this.maxBytes || info.size < 2) return fallback;
    const actual = await filesystem.realpath(filename); check();
    if (!inside(home, actual)) return fallback;
    const stamp = `${actual}:${signature(info)}`, cached = this.cache.get(key);
    if (cached?.stamp === stamp) { this.cache.delete(key); this.cache.set(key, cached); return { ...cached.value }; }
    const handle = await filesystem.open(actual, 'r');
    let value;
    try {
      check();
      const opened = await handle.stat(); check();
      if (!opened.isFile() || signature(opened) !== signature(info)) return fallback;
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); check();
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) return fallback;
      const after = await handle.stat(); check();
      if (signature(after) !== signature(info)) return fallback;
      value = projectDisplay(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)), cwd, threadId) || fallback;
    } finally { await handle.close(); }
    check();
    const finalInfo = await filesystem.lstat(filename); check();
    const finalPath = await filesystem.realpath(filename); check();
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink?.() || signature(finalInfo) !== signature(info) || finalPath !== actual) return fallback;
    this.cache.delete(key);
    this.cache.set(key, { stamp, value });
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return { ...value };
  }
}

module.exports = { ProjectLabels };
