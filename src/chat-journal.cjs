'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { checkedDirectory } = require('./chat-project.cjs');

// Project-scoped storage only. Callers must whitelist their own schema before
// writing. No process-global home directory, auth reader or runtime event log.
class ChatJournal {
  constructor(root, { fs: io = fs } = {}) { this.fs = io; this.root = checkedDirectory(root, io); }
  file(relative, create = false) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
        path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' ||
          /[<>:"|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('CHAT_PATH_UNSAFE');
    if (checkedDirectory(this.root, this.fs) !== this.root) throw new Error('CHAT_ROOT_CHANGED');
    const pieces = relative.split('/'); let current = this.root;
    for (let i = 0; i < pieces.length; i++) {
      current = path.join(current, pieces[i]);
      if (!this.fs.existsSync(current)) {
        if (i < pieces.length - 1 && create) this.fs.mkdirSync(current);
        else if (i < pieces.length - 1) return null;
        else return current;
      }
      const info = this.fs.lstatSync(current);
      if (info.isSymbolicLink() || (i < pieces.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('CHAT_PATH_UNSAFE');
    }
    return current;
  }
  read(relative) {
    const file = this.file(relative);
    if (!file || !this.fs.existsSync(file)) return null;
    const raw = this.fs.readFileSync(file, 'utf8');
    // Do not silently select a previous record when the committed file is corrupt.
    if (!raw.endsWith('\n')) throw new Error('CHAT_JOURNAL_INCOMPLETE');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length !== 1) throw new Error('CHAT_JOURNAL_INVALID');
    const value=JSON.parse(lines[0]);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('CHAT_JOURNAL_INVALID');
    return value;
  }
  write(relative, value, { exclusive = false } = {}) {
    const file = this.file(relative, true);
    if (exclusive && this.fs.existsSync(file)) throw new Error('CHAT_JOURNAL_EXISTS');
    const bytes = `${JSON.stringify(value)}\n`;
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, bytes); this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = undefined;
      this.file(relative, true);
      if (exclusive) { this.fs.linkSync(temporary, file); this.fs.unlinkSync(temporary); }
      else this.fs.renameSync(temporary, file);
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
  }
  locked(relative, work) {
    const file = this.file(relative, true); let fd;
    try { fd = this.fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('CHAT_PROJECT_BUSY'); throw error; }
    const release = () => { if (fd !== undefined) { this.fs.closeSync(fd); fd = undefined; this.fs.unlinkSync(file); } };
    try {
      const result = work();
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
      release(); return result;
    } catch (error) { release(); throw error; }
  }
}
module.exports = { ChatJournal };
