'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchThroughExplorer, buildExplorerLaunchScript, quoteWindowsArgument, isFollowStartupEnabled } = require('../src/windows-launch.cjs');

test('named login entry is verified even when Electron cannot match its quoted arguments',()=>{
  const executable='C:\\Program Files\\Maid\\Maid.exe';
  const item={name:'CodexMaidFollow',path:executable,enabled:true,args:[]};
  const actual={openAtLogin:false,executableWillLaunchAtLogin:true,launchItems:[item]};
  assert.equal(isFollowStartupEnabled(actual,executable),true);
  for(const patch of [{enabled:false},{name:'Another app'},{path:'C:\\Other\\Maid.exe'}]) {
    assert.equal(isFollowStartupEnabled({...actual,launchItems:[{...item,...patch}]},executable),false);
  }
  assert.equal(isFollowStartupEnabled({...actual,executableWillLaunchAtLogin:false},executable),false);
  assert.equal(isFollowStartupEnabled({...actual,launchItems:[]},executable),false);
});

function scriptPayload(script) {
  const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

test('Windows arguments preserve empty strings, spaces, Unicode, quotes and trailing backslashes', () => {
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('--watch-codex'), '"--watch-codex"');
  assert.equal(quoteWindowsArgument('女仆 folder'), '"女仆 folder"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('C:\\folder name\\'), '"C:\\folder name\\\\"');
  assert.equal(quoteWindowsArgument('before\\"after'), '"before\\\\\\"after"');
});

test('launch script delegates to the existing Explorer desktop and transports source-like values only as base64 JSON', () => {
  const executable = 'C:\\女仆\' $() ` ;\\Codex Maid.exe';
  const cwd = 'C:\\桌面\' $(Get-Item .)';
  const args = ['--watch-codex', 'hello "quoted" world', '', "'; throw 'injected'; #", '中文\\'];
  const script = buildExplorerLaunchScript({ executable, cwd, args });
  const payload = scriptPayload(script);
  assert.deepEqual(payload, { executable, cwd, argLine: args.map(quoteWindowsArgument).join(' ') });
  assert.equal(script.includes(executable), false);
  assert.equal(script.includes(args[3]), false);
  assert.match(script, /New-Object -ComObject Shell\.Application/);
  assert.match(script, /\$shell\.Windows\(\)\.FindWindowSW\(0, 0, 8, \[ref\]\$desktopHwnd, 1\)/);
  assert.match(script, /\$desktop\.Document\.Application\.ShellExecute/);
  assert.doesNotMatch(script, /\$shell\.ShellExecute|Invoke-Expression|Start-Process/);
});

test('Explorer launch rejects NUL and invalid parameter shapes before running PowerShell', async () => {
  let calls = 0;
  const base = { executable: 'C:\\Maid\\widget.exe', execFile: () => { calls++; } };
  for (const patch of [{ executable: 'bad\0.exe' }, { executable: '' }, { cwd: 'bad\0' }, { args: ['bad\0'] }, { args: [42] }, { args: 'string' }]) {
    await assert.rejects(launchThroughExplorer({ ...base, ...patch }), TypeError);
  }
  assert.throws(() => quoteWindowsArgument('bad\0'), TypeError);
  assert.equal(calls, 0);
});

test('Explorer dispatch uses a hidden noninteractive STA PowerShell process without a shell', async () => {
  const executable = 'C:\\Program Files\\女仆\\widget.exe';
  const cwd = 'C:\\Program Files\\女仆';
  const args = ['--watch-codex'];
  const result = await launchThroughExplorer({ executable, cwd, args, timeout: 1234,
    execFile: (file, commandArgs, options, done) => {
      assert.equal(file, 'powershell.exe');
      for (const flag of ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']) assert.ok(commandArgs.includes(flag));
      const script = Buffer.from(commandArgs[commandArgs.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      assert.deepEqual(scriptPayload(script), { executable, cwd, argLine: '"--watch-codex"' });
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 1234);
      assert.equal(options.encoding, 'utf8');
      assert.equal(Object.hasOwn(options, 'shell'), false);
      done(null, '\uFEFF{"launched":true}\r\n');
    } });
  assert.deepEqual(result, { launched: true });
});

test('failed, empty or malformed Explorer responses reject without exposing PowerShell details', async () => {
  const privateDetail = 'private execution detail C:\\secret\\profile';
  for (const fixture of [
    { error: new Error(privateDetail), stdout: '' },
    { stdout: '' }, { stdout: 'not-json' }, { stdout: '{}' }, { stdout: '{"launched":false}' }, { stdout: privateDetail },
  ]) {
    await assert.rejects(launchThroughExplorer({ executable: 'C:\\Maid\\widget.exe',
      execFile: (_file, _args, _options, done) => done(fixture.error || null, fixture.stdout) }), error => {
      assert.equal(error.message, '无法通过 Windows 桌面启动助手。');
      assert.equal(error.message.includes(privateDetail), false);
      return true;
    });
  }
  await assert.rejects(launchThroughExplorer({ executable: 'C:\\Maid\\widget.exe', execFile: () => { throw new Error(privateDetail); } }),
    { message: '无法通过 Windows 桌面启动助手。' });
});
