'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { APP_NAME, BUNDLE_ID, packageDirectory } = require('./build-config.cjs');
const RUNTIME_DIRECTORIES = new Set(['src', 'assets', 'plugins', 'licenses']);
const RUNTIME_FILES = new Set(['package.json', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md']);
function isRuntimePath(file) {
  const relative = String(file).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative) return true;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return RUNTIME_DIRECTORIES.has(parts[0]) || (parts.length === 1 && RUNTIME_FILES.has(parts[0]));
}
async function verifyRuntimeArchive(archive) {
  const { listPackage, statFile } = await import('@electron/asar');
  for (const file of listPackage(archive)) {
    assert.ok(isRuntimePath(file), 'Non-runtime content in application archive: ' + file);
    // ASAR uses the host path separator when resolving a header entry. Normalize
    // its public listing first so this audit also runs on Windows build hosts.
    const relative = file.replaceAll('\\', '/').replace(/^\/+/, '').split('/').join(path.sep);
    assert.equal('link' in statFile(archive, relative, false), false, 'Link in application archive: ' + file);
  }
  for (const file of RUNTIME_FILES) statFile(archive, file, false);
  statFile(archive, ['licenses', 'CC-BY-4.0.txt'].join(path.sep), false);
}
function verifyRuntimeLicenses(resources) {
  const directory = path.join(resources, 'electron-licenses');
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const file = path.join(directory, name);
    assert.ok(fs.existsSync(file), 'Missing bundled runtime license: ' + name);
    assert.ok(fs.lstatSync(file).isFile(), 'Bundled runtime license must be a regular file: ' + name);
  }
  const electron = fs.readFileSync(path.join(directory, 'LICENSE'), 'utf8');
  assert.ok(electron.length > 500 && /Electron contributors/.test(electron), 'Missing Electron copyright and license text');
  const chromium = fs.readFileSync(path.join(directory, 'LICENSES.chromium.html'), 'utf8');
  assert.ok(chromium.length > 1_000_000 && /<!doctype html>/i.test(chromium) && /Chromium software/.test(chromium), 'Missing complete Chromium third-party notices');
}
function packagePaths(directory) {
  const bundle = path.join(directory, `${APP_NAME}.app`);
  return { bundle, executable: path.join(bundle, 'Contents', 'MacOS', APP_NAME), resources: path.join(bundle, 'Contents', 'Resources'), plist: path.join(bundle, 'Contents', 'Info.plist') };
}
function machOArchitectures(header) {
  assert.ok(header.length >= 8, 'Truncated Mach-O header');
  const cpuName = cpu => ({ 0x0100000c: 'arm64', 0x01000007: 'x64' })[cpu] || `cpu-${cpu.toString(16)}`;
  if (header.readUInt32LE(0) === 0xfeedfacf) return [cpuName(header.readUInt32LE(4))];
  const magic = header.readUInt32BE(0);
  assert.ok([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic), 'Expected a 64-bit or universal Mach-O executable');
  const little = [0xbebafeca, 0xbfbafeca].includes(magic);
  const read = offset => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
  const count = read(4), record = [0xcafebabf, 0xbfbafeca].includes(magic) ? 32 : 20;
  assert.ok(count > 0 && count <= 16 && header.length >= 8 + record * count, 'Invalid universal Mach-O architecture table');
  return Array.from({ length: count }, (_, index) => cpuName(read(8 + index * record))).sort();
}
async function verifyPackage({ directory, arch, version = require('../package.json').version, verifySignature = process.platform === 'darwin' } = {}) {
  const files = packagePaths(directory);
  const { extractFile } = await import('@electron/asar');
  const asar = path.join(files.resources, 'app.asar');
  await verifyRuntimeArchive(asar);
  verifyRuntimeLicenses(files.resources);
  const packed = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
  assert.equal(packed.version, version, '打包版本不匹配，禁止启动旧版本'); assert.equal(packed.main, 'src/entry.cjs');
  for (const file of ['src/entry.cjs', 'src/main.cjs', 'src/desktop-watcher.cjs', 'src/codex-data.cjs', 'src/preload.cjs', 'src/settings.html', 'assets/maid.png', 'assets/characters/lilac-dragon.png', 'plugins/codex-maid-widget/mcp.cjs']) assert.ok(extractFile(asar, file).length > 0, 'Missing package file: ' + file);
  assert.ok(fs.statSync(files.executable).isFile(), 'Missing packaged executable');
  const plist = require('plist').parse(fs.readFileSync(files.plist, 'utf8'));
  assert.equal(plist.CFBundleIdentifier, BUNDLE_ID); assert.equal(plist.CFBundleShortVersionString, version);
  assert.equal(plist.LSUIElement, true, 'Widget should stay out of the Dock and app switcher'); assert.equal(plist.LSMinimumSystemVersion, '13.0');
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) assert.equal(Object.hasOwn(plist, key), false, 'Unexpected unused permission: ' + key);
  const icns = fs.readFileSync(path.join(files.resources, plist.CFBundleIconFile));
  assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
  const descriptor = fs.openSync(files.executable, 'r'); const header = Buffer.alloc(1024); let length;
  try { length = fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
  const architectures = machOArchitectures(header.subarray(0, length));
  if (arch === 'universal') assert.deepEqual(architectures, ['arm64', 'x64'], 'Universal installer must support both Mac architectures');
  else assert.ok(architectures.includes(arch), 'Wrong macOS architecture');
  const framework = path.join(files.bundle, 'Contents', 'Frameworks', 'Electron Framework.framework');
  assert.equal(fs.lstatSync(path.join(framework, 'Versions', 'Current')).isSymbolicLink(), true, 'Electron framework symlink must survive packaging');
  assert.ok(fs.statSync(path.join(framework, 'Electron Framework')).isFile(), 'Electron framework link does not resolve');
  if (verifySignature) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', files.bundle], { stdio: 'pipe' });
  return { version: packed.version, arch, architectures, ...files };
}
async function main() {
  const { values } = parseArgs({ options: { arch: { type: 'string', default: process.arch }, directory: { type: 'string' } } });
  const directory = values.directory || packageDirectory(path.resolve(__dirname, '..'), values.arch);
  const result = await verifyPackage({ directory, arch: values.arch });
  console.log(`PASS: macOS/${result.arch} packaged content, metadata and runtime v${result.version}.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { packagePaths, verifyPackage, machOArchitectures, isRuntimePath, verifyRuntimeArchive, verifyRuntimeLicenses };
