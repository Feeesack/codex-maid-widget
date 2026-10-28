'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultChatParent, inspectProject, createChatProject, resumeChatProject } = require('../src/chat-project.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-chat-project-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parentDir = path.join(directory, '中文 父目录');
  fs.mkdirSync(parentDir);
  return { directory, parentDir };
}

test('default chooser path honors isolated homes and custom drives without cwd or PATH', () => {
  assert.equal(defaultChatParent({ env: { PATH: '' }, home: path.resolve('virtual isolated home') }), path.join(path.resolve('virtual isolated home'), '.codex'));
  assert.equal(defaultChatParent({ env: { CODEX_HOME: 'F:\\自定义 数据\\codex', PATH: '' }, home: 'X:\\用户', pathApi: path.win32 }), 'F:\\自定义 数据\\codex');
  assert.equal(defaultChatParent({ env: { Codex_Home: 'G:\\移动 数据' }, home: 'X:\\用户', pathApi: path.win32 }), 'G:\\移动 数据');
  assert.throws(() => defaultChatParent({ env: { CODEX_HOME: 'relative-home' }, home: path.resolve('isolated') }), { code: 'CHAT_PATH_INVALID' });
});

test('initialization requires explicit parent and nickname and creates a dedicated child only', t => {
  const { parentDir } = fixture(t);
  assert.throws(() => createChatProject({ userNickname: '昵称' }), { code: 'CHAT_PATH_INVALID' });
  for (const nickname of ['', ' ', '用户\n第二行', '\0', '昵称\u2028下一行']) {
    assert.throws(() => createChatProject({ parentDir, userNickname: nickname }), { code: 'CHAT_NAME_INVALID' });
  }
  assert.equal(fs.readdirSync(parentDir).length, 0);
  const result = createChatProject({ parentDir, userNickname: '  昵称 / 王朝 <>  ', now: () => new Date('2026-10-26T01:00:00Z') });
  assert.equal(result.root, path.join(fs.realpathSync(parentDir), 'codex-maid-chat'));
  assert.equal(result.project.petName, '小龙娘');
  assert.equal(result.project.userNickname, '  昵称 / 王朝 <>  ');
  assert.equal(result.project.createdAt, '2026-10-26T01:00:00.000Z');
  assert.deepEqual(fs.readdirSync(parentDir), ['codex-maid-chat']);
  assert.deepEqual(fs.readdirSync(result.root), ['project.json']);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(result.root, 'project.json'))), 'root'), false);
});

test('collisions never merge or overwrite and numeric suffix or recovery must be explicit', t => {
  const { parentDir } = fixture(t);
  const existing = createChatProject({ parentDir, petName: '自定义 宠物', userNickname: '昵称' });
  const before = fs.readFileSync(path.join(existing.root, 'project.json'));
  assert.throws(() => createChatProject({ parentDir, userNickname: '其他' }), { code: 'CHAT_PROJECT_EXISTS' });
  assert.deepEqual(fs.readFileSync(path.join(existing.root, 'project.json')), before);
  assert.deepEqual(resumeChatProject(existing.root), existing);
  assert.equal(createChatProject({ parentDir, userNickname: '新昵称', folderName: 'codex-maid-chat-2' }).project.userNickname, '新昵称');
  for (const folderName of ['..', '../elsewhere', 'codex-maid-chat/other', '任意目录', 'codex-maid-chat-0']) {
    assert.throws(() => createChatProject({ parentDir, userNickname: '昵称', folderName }), { code: 'CHAT_FOLDER_INVALID' });
  }
  const empty = path.join(parentDir, 'codex-maid-chat-3'); fs.mkdirSync(empty);
  assert.throws(() => createChatProject({ parentDir, userNickname: '昵称', folderName: 'codex-maid-chat-3' }), { code: 'CHAT_PROJECT_EXISTS' });
  assert.equal(inspectProject(empty), null);
});

test('project remains portable after an explicit directory move', t => {
  const { parentDir, directory } = fixture(t);
  const original = createChatProject({ parentDir, userNickname: '旅人' });
  const moved = path.join(directory, '另一 位置');
  fs.renameSync(original.root, moved);
  const restored = resumeChatProject(moved);
  assert.deepEqual(restored.project, original.project);
  assert.equal(restored.root, fs.realpathSync(moved));
});

test('write failure preserves incomplete metadata, blocks resume, and permits explicit new directory', t => {
  const { parentDir } = fixture(t);
  const io = { ...fs, renameSync: () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); } };
  assert.throws(() => createChatProject({ parentDir, userNickname: '昵称', fs: io }), { code: 'CHAT_PROJECT_CREATE_INCOMPLETE' });
  const root = path.join(parentDir, 'codex-maid-chat');
  assert.ok(fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  assert.throws(() => resumeChatProject(root), { code: 'CHAT_PROJECT_MISSING' });
  assert.throws(() => createChatProject({ parentDir, userNickname: '昵称' }), { code: 'CHAT_PROJECT_EXISTS' });
  assert.ok(createChatProject({ parentDir, userNickname: '昵称', folderName: 'codex-maid-chat-2' }));
});

test('malformed, oversized and linked manifests are never accepted as initialized', t => {
  const { parentDir, directory } = fixture(t);
  const project = createChatProject({ parentDir, userNickname: '昵称' });
  const file = path.join(project.root, 'project.json');
  fs.writeFileSync(file, '{bad json');
  assert.throws(() => resumeChatProject(project.root), { code: 'CHAT_PROJECT_INVALID' });
  fs.writeFileSync(file, ' '.repeat(32769));
  assert.throws(() => resumeChatProject(project.root), { code: 'CHAT_PROJECT_INVALID' });
  const linked = path.join(directory, 'linked');
  try { fs.symlinkSync(project.root, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symbolic links unavailable in this test account'); throw error; }
  assert.throws(() => resumeChatProject(linked), { code: 'CHAT_DIRECTORY_UNSAFE' });
});
