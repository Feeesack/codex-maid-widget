'use strict';

// Codex's native project identity and its desktop project registration are
// separate from a thread's cwd. The first-use path appends one verified local
// project mapping atomically; unrelated desktop state is preserved and no
// ownership is inferred from a chat title.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultChatParent, resumeChatProject } = require('./chat-project.cjs');
const { randomUUID } = require('node:crypto');

const OWNER_KEY = 'codex-maid-widget.projectId';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const fail = code => Object.assign(new Error(code), { code, executionState: 'not-executed' });

function readDesktopRegistration({ projectRoot, codexHome, sameRoot, samePath, fs: io = fs, pathApi = path }) {
  samePath ||= (left, right) => {
    try {
      const normalize = value => { const result = pathApi.normalize(io.realpathSync(value));
        return pathApi === path.win32 || process.platform === 'win32' && pathApi === path ? result.toLowerCase() : result; };
      return normalize(left) === normalize(right);
    } catch { return false; }
  };
  const file = pathApi.join(codexHome, '.codex-global-state.json');
  let value;
  try {
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw fail('CHAT_DESKTOP_STATE_INVALID');
    value = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('CHAT_DESKTOP_STATE_INVALID');
  }
  const projects = value?.['local-projects'];
  if (projects === undefined) return null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) throw fail('CHAT_DESKTOP_STATE_INVALID');
  const matches = Object.entries(projects).filter(([key, project]) => id(key) && project &&
    Array.isArray(project.rootPaths) && project.rootPaths.length === 1 && sameRoot(project.rootPaths[0]));
  if (matches.length > 1) throw fail('CHAT_DESKTOP_PROJECT_AMBIGUOUS');
  if (!matches.length) return null;
  const [localProjectId, project] = matches[0];
  const map = value?.['app-server-project-id-by-legacy-project-id-by-host'];
  const bindings = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map)
    .filter(([key]) => key.startsWith('local:') && samePath(key.slice(6), codexHome))
    .map(([, mapping]) => mapping?.[localProjectId]).filter(id) : [];
  const unique = [...new Set(bindings)];
  if (unique.length > 1) throw fail('CHAT_DESKTOP_PROJECT_AMBIGUOUS');
  return { localProjectId, name: typeof project.name === 'string' ? project.name.slice(0, 160) : pathApi.basename(projectRoot),
    serverProjectId: unique[0] || null };
}

