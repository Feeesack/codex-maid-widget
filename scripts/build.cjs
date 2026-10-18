'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Explicit runtime boundary: source releases can contain documentation, tests
// and build tools, but none of those belong inside an installed application.
const runtimeDirectories = new Set(['src', 'assets', 'plugins', 'licenses']);
const runtimeFiles = new Set(['package.json', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md']);
function isRuntimePath(file) {
  const relative = String(file).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative) return true;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return runtimeDirectories.has(parts[0]) || (parts.length === 1 && runtimeFiles.has(parts[0]));
}
async function verifyRuntimeArchive(archive) {
  const { listPackage, statFile } = await import('@electron/asar');
  for (const file of listPackage(archive)) {
    const relative = file.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!isRuntimePath(file) || 'link' in statFile(archive, relative.split('/').join(path.sep), false)) {
      throw new Error(`Non-runtime content in application archive: ${file}`);
    }
  }
  for (const file of runtimeFiles) statFile(archive, file);
}

async function build() {
  const { packager } = await import('@electron/packager');
  const root = path.join(__dirname,'..');
  const { checkVersions } = require('../distribution/check-versions.cjs');
  const version = checkVersions({ root });
  if (!fs.existsSync(path.join(root, 'assets', 'maid.png'))) throw new Error('缺少 assets/maid.png 角色素材');
  for (const file of runtimeFiles) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing runtime license or manifest: ${file}`);
  }
  const output = await packager({ dir: root, out: path.join(root,'release'), name: 'Codex-Maid-Widget', executableName: 'Codex-Maid-Widget',
    platform: 'win32', arch: 'x64', overwrite: true, asar: true, icon: path.join(root,'assets','app-icon.ico'),
    electronVersion: require('electron/package.json').version,
    // Validate the cached runtime against the pinned npm package's checksums.
    // Avoid an unnecessary online SHASUMS request when the runtime is already present.
    download: { checksums: require('electron/checksums.json') },
    ignore: file => !isRuntimePath(file),
    appVersion: version, win32metadata: { ProductName: 'Codex Maid Widget', FileDescription: 'Codex 女仆额度挂件',
      'application-manifest': path.join(root, 'distribution/windows/application.manifest') } });
  const { extractFile } = await import('@electron/asar');
  const archive = path.join(output[0], 'resources', 'app.asar');
  await verifyRuntimeArchive(archive);
  const packed = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (packed.version !== version) throw new Error('打包版本不匹配，禁止启动旧版本');
  console.log('Verified portable app v'+packed.version+': '+output[0]);
}
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build, isRuntimePath, verifyRuntimeArchive };
