'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

for (const variant of ['..','../macos']) {
  const { runtimeEnvironmentArguments, applyRuntimeEnvironmentArguments } = require(variant+'/src/runtime-environment.cjs');
  const { powershellExecutable } = require(variant+'/src/windows-system.cjs');
  const { launchThroughExplorer, quoteWindowsArgument } = require(variant+'/src/windows-launch.cjs');
  test(`${variant}: Explorer/login handoff preserves explicit Codex paths without exporting other environment`, async () => {
    const env = { CODEX_HOME:path.resolve('fixture-home','用户 profile'), CODEX_MAID_CODEX_PATH:path.resolve('fixture-cli','tool with spaces.exe'),
      PATH:'fixture path must not be serialized', OPENAI_API_KEY:'fixture secret must not be serialized', unrelated:'fixture value must not be serialized', SystemRoot:'Z:\\Windows' };
    const args = runtimeEnvironmentArguments(['--watch-codex','--maid-home=fixture-maid'],env);
    assert.equal(args.length,4); assert.equal(args[2],'--codex-home='+env.CODEX_HOME); assert.equal(args[3],'--codex-cli='+env.CODEX_MAID_CODEX_PATH);
    const after = { CODEX_HOME:'stale Explorer home', CODEX_MAID_CODEX_PATH:'stale launcher CLI' };
    applyRuntimeEnvironmentArguments(args,after);
    assert.equal(after.CODEX_HOME,env.CODEX_HOME); assert.equal(after.CODEX_MAID_CODEX_PATH,env.CODEX_MAID_CODEX_PATH);
    await launchThroughExplorer({executable:'Z:\\应用 folder\\Maid.exe',cwd:'Z:\\应用 folder',args:['--watch-codex'],env,
      execFile(file, argv, options, done) {
        assert.equal(file,'Z:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        const script=Buffer.from(argv.at(-1),'base64').toString('utf16le');
        const payload=JSON.parse(Buffer.from(script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1],'base64').toString('utf8'));
        assert.equal(payload.argLine,runtimeEnvironmentArguments(['--watch-codex'],env).map(quoteWindowsArgument).join(' '));
        for (const denied of [env.PATH,env.OPENAI_API_KEY,env.unrelated]) assert.equal(JSON.stringify(payload).includes(denied),false);
        assert.equal(options.windowsHide,true); done(null,'{"launched":true}');
      }});
  });
  test(`${variant}: path overrides are anchored before cwd changes and invalid overrides fail before launching`, async () => {
    const args=runtimeEnvironmentArguments([], {CODEX_HOME:'relative profile',CODEX_MAID_CODEX_PATH:'relative-cli/tool.exe'});
    assert.deepEqual(args,['--codex-home='+path.resolve('relative profile'),'--codex-cli='+path.resolve('relative-cli/tool.exe')]);
    assert.deepEqual(runtimeEnvironmentArguments([], {CODEX_MAID_CODEX_PATH:'codex'}),['--codex-cli=codex']);
    assert.deepEqual(runtimeEnvironmentArguments(['--codex-home=explicit'],{CODEX_HOME:'other'}),['--codex-home=explicit']);
    assert.deepEqual(runtimeEnvironmentArguments([],{codex_home:'relative profile'},'win32'),['--codex-home='+path.resolve('relative profile')]);
    assert.deepEqual(runtimeEnvironmentArguments([],{codex_home:'relative profile'},'darwin'),[]);
    for(const value of ['bad\0path','bad\npath','bad\rpath',42]){
      assert.throws(()=>runtimeEnvironmentArguments([],{CODEX_HOME:value}),TypeError);
      if(typeof value==='string')assert.throws(()=>applyRuntimeEnvironmentArguments(['--codex-home='+value],{}),TypeError);
    }
    assert.equal(powershellExecutable({systemroot:'E:\\Windows',PATH:''}),'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(powershellExecutable({windir:'F:\\系统',Path:''}),'F:\\系统\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(powershellExecutable({SystemRoot:'relative'}),'powershell.exe');
    assert.equal(powershellExecutable({}),'powershell.exe');
  });
  test(`${variant}: Windows login registration carries the same profile overrides`, () => {
    const { syncFollowStartup } = require(variant+'/src/desktop-watcher.cjs');
    let written;
    const env={CODEX_HOME:path.resolve('fixture-profile'),CODEX_MAID_CODEX_PATH:path.resolve('fixture-cli.exe')};
    const executable='Z:\\Apps\\Maid.exe';
    const app={setLoginItemSettings(value){if(value.name)written=value;},getLoginItemSettings(){return {executableWillLaunchAtLogin:true,launchItems:[{name:'CodexMaidFollow',enabled:true,path:executable}]};}};
    const answer=syncFollowStartup({app,enabled:true,executable,dataDir:path.resolve('fixture-data'),packaged:true,platform:'win32',env});
    assert.equal(answer.loginStartupEnabled,true);
    assert.deepEqual(written.args,runtimeEnvironmentArguments(['--watch-codex','--maid-home='+path.resolve('fixture-data')],env));
  });
  test(`${variant}: entry applies overrides before any data directory or account reader is loaded`, () => {
    const entry=fs.readFileSync(path.join(__dirname,variant,'src/entry.cjs'),'utf8');
    assert.ok(entry.indexOf('applyRuntimeEnvironmentArguments(process.argv)')<entry.indexOf('prepareDataHome({'));
  });
}