function writeDesktopRegistration({ projectRoot, codexHome, localProjectId, name, serverProjectId,
  sameRoot, samePath, fs: io = fs, pathApi = path, now = Date.now }) {
  if (!id(localProjectId) || !id(serverProjectId) || typeof name !== 'string' || !name.trim()) throw fail('CHAT_DESKTOP_STATE_INVALID');
  const file = pathApi.join(codexHome, '.codex-global-state.json');
  let value = {};
  try {
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw fail('CHAT_DESKTOP_STATE_INVALID');
    value = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('CHAT_DESKTOP_STATE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CHAT_DESKTOP_STATE_INVALID');
  const projects = value['local-projects'] && typeof value['local-projects'] === 'object' && !Array.isArray(value['local-projects'])
    ? { ...value['local-projects'] } : {};
  const matches = Object.entries(projects).filter(([key, project]) => id(key) && project && Array.isArray(project.rootPaths) &&
    project.rootPaths.length === 1 && sameRoot(project.rootPaths[0]));
  if (matches.length > 1) throw fail('CHAT_DESKTOP_PROJECT_AMBIGUOUS');
  const selected = matches[0];
  const selectedId = selected?.[0] || localProjectId;
  const selectedProject = selected?.[1];
  projects[selectedId] = {
    ...(selectedProject && typeof selectedProject === 'object' ? selectedProject : {}),
    id: selectedId, name: selectedProject?.name || name, rootPaths: [projectRoot],
    createdAt: selectedProject?.createdAt || now(), updatedAt: now()
  };
  value['local-projects'] = projects;
  const hostKey = `local:${pathApi.resolve(codexHome)}`;
  const mappings = value['app-server-project-id-by-legacy-project-id-by-host'] &&
    typeof value['app-server-project-id-by-legacy-project-id-by-host'] === 'object' &&
    !Array.isArray(value['app-server-project-id-by-legacy-project-id-by-host'])
    ? { ...value['app-server-project-id-by-legacy-project-id-by-host'] } : {};
  mappings[hostKey] = { ...(mappings[hostKey] && typeof mappings[hostKey] === 'object' ? mappings[hostKey] : {}), [selectedId]: serverProjectId };
  value['app-server-project-id-by-legacy-project-id-by-host'] = mappings;
  const temporary = pathApi.join(codexHome, `.codex-global-state-${randomUUID()}.tmp`);
  const descriptor = io.openSync(temporary, 'wx', 0o600);
  try {
    io.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    io.fsyncSync?.(descriptor);
  } finally { io.closeSync(descriptor); }
  try {
    io.renameSync(temporary, file);
  } catch (error) {
    try { io.unlinkSync(temporary); } catch {}
    throw fail('CHAT_DESKTOP_STATE_WRITE_FAILED');
  }
  const confirmed = readDesktopRegistration({ projectRoot, codexHome, sameRoot, samePath, fs: io, pathApi });
  if (!confirmed || confirmed.localProjectId !== selectedId || confirmed.serverProjectId !== serverProjectId) throw fail('CHAT_DESKTOP_STATE_NOT_CONFIRMED');
  return confirmed;
}

class DesktopProjectBinding {
  constructor(options) {
    this.options = options; this.root = options.projectRoot; this.io = options.fs || fs;
    this.paths = options.pathApi || path; this.request = options.request;
    this.sameRoot = options.sameRoot;
    this.samePath = options.samePath || ((left, right) => {
      try {
        const normalize = value => { const result = this.paths.normalize(this.io.realpathSync(value));
          return options.platform === 'win32' ? result.toLowerCase() : result; };
        return normalize(left) === normalize(right);
      } catch { return false; }
    });
    this.codexHome = options.codexHome || defaultChatParent({ env: options.env || process.env,
      home: options.home || os.homedir(), pathApi: this.paths });
    this.pending = null; this.current = null;
  }

  _project() {
    const value = (this.options.inspectProject || (root => resumeChatProject(root, { fs: this.io })))(this.root);
    if (!this.sameRoot(value?.root) || !/^P-[0-9a-f-]{36}$/i.test(value?.project?.projectId || '')) throw fail('CHAT_PROJECT_INVALID');
    return value.project;
  }

  _verify(project, companionId) {
    if (!id(project?.id) || !Array.isArray(project.roots) || project.roots.length !== 1 || !this.sameRoot(project.roots[0]?.path) ||
        project.metadata?.[OWNER_KEY] !== undefined && project.metadata[OWNER_KEY] !== companionId) throw fail('CHAT_DESKTOP_PROJECT_SCOPE');
    return project;
  }

  async ensure() {
    if (this.pending) return this.pending;
    const operation = this._ensure(); this.pending = operation;
    try { return await operation; } finally { if (this.pending === operation) this.pending = null; }
  }

  async _ensure() {
    const companion = this._project();
    const registration = await (this.options.readDesktopRegistration || readDesktopRegistration)({ projectRoot: this.root,
      codexHome: this.codexHome, sameRoot: this.sameRoot, samePath: this.samePath, fs: this.io, pathApi: this.paths });
    let effective = registration;
    if (!effective) {
      // First use is fully automatic. Create the native project first, then
      // append the desktop-local project mapping without touching unrelated
      // projects. A later retry can find the same native project by its exact
      // companion root even if the local cache write was interrupted.
      const localProjectId = randomUUID(), name = `${companion.petName || '桌宠'}聊天记录`;
      const matches = []; let cursor = null; const cursors = new Set();
      for (let page = 0; page < 20; page++) {
        const result = await this.request('project/list', { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || result.data.length > 50) throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        for (const project of result.data) if (Array.isArray(project?.roots) && project.roots.length === 1 && this.sameRoot(project.roots[0]?.path))
          matches.push(this._verify(project, companion.projectId));
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192 || cursors.has(result.nextCursor) || page === 19)
          throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      if (matches.length > 1) throw fail('CHAT_DESKTOP_PROJECT_AMBIGUOUS');
      const native = matches[0] || this._verify((await this.request('project/create', {
        idempotencyKey: localProjectId, name, roots: [{ path: this.root }], metadata: { [OWNER_KEY]: companion.projectId }
      }))?.project, companion.projectId);
      effective = await (this.options.writeDesktopRegistration || writeDesktopRegistration)({ projectRoot: this.root,
        codexHome: this.codexHome, localProjectId, name, serverProjectId: native.id, sameRoot: this.sameRoot, samePath: this.samePath,
        fs: this.io, pathApi: this.paths });
    }
    if (!id(effective.localProjectId) || effective.serverProjectId != null && !id(effective.serverProjectId)) throw fail('CHAT_DESKTOP_STATE_INVALID');
    let native;
    if (effective.serverProjectId) {
      native = this._verify((await this.request('project/read', { projectId: effective.serverProjectId }))?.project, companion.projectId);
    } else {
      const matches = []; let cursor = null; const cursors = new Set();
      for (let page = 0; page < 20; page++) {
        const result = await this.request('project/list', { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || result.data.length > 50) throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        for (const project of result.data) if (Array.isArray(project?.roots) && project.roots.length === 1 && this.sameRoot(project.roots[0]?.path))
          matches.push(this._verify(project, companion.projectId));
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192 || cursors.has(result.nextCursor) || page === 19)
          throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      if (matches.length > 1) throw fail('CHAT_DESKTOP_PROJECT_AMBIGUOUS');
      native = matches[0];
      if (!native) {
        // Reuse the desktop's own idempotency identity. A concurrent desktop
        // import/create therefore cannot create another project for this root.
        native = this._verify((await this.request('project/create', { idempotencyKey: effective.localProjectId,
          name: effective.name || 'Codex Maid Chat', roots: [{ path: this.root }], metadata: { [OWNER_KEY]: companion.projectId } }))?.project, companion.projectId);
      }
    }
    return this.current = { projectId: native.id, desktopRegistered: true, localProjectId: effective.localProjectId, registrationRequired: false };
  }

  async assign(threadId, { readThread, isOwned }) {
    if (!id(threadId) || !isOwned(threadId)) throw fail('THREAD_SCOPE');
    const binding = await this.ensure();
    if (!binding.desktopRegistered) throw fail('CHAT_DESKTOP_PROJECT_REQUIRED');
    let thread = (await readThread(threadId))?.thread;
    if (thread?.id !== threadId || !this.sameRoot(thread.cwd)) throw fail('THREAD_SCOPE');
    // An explicit assignment to another project is not evidence that it may
    // be overwritten, even for a previously owned thread.
    if (thread.projectId != null && thread.projectId !== '' && thread.projectId !== binding.projectId) throw fail('CHAT_DESKTOP_THREAD_PROJECT_CONFLICT');
    if (thread.projectId !== binding.projectId) {
      await this.request('thread/metadata/update', { threadId, projectId: binding.projectId });
      thread = (await readThread(threadId))?.thread;
      if (thread?.id !== threadId || !this.sameRoot(thread.cwd) || thread.projectId !== binding.projectId) throw fail('CHAT_DESKTOP_PROJECT_NOT_CONFIRMED');
    }
    return { ...binding, threadId, projectAssigned: true };
  }

  async reconcile({ readThread, registerOwned }) {
    const binding = await this.ensure();
    const summary = { ...binding, discovered: 0, assigned: 0, alreadyAssigned: 0, conflicts: 0, failed: 0, discoveryComplete: false };
    if (!binding.desktopRegistered) return summary;
    this._project();
    const candidates = new Set();
    for (const archived of [false, true]) {
      let cursor = null; const cursors = new Set();
      for (let page = 0; page < 100; page++) {
        // Restrict the native DB query itself. Never scan rollout JSONL or
        // search by titles; response previews/turns are ignored and not kept.
        const result = await this.request('thread/list', { cwd: this.root, archived, useStateDbOnly: true, limit: 50,
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
          ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || result.data.length > 50) throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        for (const thread of result.data) if (id(thread?.id) && thread.ephemeral !== true && this.sameRoot(thread.cwd)) candidates.add(thread.id);
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192 || cursors.has(result.nextCursor) || page === 99)
          throw fail('CHAT_DESKTOP_PROJECT_PROTOCOL');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
    }
    summary.discovered = candidates.size; summary.discoveryComplete = true;
    for (const threadId of candidates) {
      try {
        const thread = (await readThread(threadId))?.thread;
        if (thread?.id !== threadId || !this.sameRoot(thread.cwd) || thread.ephemeral === true) throw fail('THREAD_SCOPE');
        if (thread.projectId != null && thread.projectId !== '' && thread.projectId !== binding.projectId) { summary.conflicts++; continue; }
        registerOwned(threadId);
        if (thread.projectId === binding.projectId) { summary.alreadyAssigned++; continue; }
        await this.request('thread/metadata/update', { threadId, projectId: binding.projectId });
        const confirmed = (await readThread(threadId))?.thread;
        if (confirmed?.id !== threadId || !this.sameRoot(confirmed.cwd) || confirmed.projectId !== binding.projectId) throw fail('CHAT_DESKTOP_PROJECT_NOT_CONFIRMED');
        summary.assigned++;
      } catch { summary.failed++; }
    }
    return summary;
  }
}

module.exports = { DesktopProjectBinding, readDesktopRegistration, OWNER_KEY };
