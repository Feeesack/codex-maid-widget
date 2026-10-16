'use strict';
// Run only on a disposable GitHub runner: exercise real launchd registration,
// independent packaged-helper startup and acknowledged removal. The widget's
// profile is isolated; no Codex account or desktop process is needed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { APP_NAME } = require('./build-config.cjs');
const { launchMacWatcher, finalizeMacWatcherRemoval, launchAgentFile, MAC_WATCHER_LABEL } = require('../src/macos-launch.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
async function until(check, label, duration = 20000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(100); }
  throw new Error('Native launchd check timed out: ' + label);
}
async function main() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('This check is limited to a disposable macOS GitHub runner.');
  const { values } = parseArgs({ options: { directory: { type: 'string', default: '/Applications' } } });
  const executable = path.join(path.resolve(values.directory), APP_NAME + '.app', 'Contents', 'MacOS', APP_NAME);
  assert.ok(fs.statSync(executable).isFile());
  const agent = launchAgentFile();
  assert.equal(fs.existsSync(agent), false, 'Preserve any existing user LaunchAgent');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-native-startup-'));
  const settings = path.join(dataDir, 'settings.json');
  const recordFile = path.join(dataDir, 'watcher.json');
  const receiptFile = path.join(dataDir, 'follow-startup.json');
  let registered = false;
  try {
    fs.writeFileSync(settings, JSON.stringify({ sizeBaseline: 2, followCodex: true, sound: false }));
    registered = true;
    await launchMacWatcher({ executable, dataDir, args: ['--watch-codex', '--maid-home=' + dataDir] });
    const record = await until(() => read(recordFile), 'packaged helper ready');
    assert.equal(record.version, require('../package.json').version);
    assert.equal(record.executable, executable);
    assert.equal(record.loginStartupEnabled, true, record.loginStartupError);
    assert.equal(record.loginStartupError, '');
    process.kill(record.pid, 0);
    assert.ok(fs.readFileSync(agent, 'utf8').includes('--maid-home=' + dataDir));
    fs.writeFileSync(settings, JSON.stringify({ sizeBaseline: 2, followCodex: false, sound: false }));
    const requestId = 'native-launchd-removal-' + process.pid;
    await launchMacWatcher({ executable, dataDir, enabled: false, args: ['--watch-codex', '--maid-home=' + dataDir, '--follow-request=' + requestId] });
    const receipt = await until(() => { const value = read(receiptFile); return value?.requestId === requestId && value; }, 'disable receipt');
    assert.equal(receipt.loginStartupEnabled, false);
    assert.equal(receipt.loginStartupError, '');
    await finalizeMacWatcherRemoval({ execFile(file, args, options, done) {
      execFile(file, args, options, (error, stdout, stderr) => {
        // Log only this test's command, exit status and known error category.
        // launchctl print output can include environment data: never log it.
        console.log('launchd removal:', JSON.stringify({ command: args[0], code: error?.code ?? 0,
          signal: error?.signal ?? null, missingService: /could not find (?:specified )?service|service could not be found|no such process/i.test(String(stderr || '')) }));
        done(error, stdout, stderr);
      });
    } });
    assert.equal(fs.existsSync(agent), false);
    await until(() => !fs.existsSync(recordFile), 'helper clean exit');
    registered = false;
    console.log('PASS: real GUI launchd bootstrap, packaged helper, verified login entry, second-instance disable receipt, plist removal and service bootout.');
  } finally {
    // The initial guard established this runner had no pre-existing item. Only
    // remove a plist whose private profile proves it belongs to this test.
    if (registered) {
      let own = false;
      try { own = fs.readFileSync(agent, 'utf8').includes('--maid-home=' + dataDir); } catch {}
      if (own) fs.unlinkSync(agent);
      try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${MAC_WATCHER_LABEL}`], { stdio: 'ignore' }); } catch {}
    }
    const resolved = path.resolve(dataDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('maid-native-startup-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
