'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Copy only the integration runtime and this platform's original MCP server.
// No user profile, Codex configuration, credentials or installed dependencies
// are read by staging. The Electron executable supplies its own Node runtime.
function stageIntegration({ root, platform, destination, executableRelative } = {}) {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('Unsupported integration platform.');
  if (!root || !destination) throw new Error('root and destination are required.');
  root = path.resolve(root); destination = path.resolve(destination);
  const appRoot = platform === 'darwin' && fs.existsSync(path.join(root, 'macos', 'package.json')) ? path.join(root, 'macos') : root;
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  const original = path.join(appRoot, 'plugins', 'codex-maid-widget');
  for (const file of ['mcp.cjs', '.codex-plugin/plugin.json']) {
    if (!fs.statSync(path.join(original, file)).isFile()) throw new Error('Missing platform plugin: ' + file);
  }
  const relativeExecutable = executableRelative || (platform === 'win32' ? '../../Codex-Maid-Widget.exe' : '../../MacOS/Codex-Maid-Widget');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['connect.cjs', 'connect.ps1', 'connect.vbs', 'connect.command', 'README.txt']) {
    let content = fs.readFileSync(path.join(__dirname, name));
    // Windows PowerShell 5.1 needs a BOM to display the Chinese native dialogs.
    if (name.endsWith('.ps1')) content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]);
    fs.writeFileSync(path.join(destination, name), content);
  }
  fs.chmodSync(path.join(destination, 'connect.command'), 0o755);
  const plugin = path.join(destination, 'plugins', 'codex-maid-widget');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.copyFileSync(path.join(original, 'mcp.cjs'), path.join(plugin, 'mcp.cjs'));
  fs.copyFileSync(path.join(original, '.codex-plugin', 'plugin.json'), path.join(plugin, '.codex-plugin', 'plugin.json'));
  const portableCommand = '${PLUGIN_ROOT}/' + path.relative(plugin, path.resolve(destination, relativeExecutable)).split(path.sep).join('/');
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { maid: {
    command: portableCommand, args: ['${PLUGIN_ROOT}/mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' }
  } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify({ platform, version, executableRelative: relativeExecutable }, null, 2) + '\n');
  return destination;
}
module.exports = { stageIntegration };
