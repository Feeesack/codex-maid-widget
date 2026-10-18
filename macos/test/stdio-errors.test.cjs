'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { installOutputErrorHandlers } = require('../scripts/stdio-errors.cjs');
const helper = path.resolve(__dirname, '../scripts/stdio-errors.cjs');

test('both output streams handle only a closed pipe or destroyed stream', () => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const remove = installOutputErrorHandlers([stdout, stderr]);
  for (const output of [stdout, stderr]) {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED']) {
      assert.doesNotThrow(() => output.emit('error', Object.assign(new Error(code), { code })));
    }
    const unexpected = Object.assign(new Error('unexpected stream failure'), { code: 'EIO' });
    assert.throws(() => output.emit('error', unexpected), error => error === unexpected);
  }
  remove();
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stderr.listenerCount('error'), 0);
});

test('duplicated output streams install one removable listener', () => {
  const output = new PassThrough();
  const remove = installOutputErrorHandlers([output, output]);
  assert.equal(output.listenerCount('error'), 1);
  remove();
  assert.equal(output.listenerCount('error'), 0);
});

for (const name of ['stdout', 'stderr']) {
  test(`${name} reader closing does not crash an isolated child process`, { timeout: 10000 }, async () => {
    const source = `
      require(${JSON.stringify(helper)}).installOutputErrorHandlers();
      const output=process[${JSON.stringify(name)}];
      let timer,finished=false;
      output.on('error',error=>{
        if(finished)return;
        finished=true;clearInterval(timer);
        process.send({handled:error.code},()=>setTimeout(()=>process.exit(0),20));
      });
      process.on('message',()=>{timer=setInterval(()=>output.write('logging after reader closed\\n'),10);});
      process.send({ready:true});
    `;
    const child = spawn(process.execPath, ['-e', source], { windowsHide:true, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}, stdio:['ignore','pipe','pipe','ipc'] });
    let handled, stderr='';
    const completed = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({code,signal}));
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if(message.ready) { child[name].destroy();child.send({write:true}); }
      if(message.handled) handled=message.handled;
    });
    const watchdog = setTimeout(() => child.kill(), 7000);
    try {
      assert.deepEqual(await completed,{code:0,signal:null},stderr);
      assert.ok(['EPIPE','ERR_STREAM_DESTROYED'].includes(handled),`a real closed ${name} pipe must raise its expected stream error: ${handled}`);
    } finally { clearTimeout(watchdog);if(child.exitCode===null)child.kill(); }
  });
}

test('an unexpected output error still fails an isolated child process', () => {
  const child = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(helper)}).installOutputErrorHandlers();
    process.stdout.emit('error',Object.assign(new Error('stdio unexpected failure'),{code:'EIO'}));
  `], {windowsHide:true, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}, encoding:'utf8'});
  assert.equal(child.status,1);
  assert.match(child.stderr,/stdio unexpected failure/);
  assert.match(child.stderr,/EIO/);
});
