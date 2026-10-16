'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildOptions } = require('../scripts/build-config.cjs');
const { machOArchitectures } = require('../scripts/verify-package.cjs');
const { distributionXml, connectorScript, xmlEscape } = require('../scripts/build-installer.cjs');
const { sourceBundle } = require('../scripts/source-bundle.cjs');
const root = path.resolve(__dirname, '..');

test('universal packaging requires macOS and keeps one app for both CPU families', () => {
  const options = buildOptions({ root, arch: 'universal', hostPlatform: 'darwin' });
  assert.equal(options.arch, 'universal');
  assert.equal(options.osxUniversal.mergeASARs, true);
  assert.equal(options.osxSign.identity, '-');
  assert.throws(() => buildOptions({ arch: 'universal', hostPlatform: 'win32' }), /需要 macOS/);
});
test('Mach-O inspection distinguishes native and fat executables without guessing CPU', () => {
  const native = Buffer.alloc(8); native.writeUInt32LE(0xfeedfacf); native.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(machOArchitectures(native), ['arm64']);
  for (const little of [false, true]) {
    const fat = Buffer.alloc(48);
    fat.writeUInt32BE(little ? 0xbebafeca : 0xcafebabe);
    const write = (value, offset) => little ? fat.writeUInt32LE(value, offset) : fat.writeUInt32BE(value, offset);
    write(2, 4); write(0x01000007, 8); write(0x0100000c, 28);
    assert.deepEqual(machOArchitectures(fat), ['arm64', 'x64']);
    assert.throws(() => machOArchitectures(fat.subarray(0, 28)), /Invalid universal/);
  }
  assert.throws(() => machOArchitectures(Buffer.from('notape!!')), /Expected/);
  assert.throws(() => machOArchitectures(Buffer.alloc(2)), /Truncated/);
});
test('installer declares supported OS, fixed install domain and safe application upgrade', () => {
  const xml = distributionXml(require('../package.json').version);
  assert.match(xml, /hostArchitectures="arm64,x86_64"/);
  assert.match(xml, /os-version min="13\.0"/);
  assert.match(xml, /enable_currentUserHome="false"/);
  assert.match(xml, /<must-close><app id="com\.codexmaid\.widget"/);
  assert.doesNotMatch(xml, /allow-external-scripts="true"|<script>|RequireRestart/);
  assert.equal(xmlEscape('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
});
test('Finder connection launcher uses the installed Electron runtime and explicit install action', () => {
  const script = connectorScript();
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(script, /maid_app='\/Applications\/Codex-Maid-Widget\.app'/);
  assert.match(script, /"\$maid_app\/Contents\/Resources\/integration\/connect\.cjs" --install/);
  assert.doesNotMatch(script, /\b(?:npm|npx|brew)\b/);
});
test('integration is staged outside ASAR before signing with portable runtime paths', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-installer-stage-'));
  try {
    const app = path.join(temporary, 'Contents', 'Resources', 'app'); fs.mkdirSync(app, { recursive: true });
    for (const hook of buildOptions({ root, hostPlatform: 'darwin', arch: 'arm64' }).afterCopy) await hook({ buildPath: app, platform: 'darwin' });
    const integration = path.join(path.dirname(app), 'integration');
    const runtime = JSON.parse(fs.readFileSync(path.join(integration, 'runtime.json'), 'utf8'));
    assert.equal(runtime.platform, 'darwin'); assert.equal(runtime.version, require('../package.json').version);
    assert.equal(runtime.executableRelative, '../../MacOS/Codex-Maid-Widget');
    assert.ok(fs.statSync(path.join(integration, 'plugins', 'codex-maid-widget', 'mcp.cjs')).size > 0);
    assert.match(fs.readFileSync(path.join(integration, 'connect.command'), 'utf8'), /--install/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('Windows cannot accidentally report a real Mac installer as complete', { skip: process.platform === 'darwin' }, () => {
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-installer.cjs')], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /当前主机不能生成或验收 \.pkg/);
});
test('independent Mac source archive includes the installer helper and stages without the Windows project', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-independent-source-'));
  try {
    const source = path.join(temporary, 'source'); fs.mkdirSync(source);
    fs.copyFileSync(path.join(root, 'package.json'), path.join(source, 'package.json'));
    fs.cpSync(path.join(root, 'plugins'), path.join(source, 'plugins'), { recursive: true });
    const local = path.join(root, 'distribution', 'integration');
    fs.cpSync(fs.existsSync(local) ? local : path.join(root, '..', 'distribution', 'integration'), path.join(source, 'distribution', 'integration'), { recursive: true });
    const archive = sourceBundle({ root: source });
    const extracted = path.join(temporary, 'extracted'); fs.mkdirSync(extracted);
    const result = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const standalone = path.join(extracted, fs.readdirSync(extracted)[0]);
    const helper = require(path.join(standalone, 'distribution', 'integration', 'prepare-payload.cjs'));
    const payload = path.join(temporary, 'payload');
    helper.stageIntegration({ root: standalone, platform: 'darwin', destination: payload });
    assert.equal(JSON.parse(fs.readFileSync(path.join(payload, 'runtime.json'))).platform, 'darwin');
    assert.ok(fs.readFileSync(path.join(standalone, 'SOURCE-CONTENTS.sha256'), 'utf8').includes('distribution/integration/connect.cjs'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
