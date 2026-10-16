'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ICON_TYPES, createIcns } = require('../scripts/mac-icon.cjs');
const { APP_NAME, BUNDLE_ID, IGNORE, buildOptions, packageDirectory, stripUnusedMacPermissions, retainMacRuntimeLicenses } = require('../scripts/build-config.cjs');
const { packagePaths } = require('../scripts/verify-package.cjs');
const { preparePlugin } = require('../scripts/prepare-plugin.cjs');
const root = path.resolve(__dirname, '..');

test('Mac ICNS retains every approved PNG verbatim, including the 512px image', () => {
  const entries = [...ICON_TYPES.keys()].map(size => ({ size, png: fs.readFileSync(path.join(root, 'assets', 'icons', `app-${size}.png`)) }));
  const icon = createIcns(entries);
  assert.equal(icon.toString('ascii', 0, 4), 'icns'); assert.equal(icon.readUInt32BE(4), icon.length);
  let offset = 8;
  for (const { size, png } of entries) {
    assert.equal(icon.toString('ascii', offset, offset + 4), ICON_TYPES.get(size));
    const length = icon.readUInt32BE(offset + 4); assert.equal(length, png.length + 8);
    assert.deepEqual(icon.subarray(offset + 8, offset + length), png); offset += length;
  }
  assert.equal(offset, icon.length);
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets', 'app-icon.icns')), icon);
});
test('ICNS refuses corrupt or incorrectly sized raster entries', () => {
  assert.throws(() => createIcns([{ size: 16, png: Buffer.from('bad') }]), /Invalid PNG/);
  const png = fs.readFileSync(path.join(root, 'assets', 'icons', 'app-32.png'));
  assert.throws(() => createIcns([{ size: 16, png }]), /Invalid ICNS PNG size/);
});
test('both Mac architectures build with pinned Electron and separate versioned output', () => {
  for (const arch of ['arm64', 'x64']) {
    const options = buildOptions({ root, arch, hostPlatform: 'darwin' });
    assert.equal(options.platform, 'darwin'); assert.equal(options.arch, arch);
    assert.equal(options.appBundleId, BUNDLE_ID); assert.equal(options.extendInfo.LSUIElement, true);
    assert.equal(options.extendInfo.LSMinimumSystemVersion, '13.0');
    assert.equal(options.electronVersion, require('electron/package.json').version);
    assert.equal(options.download.checksums[`electron-v${options.electronVersion}-darwin-${arch}.zip`].length, 64);
    assert.equal(options.osxSign.identity, '-'); assert.equal(options.osxSign.identityValidation, false);
    assert.equal(options.osxSign.continueOnError, false); assert.equal(options.osxSign.optionsForFile().hardenedRuntime, false);
    assert.ok(packageDirectory(root, arch).endsWith(`${APP_NAME}-darwin-${arch}`));
    assert.equal(options.win32metadata, undefined);
  }
  assert.throws(() => buildOptions({ arch: 'ia32' }), /不支持/);
  assert.equal(buildOptions({ arch: 'arm64', hostPlatform: 'win32' }).osxSign, undefined);
});
test('packaged .app paths and privacy exclusion cover platform layout and machine state', () => {
  const files = packagePaths(path.join('release', 'darwin-arm64'));
  assert.equal(files.resources, path.join('release', 'darwin-arm64', `${APP_NAME}.app`, 'Contents', 'Resources'));
  for (const file of ['/release/app', '/tmp/data', '/.git/config', '/.env', '/.env.local', '/auth.json', '/settings.json', '/control.json', '/userData/settings.json', '/node_modules/electron', '/README.md', '/README.zh-CN.md', '/scripts/build.cjs', '/package-lock.json', '/distribution/DELIVERY-VERIFICATION.json']) assert.equal(IGNORE.some(pattern => pattern.test(file)), true, file);
  for (const file of ['/package.json', '/src/main.cjs', '/assets/characters/lilac-dragon.png', '/plugins/codex-maid-widget/mcp.cjs', '/LICENSE', '/NOTICE', '/ARTWORK_LICENSE.md', '/licenses/CC-BY-4.0.txt']) assert.equal(IGNORE.some(pattern => pattern.test(file)), false, file);
});
test('unused camera and microphone declarations are removed from main and helper plists', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-plist-test-'));
  const plist = require('plist');
  try {
    const main = path.join(directory, 'Electron.app', 'Contents', 'Info.plist');
    const helper = path.join(directory, 'Electron.app', 'Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'Info.plist');
    for (const file of [main, helper]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, plist.build({ CFBundleName: 'preserved', NSCameraUsageDescription: 'camera', NSMicrophoneUsageDescription: 'microphone' })); }
    await stripUnusedMacPermissions({ buildPath: directory, platform: 'darwin' });
    for (const file of [main, helper]) assert.deepEqual(plist.parse(fs.readFileSync(file, 'utf8')), { CFBundleName: 'preserved' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Mac packaging retains the exact Electron and Chromium notices from the verified runtime', () => {
  const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-runtime-notices-'));
  try {
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) fs.writeFileSync(path.join(buildPath, name), 'Official notice: ' + name);
    retainMacRuntimeLicenses({ buildPath, platform: 'darwin' });
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
      assert.deepEqual(fs.readFileSync(path.join(buildPath, 'Electron.app/Contents/Resources/electron-licenses', name)), fs.readFileSync(path.join(buildPath, name)));
    }
    fs.unlinkSync(path.join(buildPath, 'LICENSE'));
    assert.throws(() => retainMacRuntimeLicenses({ buildPath, platform: 'darwin' }), /ENOENT/);
  } finally { fs.rmSync(buildPath, { recursive: true, force: true }); }
});

test('plugin preparation affects only the supplied project manifest and carries explicit profile', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-plugin-prepare-test-'));
  try {
    const plugin = path.join(directory, 'plugins', 'codex-maid-widget'); fs.mkdirSync(plugin, { recursive: true }); fs.writeFileSync(path.join(plugin, 'mcp.cjs'), '');
    const profile = path.join(directory, 'isolated-profile');
    const file = preparePlugin({ root: directory, env: { CODEX_MAID_HOME: profile } });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { maid: { command: process.execPath, args: [path.join(plugin, 'mcp.cjs')], env: { CODEX_MAID_HOME: profile } } } });
    assert.deepEqual(fs.readdirSync(directory), ['plugins']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
