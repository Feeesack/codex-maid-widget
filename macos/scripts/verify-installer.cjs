'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { APP_NAME } = require('./build-config.cjs');
const { verifyPackage } = require('./verify-package.cjs');
async function verifyInstaller({ file, version = require('../package.json').version } = {}) {
  if (process.platform !== 'darwin') throw new Error('Mac 安装包结构、权限和签名验证需要 macOS。');
  const descriptor = fs.openSync(file, 'r'), magic = Buffer.alloc(4);
  try { assert.equal(fs.readSync(descriptor, magic, 0, 4, 0), 4); } finally { fs.closeSync(descriptor); }
  assert.equal(magic.toString('ascii'), 'xar!', 'Not a real flat Apple Installer package');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-installer-verify-'));
  try {
    const expanded = path.join(temporary, 'expanded');
    execFileSync('/usr/sbin/pkgutil', ['--expand-full', path.resolve(file), expanded], { maxBuffer: 10 * 1024 * 1024 });
    const distribution = fs.readFileSync(path.join(expanded, 'Distribution'), 'utf8');
    assert.match(distribution, /hostArchitectures="arm64,x86_64"/);
    assert.match(distribution, /os-version min="13\.0"/);
    const components = fs.readdirSync(expanded).filter(name => name.endsWith('.pkg'));
    assert.equal(components.length, 1, 'Installer must contain one complete offline payload');
    const component = path.join(expanded, components[0]);
    const packageInfo = fs.readFileSync(path.join(component, 'PackageInfo'), 'utf8');
    assert.match(packageInfo, /identifier="com\.codexmaid\.widget\.installer"/);
    assert.match(packageInfo, /install-location="\/"/);
    assert.equal(fs.existsSync(path.join(component, 'Scripts')), false, 'Installer must not run as root against user profiles');
    const applications = path.join(component, 'Payload', 'Applications');
    const entries = fs.readdirSync(applications).sort();
    assert.deepEqual(entries, [`${APP_NAME}-连接 Codex.command`, `${APP_NAME}-断开 Codex.command`, `${APP_NAME}.app`].sort());
    const result = await verifyPackage({ directory: applications, arch: 'universal', version });
    assert.ok(fs.statSync(result.executable).mode & 0o111, 'Installed runtime must retain executable permissions');
    const connector = path.join(applications, `${APP_NAME}-连接 Codex.command`);
    assert.ok(fs.statSync(connector).mode & 0o111, 'Connection launcher must retain executable permissions');
    const disconnector = path.join(applications, `${APP_NAME}-断开 Codex.command`);
    assert.ok(fs.statSync(disconnector).mode & 0o111, 'Disconnection launcher must retain executable permissions');
    assert.match(fs.readFileSync(disconnector, 'utf8'), /connect\.cjs" --remove/);
    for (const launcher of [connector, disconnector]) execFileSync('/bin/sh', ['-n', launcher]);
    for (const file of ['connect.cjs', 'connect.command', 'runtime.json']) assert.ok(fs.statSync(path.join(result.resources, 'integration', file)).isFile(), 'Missing self-contained integration file: ' + file);
    console.log('PASS: real .pkg container, offline payload, universal runtime, executable permissions, framework links, signature and integration resources.');
    return { file, version, architectures: result.architectures };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function main() {
  const { values } = parseArgs({ options: { file: { type: 'string' } } });
  if (!values.file) throw new Error('Usage: node scripts/verify-installer.cjs --file /path/to/installer.pkg');
  await verifyInstaller({ file: values.file });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyInstaller };
