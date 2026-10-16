'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
function sourceBundle({ root = path.resolve(__dirname, '..') } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const prefix = `codex-maid-widget-macos-${version}-source`;
  const outputDir = path.join(root, 'release', version);
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, prefix + '.tar.gz');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-source-bundle-'));
  const stage = path.join(temporary, prefix); fs.mkdirSync(stage);
  try {
    // Explicit source allowlist excludes profiles, installed dependencies, Git,
    // build output, authentication files, and unrelated workspace material.
    for (const item of ['src', 'assets', 'scripts', 'test', 'plugins', 'docs', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md', 'licenses', 'start.command', 'install-plugin.command', '.gitignore']) {
      const source = path.join(root, item);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(stage, item), { recursive: true, filter: file => !/(?:^|[\\/])(?:chat_backup|coordination|\.DS_Store)(?:[\\/]|$)/.test(file) });
    }
    // Installer builds also work from the independent Mac source archive.
    const localIntegration = path.join(root, 'distribution', 'integration');
    const integration = fs.existsSync(localIntegration) ? localIntegration : path.resolve(root, '..', 'distribution', 'integration');
    if (!fs.existsSync(path.join(integration, 'prepare-payload.cjs'))) throw new Error('Missing self-contained installer integration sources.');
    fs.cpSync(integration, path.join(stage, 'distribution', 'integration'), { recursive: true });
    const marketplace = path.join(root, '.agents', 'plugins', 'marketplace.json');
    if (fs.existsSync(marketplace)) { fs.mkdirSync(path.join(stage, '.agents', 'plugins'), { recursive: true }); fs.copyFileSync(marketplace, path.join(stage, '.agents', 'plugins', 'marketplace.json')); }
    // A locally prepared MCP manifest contains machine paths. Ship the portable
    // manifest; installation on the target Mac resolves its own absolute paths.
    fs.writeFileSync(path.join(stage, 'plugins', 'codex-maid-widget', '.mcp.json'), JSON.stringify({ mcpServers: { maid: { command: 'node', args: ['${PLUGIN_ROOT}/mcp.cjs'] } } }, null, 2) + '\n');
    const hashes = [];
    function collect(directory) {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name); const info = fs.lstatSync(file);
        if (info.isSymbolicLink()) throw new Error('Source bundle refuses unexpected symlink: ' + file);
        if (info.isDirectory()) collect(file);
        else hashes.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + path.relative(stage, file).split(path.sep).join('/'));
      }
    }
    collect(stage); fs.writeFileSync(path.join(stage, 'SOURCE-CONTENTS.sha256'), hashes.join('\n') + '\n');
    execFileSync('tar', ['-czf', output, '-C', temporary, prefix], { stdio: 'pipe' });
    const checksum = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    fs.writeFileSync(output + '.sha256', checksum + '  ' + path.basename(output) + '\n');
    console.log('Created macOS source bundle: ' + output + '\nSHA256: ' + checksum);
    return output;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) { try { sourceBundle(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { sourceBundle };
