'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const variant of ['..', '../macos']) {
  const { resolveRuntimeExecutable } = require(variant + '/src/chat-runtime.cjs');
  function fixture({desktop = true, explicit} = {}) {
    const old = 'R:\\旧工具 空格\\codex.exe', current = 'T:\\应用 中文\\resources\\codex.exe';
    const desktopRoot = 'T:\\应用 中文\\Codex.exe';
    const files = new Set([old, current]); let reads = 0, discoveries = 0;
    const fileSystem = {
      statSync(file) { return {isFile: () => files.has(path.win32.normalize(file))}; },
      readFileSync() { reads++; throw Error('This discovery fixture forbids profile reads'); },
    };
    const options = {platform:'win32',env:{Path:path.win32.dirname(old),LOCALAPPDATA:'S:\\隔离 Profile'},fileSystem,
      codexPath:explicit,queryDesktop:async()=>{discoveries++;return {known:true,roots:desktop?[{officialDesktop:true,path:desktopRoot}]:[]};}};
    return {old,current,options,get reads(){return reads;},get discoveries(){return discoveries;}};
  }
  test(variant + ': chat follows the verified desktop CLI even when Explorer PATH has an older CLI', async () => {
    const h = fixture();
    assert.equal(await resolveRuntimeExecutable(h.options), h.current);
    assert.equal(h.discoveries, 1); assert.equal(h.reads, 0);
  });
  test(variant + ': unavailable desktop discovery falls back to PATH without a drive scan', async () => {
    const h = fixture({desktop:false});
    assert.equal(await resolveRuntimeExecutable(h.options), h.old);
    assert.equal(h.discoveries, 1); assert.equal(h.reads, 0);
  });
  test(variant + ': explicit executable and environment overrides retain precedence', async () => {
    const h = fixture({explicit:'U:\\自定义 Codex\\codex.exe'});
    assert.equal(await resolveRuntimeExecutable(h.options), h.options.codexPath);
    assert.equal(h.discoveries, 0);
    const env = fixture(); env.options.env.CODEX_MAID_CODEX_PATH = 'V:\\指定CLI\\codex.exe';
    assert.equal(await resolveRuntimeExecutable(env.options), env.options.env.CODEX_MAID_CODEX_PATH);
    assert.equal(env.discoveries, 0); assert.equal(env.reads, 0);
  });
  test(variant + ': macOS discovery uses the verified application bundle on a custom volume', async () => {
    const desktop = '/Volumes/非默认 应用/Codex.app', current = desktop + '/Contents/Resources/codex', old = '/opt/旧 工具/codex';
    const files = new Set([current,old]);
    const fileSystem = {statSync:file=>({isFile:()=>files.has(file)}),accessSync(file){assert.ok(files.has(file));},readFileSync(){throw Error('No profile reads allowed');}};
    const options = {platform:'darwin',uid:501,env:{PATH:path.posix.dirname(old)},fileSystem,
      queryDesktop:async()=>({known:true,roots:[{bundleId:'com.openai.codex',bundleExecutable:'Codex',uid:501,path:desktop+'/Contents/MacOS/Codex'}]})};
    assert.equal(await resolveRuntimeExecutable(options), current);
    options.queryDesktop = async()=>({known:true,roots:[{bundleId:'unverified.other',bundleExecutable:'Codex',uid:501,path:desktop+'/Contents/MacOS/Codex'}]});
    assert.equal(await resolveRuntimeExecutable(options), old);
  });
}
