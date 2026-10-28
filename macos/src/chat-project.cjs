'use strict';

// The selected parent is explicit. No authentication, user-name discovery or
// existing Codex project is consulted while creating a companion project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROJECT_SCHEMA = 'codex-maid-chat-project/1';
const PROJECT_FILE = 'project.json';
const DEFAULT_FOLDER = 'codex-maid-chat';
const FOLDER_PATTERN = /^codex-maid-chat(?:-[1-9]\d{0,5})?$/;

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function displayName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw failure('CHAT_NAME_INVALID', `${label} must be a nonempty single line of at most 160 characters.`);
  }
  return value;
}

function absolutePath(value, label = 'Directory', pathApi = path) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !pathApi.isAbsolute(value)) {
    throw failure('CHAT_PATH_INVALID', `${label} must be an explicit absolute path.`);
  }
  return pathApi.resolve(value);
}

function defaultChatParent({ env = process.env, home = os.homedir(), pathApi = path } = {}) {
  // Environment keys are case-insensitive on Windows, including constructed
  // environment maps used by launchers and isolated tests.
  const overrideKey = Object.keys(env).find(key => key.toUpperCase() === 'CODEX_HOME');
  const override = overrideKey === undefined ? undefined : env[overrideKey];
  if (override !== undefined && override !== '') return absolutePath(override, 'CODEX_HOME', pathApi);
  return pathApi.join(absolutePath(home, 'Home directory', pathApi), '.codex');
}

function checkedDirectory(directory, io = fs) {
  const resolved = absolutePath(directory);
  const stat = io.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure('CHAT_DIRECTORY_UNSAFE', 'The selected directory must be a real directory, not a symbolic link.');
  }
  return io.realpathSync(resolved);
}

function validateProject(value) {
  if (!value || value.schema !== PROJECT_SCHEMA || !/^P-[0-9a-f-]{36}$/i.test(value.projectId || '') ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw failure('CHAT_PROJECT_INVALID', 'The directory is not a supported companion project.');
  }
  return {
    schema: PROJECT_SCHEMA,
    projectId: value.projectId,
    petName: displayName(value.petName, 'Pet name'),
    userNickname: displayName(value.userNickname, 'User nickname'),
    createdAt: value.createdAt
  };
}

function inspectProject(root, { fs: io = fs } = {}) {
  try {
    const canonicalRoot = checkedDirectory(root, io);
    const file = path.join(canonicalRoot, PROJECT_FILE);
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) {
      throw failure('CHAT_PROJECT_INVALID', 'The project manifest is unsafe or invalid.');
    }
    const project = validateProject(JSON.parse(io.readFileSync(file, 'utf8')));
    return { root: canonicalRoot, project };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('CHAT_')) throw error;
    throw failure('CHAT_PROJECT_INVALID', 'The project could not be inspected; existing data was preserved.', error);
  }
}

function resumeChatProject(root, options) {
  const result = inspectProject(root, options);
  if (!result) throw failure('CHAT_PROJECT_MISSING', 'No complete companion project was found at this location.');
  return result;
}

function createChatProject({ parentDir, petName = '小龙娘', userNickname, folderName = DEFAULT_FOLDER,
  now = () => new Date(), fs: io = fs } = {}) {
  const safePetName = displayName(petName, 'Pet name');
  const safeNickname = displayName(userNickname, 'User nickname');
  if (typeof folderName !== 'string' || !FOLDER_PATTERN.test(folderName)) {
    throw failure('CHAT_FOLDER_INVALID', 'Use codex-maid-chat or an explicitly selected numeric suffix.');
  }
  const parent = checkedDirectory(parentDir, io);
  const root = path.join(parent, folderName);
  const createdAt = now();
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) throw failure('CHAT_TIME_INVALID', 'Invalid creation time.');
  const project = {
    schema: PROJECT_SCHEMA, projectId: `P-${randomUUID()}`, petName: safePetName,
    userNickname: safeNickname, createdAt: createdAt.toISOString()
  };
  try {
    // Exclusive mkdir reserves a fresh directory; even an empty existing
    // directory is never treated as permission to merge or replace its data.
    io.mkdirSync(root);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('CHAT_PROJECT_EXISTS', 'This project directory already exists. Choose explicit recovery or a new suffix.');
    throw failure('CHAT_PROJECT_CREATE_FAILED', 'The project directory could not be created.', error);
  }
  let descriptor;
  try {
    if (checkedDirectory(root, io) !== root) throw failure('CHAT_DIRECTORY_UNSAFE', 'The newly created project changed location.');
    const temporary = path.join(root, `.project-${randomUUID()}.tmp`);
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    io.fsyncSync(descriptor);
    io.closeSync(descriptor); descriptor = undefined;
    // This is a newly reserved private directory. Check again before publish
    // so deterministic link or destination substitution is rejected.
    if (checkedDirectory(root, io) !== root || io.existsSync(path.join(root, PROJECT_FILE))) {
      throw failure('CHAT_DIRECTORY_UNSAFE', 'The project destination changed while initializing.');
    }
    io.renameSync(temporary, path.join(root, PROJECT_FILE));
    return resumeChatProject(root, { fs: io });
  } catch (error) {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
    // Retain incomplete metadata for recovery. Never recursively remove a
    // directory that might now contain user files or an injected destination.
    const result = failure('CHAT_PROJECT_CREATE_INCOMPLETE', 'Initialization did not complete. The directory and existing data were preserved.', error);
    result.root = root;
    throw result;
  }
}

module.exports = {
  PROJECT_SCHEMA, PROJECT_FILE, DEFAULT_FOLDER,
  defaultChatParent, inspectProject, createChatProject, resumeChatProject,
  checkedDirectory, absolutePath, displayName
};
