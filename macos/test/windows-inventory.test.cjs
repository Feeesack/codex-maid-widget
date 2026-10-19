'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowsInventoryWorker, INVENTORY_WORKER_SCRIPT, MAX_OUTPUT_BYTES } = require('../src/windows-inventory.cjs');
const { CodexDesktopMonitor, desktopRoots } = require('../src/codex-desktop.cjs');

const processEntry = { pid: 200, parentPid: 100, name: 'ChatGPT.exe', path: 'D:\\WindowsApps\\OpenAI.Codex_test__2p2nqsd0c76g0\\app\\ChatGPT.exe', sessionId: 5, officialDesktop: true };
const answer = { known: true, processes: [processEntry] };
function harness(options = {}) {
  const children = [];
  const spawn = (file, args, settings) => {
    assert.equal(file, options.expectedFile || 'powershell.exe');
    for (const flag of ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']) assert.ok(args.includes(flag));
    assert.equal(settings.windowsHide, true);
    assert.deepEqual(settings.stdio, ['pipe', 'pipe', 'ignore']);
    assert.equal(Object.hasOwn(settings, 'shell'), false);
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.writes = []; child.kills = 0; child.ends = 0;
    child.stdin.write = (value, done) => { child.writes.push(value); done?.(); };
    child.stdin.end = () => child.ends++;
    child.kill = () => { child.kills++; child.emit('exit', 0); };
    child.reply = value => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    children.push(child);
    return child;
  };
  const worker = new WindowsInventoryWorker({ spawn, platform: 'win32', env: {}, ...options });
  return { worker, children };
}

test('inventory script uses one native, same-user/session query loop without CIM or account content', () => {
  for (const primitive of ['CreateToolhelp32Snapshot', 'Process32FirstW', 'Process32NextW', 'QueryFullProcessImageNameW', 'ProcessIdToSessionId', 'OpenProcessToken', 'WindowsIdentity', 'ownSid', 'ownSession']) assert.ok(INVENTORY_WORKER_SCRIPT.includes(primitive));
  assert.equal((INVENTORY_WORKER_SCRIPT.match(/Add-Type/g) || []).length, 1);
  assert.match(INVENTORY_WORKER_SCRIPT, /ReadLine\(\)/);
  assert.match(INVENTORY_WORKER_SCRIPT, /GetLastWin32Error\(\) != 18/);
  assert.match(INVENTORY_WORKER_SCRIPT, /catch \{ return Result\(false/);
  assert.match(INVENTORY_WORKER_SCRIPT, /status == 15700\) return null/);
  assert.match(INVENTORY_WORKER_SCRIPT, /status != 0 \|\| family.Length == 0\) throw/);
  assert.doesNotMatch(INVENTORY_WORKER_SCRIPT, /Get-CimInstance|GetOwner|commandline|auth\.json|GetEnvironmentVariable/i);
});

test('sequential requests reuse one hidden worker and simultaneous requests reuse one promise', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  const first = worker.query(), concurrent = worker.query();
  assert.equal(first, concurrent); assert.equal(children.length, 1);
  assert.deepEqual(children[0].writes, ['query\n']);
  children[0].reply(answer); assert.deepEqual(await first, answer);
  const second = worker.query(); children[0].reply({ known: true, processes: [] });
  assert.deepEqual(await second, { known: true, processes: [] });
  assert.equal(children.length, 1); assert.equal(children[0].writes.length, 2);
});

test('an empty Explorer PATH starts Windows PowerShell from the actual system drive', async t => {
  const expectedFile = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const { worker, children } = harness({ expectedFile, env: { SystemRoot: 'D:\\Windows', Path: '' } }); t.after(() => worker.close());
  const pending = worker.query(); children[0].reply(answer); assert.deepEqual(await pending, answer);
});

test('UTF-8 JSON is assembled across chunks without corrupting paths', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  const pending = worker.query();
  const unicode = { known: true, processes: [{ ...processEntry, path: 'C:\\中文\\Codex.exe' }] };
  const buffer = Buffer.from(JSON.stringify(unicode) + '\r\n');
  const split = buffer.indexOf(Buffer.from('中')) + 1;
  children[0].stdout.emit('data', buffer.subarray(0, split));
  children[0].stdout.emit('data', buffer.subarray(split));
  assert.deepEqual(await pending, unicode);
});

test('native unknown inventory stays unknown without restarting a healthy host', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  const pending = worker.query(); children[0].reply({ known: false, processes: [] });
  assert.deepEqual(await pending, { known: false, processes: [], reason: 'inventory-unavailable' });
  const next = worker.query(); children[0].reply(answer); assert.deepEqual(await next, answer);
  assert.equal(children.length, 1); assert.equal(children[0].kills, 0);
});

