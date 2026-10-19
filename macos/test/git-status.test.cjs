'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { readGitStatus: readNativeGitStatus } = require('../src/git-status.cjs');
const readGitStatus = (cwd, options = {}) => readNativeGitStatus(cwd, { systemConfig: '/dev/null', ...options });

async function isolated(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-maid-git-status-'));
  const profile = path.join(directory, 'profile');
  const repo = path.join(directory, 'repo');
  await fs.mkdir(profile);
  await fs.mkdir(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: profile, CODEX_HOME: path.join(profile, 'codex'), CODEX_MAID_HOME: path.join(profile, 'maid'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  });
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^codex-maid-git-status-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, repo, profile, env };
}

function git(fixture, args, cwd = fixture.repo) {
  return execFileSync('git', args, { cwd, env: fixture.env, windowsHide: true, encoding: 'buffer' });
}

async function repository(t) {
  const fixture = await isolated(t);
  git(fixture, ['init', '--initial-branch=main']);
  git(fixture, ['config', 'user.name', 'Isolated Test']);
  git(fixture, ['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(fixture.repo, 'nested'));
  await Promise.all([
    fs.writeFile(path.join(fixture.repo, 'both.txt'), 'original both\n'),
    fs.writeFile(path.join(fixture.repo, 'deleted.txt'), 'original deleted\n'),
    fs.writeFile(path.join(fixture.repo, 'rename-source.txt'), 'rename source content\n'),
    fs.writeFile(path.join(fixture.repo, 'nested', 'tracked.txt'), 'nested\n'),
    fs.writeFile(path.join(fixture.repo, '.gitignore'), 'ignored/\n'),
  ]);
  git(fixture, ['add', '--all']);
  git(fixture, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'isolated baseline']);
  return fixture;
}

test('whole repository count includes both columns once, rename once, deletes and every untracked file', async t => {
  const fixture = await repository(t);
  assert.deepEqual(await readGitStatus(fixture.repo, { env: fixture.env }), { status: 'ready', count: 0 });
  await fs.writeFile(path.join(fixture.repo, 'both.txt'), 'staged both\n');
  git(fixture, ['add', '--', 'both.txt']);
  await fs.writeFile(path.join(fixture.repo, 'both.txt'), 'unstaged after staged\n');
  await fs.unlink(path.join(fixture.repo, 'deleted.txt'));
  git(fixture, ['mv', '--', 'rename-source.txt', 'renamed file.txt']);
  await fs.mkdir(path.join(fixture.repo, 'untracked'));
  await fs.writeFile(path.join(fixture.repo, 'untracked', 'first file.txt'), 'fixture');
  await fs.writeFile(path.join(fixture.repo, 'untracked', '中文 第二个.txt'), 'fixture');
  await fs.mkdir(path.join(fixture.repo, 'ignored'));
  await fs.writeFile(path.join(fixture.repo, 'ignored', 'private.txt'), 'fixture');
  const index = path.join(fixture.repo, '.git', 'index');
  const beforeBytes = await fs.readFile(index);
  const beforeInfo = await fs.stat(index);
  const nestedResult = await readGitStatus(path.join(fixture.repo, 'nested'), { env: fixture.env });
  assert.deepEqual(nestedResult, { status: 'ready', count: 5 });
  assert.deepEqual(await fs.readFile(index), beforeBytes);
  assert.equal((await fs.stat(index)).mtimeMs, beforeInfo.mtimeMs);
  assert.deepEqual(Object.keys(nestedResult).sort(), ['count', 'status']);
});

test('inherited Git worktree/index/config injection cannot redirect the selected repository', async t => {
  const fixture = await repository(t);
  await fs.writeFile(path.join(fixture.repo, 'untracked.txt'), 'fixture');
  const injected = { ...fixture.env,
    GIT_DIR: path.join(fixture.directory, 'wrong.git'),
    GIT_WORK_TREE: fixture.profile,
    GIT_INDEX_FILE: path.join(fixture.profile, 'wrong-index'),
    GIT_COMMON_DIR: path.join(fixture.profile, 'wrong-common'),
    GIT_CEILING_DIRECTORIES: fixture.repo,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: fixture.profile,
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=untrusted-command'",
    GIT_OBJECT_DIRECTORY: path.join(fixture.profile, 'wrong-objects'),
    git_work_tree: fixture.profile,
  };
  assert.deepEqual(await readGitStatus(fixture.repo, { env: injected }), { status: 'ready', count: 1 });
  assert.deepEqual(await fs.readdir(fixture.profile), []);
});

test('local fsmonitor command is disabled for status', async t => {
  const fixture = await repository(t);
  const marker = path.join(fixture.directory, 'fsmonitor-ran');
  const command = '"' + process.execPath.replace(/\\/g, '/') + '" -e "require(\'fs\').writeFileSync(\'' + marker.replace(/\\/g, '/') + '\', \'executed\')"';
  git(fixture, ['config', 'core.fsmonitor', command]);
  assert.deepEqual(await readGitStatus(fixture.repo, { env: fixture.env }), { status: 'ready', count: 0 });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('normal global excludesFile is respected from an isolated profile', async t => {
  const fixture = await repository(t);
  const excludes = path.join(fixture.profile, 'global-ignore');
  await fs.writeFile(excludes, 'globally-ignored.txt\n');
  await fs.writeFile(path.join(fixture.profile, '.gitconfig'), '[core]\n\texcludesFile = ' + JSON.stringify(excludes.replace(/\\/g, '/')) + '\n');
  await fs.writeFile(path.join(fixture.repo, 'globally-ignored.txt'), 'fixture');
  await fs.writeFile(path.join(fixture.repo, 'visible.txt'), 'fixture');
  assert.deepEqual(await readGitStatus(fixture.repo, { env: fixture.env }), { status: 'ready', count: 1 });
});

test('missing or non-repository workspaces are explicit, without stderr or paths', async t => {
  const fixture = await isolated(t);
  assert.deepEqual(await readGitStatus(fixture.repo, { env: fixture.env }), {
    status: 'not-repository', reason: '当前工作区不是 Git 仓库',
  });
  for (const cwd of [null, 'relative', path.join(fixture.repo, 'missing'), 'bad\0path']) {
    assert.deepEqual(await readGitStatus(cwd, { env: fixture.env }), { status: 'unavailable', reason: '当前对话工作区不可用' });
  }
  assert.deepEqual(await readGitStatus(fixture.repo, { env: fixture.env, gitPath: path.join(fixture.directory, 'missing-git.exe') }), {
    status: 'unavailable', reason: '未找到 Git',
  });
});

function injectedOutput(fixture, output, inspect = () => {}) {
  return readGitStatus(fixture.repo, { env: fixture.env, gitPath: process.execPath, execFile(file, args, options, done) {
    inspect(file, args, options);
    done(null, output, Buffer.alloc(0));
  } });
}

test('porcelain NUL parser consumes rename/copy sources and preserves arbitrary filename bytes', async t => {
  const fixture = await isolated(t);
  const entries = [
    Buffer.from('R  dest -> \\n line\0old name\0'),
    Buffer.from(' C copy target\0copy source\0'),
    Buffer.from('MM both columns\0'),
    Buffer.from(' M both columns\0'),
    Buffer.from('?? tab\tand newline\nname\0'),
    Buffer.from([63, 63, 32, 255, 0]),
    Buffer.from([63, 63, 32, 254, 0]),
  ];
  assert.deepEqual(await injectedOutput(fixture, Buffer.concat(entries), (file, args, options) => {
    assert.ok(path.isAbsolute(file));
    assert.ok(args.includes('--no-optional-locks'));
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.ok(args.includes('--untracked-files=all'));
    assert.equal(args.includes('--'), false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 1500);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(options.encoding, 'buffer');
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(options.env.GIT_CONFIG_SYSTEM, '/dev/null');
  }), { status: 'ready', count: 6 });
});

test('incomplete or malformed porcelain never becomes a misleading count', async t => {
  const fixture = await isolated(t);
  for (const output of [' M truncated', 'R  destination\0', 'C  destination\0\0', 'bad status\0', '!! ignored\0', ' M \0']) {
    assert.deepEqual(await injectedOutput(fixture, Buffer.from(output)), {
      status: 'unavailable', reason: '暂时无法读取 Git 状态',
    });
  }
});

test('real child timeout and output bounds return fixed reasons', async t => {
  const fixture = await isolated(t);
  const readScript = (script, options) => readGitStatus(fixture.repo, {
    env: fixture.env, gitPath: process.execPath, ...options,
    execFile(_file, _args, childOptions, done) {
      return execFile(process.execPath, ['-e', script], childOptions, done);
    },
  });
  assert.deepEqual(await readScript('setTimeout(() => {}, 5000)', { timeout: 40 }), {
    status: 'timeout', reason: 'Git 查询超时，请重试',
  });
  assert.deepEqual(await readScript('process.stdout.write("x".repeat(4096))', { maxBuffer: 128 }), {
    status: 'unavailable', reason: 'Git 变更过多，暂时无法统计',
  });
});

test('untrusted failure diagnostics never cross the result boundary', async t => {
  const fixture = await isolated(t);
  const result = await readGitStatus(fixture.repo, { env: fixture.env, gitPath: process.execPath,
    execFile(_file, _args, _options, done) {
      done(Object.assign(new Error('private-path-and-token'), { code: 128 }), '', 'fatal: private-path-and-token');
    },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: '暂时无法读取 Git 状态' });
  assert.equal(JSON.stringify(result).includes('private-path-and-token'), false);
});

test('unresponsive workspace stat is bounded before spawning Git', async t => {
  const fixture = await isolated(t);
  let spawned = false;
  const started = Date.now();
  const result = await readGitStatus(fixture.repo, {
    env: fixture.env, stat: () => new Promise(() => {}),
    execFile() { spawned = true; throw new Error('Git must not start'); },
  });
  assert.deepEqual(result, { status: 'timeout', reason: '工作区查询超时，请重试' });
  assert.equal(spawned, false);
  assert.ok(Date.now() - started < 1000);
});
