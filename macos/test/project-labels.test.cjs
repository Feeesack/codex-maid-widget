'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const variants = ['src'];
if (syncFs.existsSync(path.resolve(__dirname, '../macos/src/project-labels.cjs'))) variants.push('macos/src');
for (const variant of variants) {
  const filename = path.resolve(__dirname, '..', variant, 'project-labels.cjs');
  const { ProjectLabels } = require(filename);
  const setup = async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-project-labels-'));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
      assert.match(path.basename(home), /^maid-project-labels-/);
      await fs.rm(home, { recursive: true, force: true });
    });
    const state = path.join(home, '.codex-global-state.json');
    return { home, state, save: value => fs.writeFile(state, JSON.stringify(value)) };
  };
  const projects = {
    alpha: { id: 'alpha', name: '自定义项目', rootPaths: ['/work/source'], privateBacking: { accountId: 'DO_NOT_PARSE_IDENTITY' } },
  };
  test(`${variant}: construction and idle perform no I/O`, async () => {
    let count = 0;
    new ProjectLabels({ codexHome: '/isolated', filesystem: new Proxy({}, { get() { count++; throw Error('I/O'); } }) });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count, 0);
  });
  test(`${variant}: exact assignment names worktrees and sanitizes output`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects, 'thread-project-assignments': { chosen: { projectKind: 'local', projectId: 'alpha' } } });
    const reader = new ProjectLabels({ codexHome: fixture.home });
    const value = await reader.read('/work/worktree', 'chosen');
    assert.equal(value.label, '自定义项目');
    assert.equal(value.source, 'project-assignment');
    assert.match(value.detail, /source.*worktree/);
  });
  test(`${variant}: longest unique ancestor wins and siblings do not match`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': { ...projects, deep: { id: 'deep', name: '子项目', rootPaths: ['/work/source/deep'] } } });
    const reader = new ProjectLabels({ codexHome: fixture.home });
    assert.equal((await reader.read('/work/source/deep/src', 'chosen')).label, '子项目');
    assert.deepEqual(await reader.read('/work/source-neighbor', 'chosen'), { label: 'source-neighbor', detail: '/work/source-neighbor' });
  });
  test(`${variant}: conflicting projects with same name and root fall back`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': { alpha: projects.alpha, beta: { id: 'beta', name: '自定义项目', rootPaths: ['/work/source/'] } } });
    assert.equal((await new ProjectLabels({ codexHome: fixture.home }).read('/work/source/src', 'chosen')).source, undefined);
  });
  test(`${variant}: assignment to missing or remote project never guesses by cwd`, async t => {
    const fixture = await setup(t);
    const reader = new ProjectLabels({ codexHome: fixture.home });
    for (const assignment of [{ projectKind: 'local', projectId: 'missing' }, { projectKind: 'remote', projectId: 'alpha' }]) {
      await fixture.save({ 'local-projects': projects, 'thread-project-assignments': { chosen: assignment } });
      assert.equal((await reader.read('/work/source', 'chosen')).label, 'source');
    }
  });
  test(`${variant}: projectless marker and malformed project fields fall back`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects, 'projectless-thread-ids': ['chosen'] });
    assert.equal((await new ProjectLabels({ codexHome: fixture.home }).read('/work/source', 'chosen')).label, 'source');
    await fixture.save({ 'local-projects': projects, 'projectless-thread-ids': { malformed: true } });
    assert.equal((await new ProjectLabels({ codexHome: fixture.home }).read('/work/source', 'chosen')).label, 'source');
    await fixture.save({ 'local-projects': { alpha: { id: 'wrong', name: 'invalid', rootPaths: ['/work/source'] } } });
    assert.equal((await new ProjectLabels({ codexHome: fixture.home }).read('/work/source', 'chosen')).label, 'source');
  });
  test(`${variant}: Windows paths are case insensitive and preserve worktree detail`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': { one: { id: 'one', name: 'Windows Project', rootPaths: ['D:\\Work\\Project'] } } });
    const reader = new ProjectLabels({ codexHome: fixture.home });
    assert.equal((await reader.read('d:\\work\\project\\src', 'chosen')).label, 'Windows Project');
    assert.equal((await reader.read('D:\\Work\\ProjectOther', 'chosen')).label, 'ProjectOther');
  });
  test(`${variant}: old labels and escaped JSON keys work`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'electron-workspace-root-labels': { '/work/source': '旧名称\u202e\n' } });
    const value = await new ProjectLabels({ codexHome: fixture.home }).read('/work/source/lib', 'chosen');
    assert.equal(value.label, '旧名称');
    assert.equal(value.source, 'legacy-root');
  });
  test(`${variant}: cache follows rename and never stores raw state`, async t => {
    const fixture = await setup(t);
    let opens = 0;
    const filesystem = { ...fs, open: async (...args) => { opens++; return fs.open(...args); } };
    const reader = new ProjectLabels({ codexHome: fixture.home, filesystem });
    await fixture.save({ 'local-projects': projects });
    assert.equal((await reader.read('/work/source', 'chosen')).label, '自定义项目');
    assert.equal((await reader.read('/work/source', 'chosen')).label, '自定义项目');
    assert.equal(opens, 1);
    await fixture.save({ 'local-projects': { alpha: { ...projects.alpha, name: '改后的项目名称' } } });
    assert.equal((await reader.read('/work/source', 'chosen')).label, '改后的项目名称');
    assert.equal(opens, 2);
    assert.ok(!JSON.stringify([...reader.cache]).includes('DO_NOT_PARSE_IDENTITY'));
    for (let index = 0; index < 12; index++) await reader.read(`/isolated/${index}`, `thread-${index}`);
    assert.ok(reader.cache.size <= 8);
  });
  test(`${variant}: parser only decodes approved strings, never identities or whole objects`, async t => {
    const fixture = await setup(t);
    await fixture.save({ privateState: { message: 'DO_NOT_PARSE_CHAT', accountId: 'DO_NOT_PARSE_IDENTITY' }, 'local-projects': projects,
      'thread-project-assignments': { other: { private: 'DO_NOT_PARSE_CHAT' }, chosen: { projectKind: 'local', projectId: 'alpha', pendingCoreUpdate: { private: 'DO_NOT_PARSE_CHAT' } } } });
    const parse = [];
    const module = { exports: {} };
    vm.runInNewContext(syncFs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: createRequire(filename), Buffer, setTimeout, clearTimeout,
      JSON: { stringify: JSON.stringify, parse: value => { parse.push(value); return JSON.parse(value); } } });
    const reader = new module.exports.ProjectLabels({ codexHome: fixture.home });
    assert.equal((await reader.read('/work/worktree', 'chosen')).label, '自定义项目');
    assert.ok(parse.every(value => value.startsWith('"')));
    assert.ok(parse.every(value => !value.includes('DO_NOT_PARSE')));
  });
  test(`${variant}: large preceding state within budget is skipped`, async t => {
    const fixture = await setup(t);
    await fixture.save({ privateState: 'x'.repeat(1100000), 'local-projects': projects });
    assert.equal((await new ProjectLabels({ codexHome: fixture.home, timeoutMs: 1000 }).read('/work/source', 'chosen')).label, '自定义项目');
  });
  test(`${variant}: missing, truncated, malformed, too large and nonregular state fall back`, async t => {
    const fixture = await setup(t), reader = new ProjectLabels({ codexHome: fixture.home, maxBytes: 1024 });
    for (const content of [null, '{"local-projects":', '{"unused":[true,],"local-projects":{}}', '{}trailing', 'x'.repeat(1025)]) {
      if (content !== null) await fs.writeFile(fixture.state, content);
      assert.deepEqual(await reader.read('/work/source', 'chosen'), { label: 'source', detail: '/work/source' });
    }
    await fs.rm(fixture.state);
    await fs.mkdir(fixture.state);
    assert.equal((await reader.read('/work/source', 'chosen')).label, 'source');
  });
  test(`${variant}: symlink escapes and permission failures fall back`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects });
    const denied = new ProjectLabels({ codexHome: fixture.home, filesystem: { ...fs, lstat: async () => { throw Error('EACCES'); } } });
    assert.equal((await denied.read('/work/source', 'chosen')).label, 'source');
    const escaped = new ProjectLabels({ codexHome: fixture.home, filesystem: { ...fs, realpath: async value => value === fixture.home ? fixture.home : path.resolve(fixture.home, '..', 'outside.json') } });
    assert.equal((await escaped.read('/work/source', 'chosen')).label, 'source');
  });
  test(`${variant}: same target coalesces and caller mutation cannot poison cache`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects });
    let opens = 0;
    const reader = new ProjectLabels({ codexHome: fixture.home, filesystem: { ...fs, open: async (...args) => { opens++; return fs.open(...args); } } });
    const first = reader.read('/work/source', 'chosen'), second = reader.read('/work/source', 'chosen');
    assert.equal(first, second);
    const value = await first;
    value.label = 'tampered';
    assert.equal((await reader.read('/work/source', 'chosen')).label, '自定义项目');
    assert.equal(opens, 1);
  });
  test(`${variant}: timeout late result cannot populate cache and next call retries`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects });
    let release, delayed = true;
    const filesystem = { ...fs, open: async (...args) => {
      if (delayed) await new Promise(resolve => { release = resolve; });
      return fs.open(...args);
    } };
    const reader = new ProjectLabels({ codexHome: fixture.home, filesystem, timeoutMs: 20 });
    assert.equal((await reader.read('/work/source', 'chosen')).label, 'source');
    delayed = false;
    release?.();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(reader.cache.size, 0);
    // The short deadline above exercises a deliberately hung provider. Retry
    // verifies recovery, independently of normal disk latency under test load.
    reader.timeoutMs = 1000;
    assert.equal((await reader.read('/work/source', 'chosen')).label, '自定义项目');
  });
  test(`${variant}: file changed during read is not committed`, async t => {
    const fixture = await setup(t);
    await fixture.save({ 'local-projects': projects });
    let changed = false;
    const filesystem = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!changed) { changed = true; await fs.appendFile(fixture.state, ' '); }
        return result;
      } };
    } };
    const reader = new ProjectLabels({ codexHome: fixture.home, filesystem });
    assert.equal((await reader.read('/work/source', 'chosen')).label, 'source');
    assert.equal(reader.cache.size, 0);
  });
}
