'use strict';
const fs = require('node:fs');
const path = require('node:path');
function preparePlugin({ root = path.resolve(__dirname, '..'), executable = process.execPath, env = process.env } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12 or newer is required.');
  const plugin = path.join(root, 'plugins', 'codex-maid-widget');
  const server = path.join(plugin, 'mcp.cjs');
  if (!fs.existsSync(server)) throw new Error('Plugin files are missing; extract the complete source bundle.');
  const maid = { command: executable, args: [server] };
  if (env.CODEX_MAID_HOME) maid.env = { CODEX_MAID_HOME: path.resolve(env.CODEX_MAID_HOME) };
  const file = path.join(plugin, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { maid } }, null, 2) + '\n');
  return file;
}
if (require.main === module) console.log('Prepared local MCP configuration: ' + preparePlugin());
module.exports = { preparePlugin };