test('a failed identity lookup interrupts the missing-desktop grace period instead of closing a live desktop', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  let time = 0, missing = 0;
  const monitor = new CodexDesktopMonitor({ now: () => time, graceMs: 5000, onMissing: () => missing++,
    query: async () => { const result = await worker.query(); return result.known ? { known: true, roots: desktopRoots(result.processes, { platform: 'win32' }) } : { known: false, roots: [] }; } });
  const poll = async value => { const pending = monitor.poll(); children[0].reply(value); await pending; };
  await poll(answer);
  time = 1000; await poll({ known: true, processes: [] });
  time = 6000; await poll({ known: false, processes: [] });
  assert.equal(missing, 0); assert.equal(monitor.roots.length, 0);
  time = 10000; await poll({ known: true, processes: [] });
  time = 14999; await poll({ known: true, processes: [] }); assert.equal(missing, 0);
  time = 15000; await poll(answer); assert.equal(missing, 0); assert.equal(monitor.roots[0].officialDesktop, true);
});

test('an explicitly non-Codex package remains a known ignored process', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  const pending = worker.query(); children[0].reply({ known: true, processes: [{ ...processEntry, officialDesktop: false }] });
  const result = await pending;
  assert.equal(result.known, true); assert.deepEqual(desktopRoots(result.processes, { platform: 'win32' }), []);
});

test('exited or errored hosts yield unknown and rebuild only on the next request', async t => {
  for (const event of ['exit', 'error']) {
    const { worker, children } = harness(); t.after(() => worker.close());
    const pending = worker.query(); children[0].emit(event, new Error('private diagnostic'));
    const result = await pending;
    assert.equal(result.known, false); assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(children.length, 1); assert.equal(worker.worker, null);
    const next = worker.query(); assert.equal(children.length, 2);
    children[1].reply(answer); assert.deepEqual(await next, answer);
  }
});

test('spawn and input failures are sanitized and permit a later request', async t => {
  const { worker, children } = harness(); t.after(() => worker.close());
  const original = worker.spawn;
  worker.spawn = () => { throw new Error('private path'); };
  assert.equal((await worker.query()).known, false);
  worker.spawn = original;
  const pending = worker.query(); children[0].stdin.emit('error', new Error('pipe broke'));
  assert.equal((await pending).known, false);
  const next = worker.query(); children[1].reply(answer); assert.deepEqual(await next, answer);
});

test('malformed, oversized or unsolicited output closes only the owned worker', async t => {
  const outputs = [Buffer.from('not JSON\n'), Buffer.from('{"known":true}\n'),
    Buffer.from(JSON.stringify({ known: true, processes: [{ ...processEntry, officialDesktop: undefined }] }) + '\n'),
    Buffer.from(JSON.stringify({ known: true, processes: [{ ...processEntry, officialDesktop: 'true' }] }) + '\n'),
    Buffer.from(JSON.stringify({ known: true, processes: [{ ...processEntry, pid: -1 }] }) + '\n'), Buffer.alloc(MAX_OUTPUT_BYTES + 1, 120)];
  for (const output of outputs) {
    const { worker, children } = harness(); t.after(() => worker.close());
    const pending = worker.query(); children[0].stdout.emit('data', output);
    assert.equal((await pending).known, false);
    assert.equal(children[0].ends, 1); assert.equal(children[0].kills, 1);
    assert.equal(children.length, 1);
  }
  const { worker, children } = harness(); t.after(() => worker.close());
  const pending = worker.query(); children[0].reply(answer); await pending;
  children[0].reply(answer); assert.equal(children[0].kills, 1);
});

test('timeout returns unknown, ends and kills the host, then recovers lazily', async t => {
  const { worker, children } = harness({ timeout: 15 }); t.after(() => worker.close());
  assert.deepEqual(await worker.query(), { known: false, processes: [], reason: 'inventory-unavailable' });
  assert.equal(children.length, 1); assert.equal(children[0].kills, 1); assert.equal(children[0].ends, 1);
  const next = worker.query(); children[1].reply(answer); assert.deepEqual(await next, answer);
});

test('close settles an in-flight request and permanently stops new hosts', async () => {
  const { worker, children } = harness();
  const pending = worker.query(); worker.close(); worker.close();
  assert.equal((await pending).known, false);
  assert.equal(children[0].ends, 1); assert.equal(children[0].kills, 1);
  assert.equal((await worker.query()).known, false); assert.equal(children.length, 1);
});

test('unsupported platforms do not spawn a process', async () => {
  const worker = new WindowsInventoryWorker({ platform: 'linux', spawn: () => { throw new Error('Must not run'); } });
  assert.deepEqual(await worker.query(), { known: false, processes: [], reason: 'unsupported-platform' });
  worker.close();
});
