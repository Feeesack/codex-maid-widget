'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');

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

// Local-only, opt-in overlay. Ordinary portable/installer builds retain the empty
// bundled source bank; an additional local overlay never writes back into source.
function readLocalInteractionOverlay(file, root = path.join(__dirname, '..')) {
  const absolute = path.resolve(file), relative = path.relative(path.join(root, 'tmp'), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isFile()) throw new Error('Private audio must be a reviewed local tmp file');
  const proof = JSON.parse(fs.readFileSync(path.join(path.dirname(absolute), 'PROOF.json'), 'utf8'));
  const bytes = fs.readFileSync(absolute), digest = value => crypto.createHash('sha256').update(value).digest('hex');
  if (proof.localModule?.path !== path.basename(absolute) || proof.localModule.sha256 !== digest(bytes)
    || proof.localModule.presetId !== 'dsh-original' || proof.license?.redistributionAuthorizationObtained !== false
    || proof.license?.assetsCoveredByMit !== false) throw new Error('Private audio review does not match the overlay');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(bytes.toString('utf8'), sandbox, { timeout: 200 });
  const bank = sandbox.module.exports.presets;
  if (!bank || Object.keys(bank).join() !== 'dsh-original' || bank['dsh-original'].gain !== .5) throw new Error('Unexpected private audio presets');
  for (const [role, name] of [['press', 'Ya1.mp3'], ['release', 'Ya2.mp3']]) {
    const entry = proof.files?.find(item => item.file === name && item.activeInLocalModule === true);
    if (!entry || digest(Buffer.from(bank['dsh-original'][role], 'base64')) !== entry.sha256) throw new Error('Private audio bytes differ from the reviewed original');
  }
  return bytes;
}

async function build({ out, localInteractionSamples } = {}) {
  const { packager } = await import('@electron/packager');
  const root = path.join(__dirname,'..');
  const { checkVersions } = require('../distribution/check-versions.cjs');
  const version = checkVersions({ root });
  const localOverlay = localInteractionSamples ? readLocalInteractionOverlay(localInteractionSamples, root) : null;
  if (!fs.existsSync(path.join(root, 'assets', 'maid.png'))) throw new Error('缺少 assets/maid.png 角色素材');
  for (const file of runtimeFiles) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing runtime license or manifest: ${file}`);
  }
  const output = await packager({ dir: root, out: out || path.join(root,'release'), name: 'Codex-Maid-Widget', executableName: 'Codex-Maid-Widget',
    platform: 'win32', arch: 'x64', overwrite: true, asar: true, icon: path.join(root,'assets','app-icon.ico'),
    electronVersion: require('electron/package.json').version,
    // Validate the cached runtime against the pinned npm package's checksums.
    // Avoid an unnecessary online SHASUMS request when the runtime is already present.
    download: { checksums: require('electron/checksums.json') },
    ignore: file => !isRuntimePath(file),
    afterCopy: localOverlay ? [async ({ buildPath }) => {
      fs.writeFileSync(path.join(buildPath, 'src', 'local-interaction-samples.js'), localOverlay);
    }] : [],
    appVersion: version, win32metadata: { ProductName: 'Codex Maid Widget', FileDescription: 'Codex 女仆额度挂件',
      'application-manifest': path.join(root, 'distribution/windows/application.manifest') } });
  const { extractFile } = await import('@electron/asar');
  const archive = path.join(output[0], 'resources', 'app.asar');
  await verifyRuntimeArchive(archive);
  const packed = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (packed.version !== version) throw new Error('打包版本不匹配，禁止启动旧版本');
  const packedLocal = extractFile(archive, 'src/local-interaction-samples.js');
  const expectedLocal = localOverlay || fs.readFileSync(path.join(root, 'src/local-interaction-samples.js'));
  if (!packedLocal.equals(expectedLocal)) throw new Error('Local audio overlay differs from the selected build input');
  console.log('Verified portable app v'+packed.version+': '+output[0]);
}
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build, isRuntimePath, verifyRuntimeArchive, readLocalInteractionOverlay };
