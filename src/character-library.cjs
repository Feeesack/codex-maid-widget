'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CHARACTERS = 500;
const EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif']);
const CUSTOM_ID = /^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BUILT_INS = Object.freeze([
  { id: 'frost-glass-cheek', name: '小龙娘-托腮', file: 'characters/frost-glass-cheek.png' },
  { id: 'frost-glass-idle', name: '小龙娘-端庄', file: 'characters/frost-glass-idle.png' },
  { id: 'mint-maid', name: '薄荷女仆', file: 'maid.png' },
  { id: 'lilac-dragon', name: '紫晶龙女仆', file: 'characters/lilac-dragon.png' },
]);

function libraryError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    Array.from(value.trim()).length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeName(value) {
  if (!validName(value)) throw libraryError('INVALID_CHARACTER_NAME', '形象名称须为 1–40 个字符，不能包含换行或控制字符。');
  return value.trim();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function imageFormat(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)) &&
      buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0) return 'gif';
  return null;
}

/**
 * Local character storage. Source files are copied into userData/characters;
 * callers persist only the selected id in settings. All methods are synchronous.
 * validateImage(path), when supplied, must return false or throw for undecodable
 * images (for example Electron nativeImage.createFromPath(path).isEmpty()).
 */
class CharacterLibrary {
  constructor({ dataDir, assetRoot, validateImage } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
        typeof assetRoot !== 'string' || !path.isAbsolute(assetRoot)) {
      throw new TypeError('CharacterLibrary requires absolute dataDir and assetRoot paths.');
    }
    if (validateImage !== undefined && typeof validateImage !== 'function') throw new TypeError('validateImage must be a function.');
    this.dataDir = path.resolve(dataDir);
    this.assetRoot = path.resolve(assetRoot);
    this.directory = path.join(this.dataDir, 'characters');
    this.manifestPath = path.join(this.directory, 'library.json');
    this.defaultId = 'frost-glass-cheek';
    this.validateImage = validateImage;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.directory, { recursive: true });
    this.realDataDir = fs.realpathSync(this.dataDir);
    this.realDirectory = fs.realpathSync(this.directory);
    this._assertStorage();
    this.characters = [];
    this.nameOverrides = Object.create(null);
    this._load();
  }

  _assertStorage() {
    const info = fs.lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        fs.realpathSync(this.directory) !== this.realDirectory ||
        !this.realDirectory.startsWith(this.realDataDir + path.sep)) {
      throw libraryError('UNSAFE_CHARACTER_DIRECTORY', '形象保存目录不安全，请检查 characters 文件夹。');
    }
  }

  _storedPath(file) {
    this._assertStorage();
    if (typeof file !== 'string' || file !== path.basename(file) || /[\\/]/.test(file)) {
      throw libraryError('UNSAFE_CHARACTER_FILE', '形象库包含不安全的文件路径。');
    }
    const target = path.resolve(this.directory, file);
    if (path.dirname(target) !== this.directory) throw libraryError('UNSAFE_CHARACTER_FILE', '形象文件超出保存目录。');
    return target;
  }

  _load() {
    if (!fs.existsSync(this.manifestPath)) return;
    try {
      const stat = fs.lstatSync(this.manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid manifest file.');
      const input = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (!object(input) || input.version !== 1 || !Array.isArray(input.characters) ||
          input.characters.length > MAX_CHARACTERS ||
          Object.keys(input).some(key => !['version', 'characters', 'nameOverrides'].includes(key)) ||
          (input.nameOverrides !== undefined && !object(input.nameOverrides))) throw new Error('Invalid manifest schema.');
      const ids = new Set();
      const files = new Set();
      const records = input.characters.map(record => {
        if (!object(record) || !CUSTOM_ID.test(record.id) || !validName(record.name) ||
            typeof record.file !== 'string' || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
            Object.keys(record).some(key => !['id', 'name', 'file', 'sha256'].includes(key))) throw new Error('Invalid character record.');
        const extension = path.extname(record.file);
        if (!EXTENSIONS.has(extension) || record.file !== record.id + extension || ids.has(record.id) || files.has(record.file)) {
          throw new Error('Invalid character id or filename.');
        }
        this._storedPath(record.file);
        ids.add(record.id);
        files.add(record.file);
        return { id: record.id, name: record.name.trim(), file: record.file, sha256: record.sha256 };
      });
      const overrides = Object.create(null);
      for (const [id, name] of Object.entries(input.nameOverrides || {})) {
        if (!BUILT_INS.some(entry => entry.id === id) || !validName(name)) throw new Error('Invalid built-in name override.');
        overrides[id] = name.trim();
      }
      this.characters = records;
      this.nameOverrides = overrides;
    } catch (cause) {
      const error = libraryError('CHARACTER_LIBRARY_CORRUPT', '形象库索引无法读取，原索引和图片已保留。请先备份 characters 文件夹，再修复 library.json。', cause);
      error.manifestPath = this.manifestPath;
      throw error;
    }
  }

  _save() {
    this._assertStorage();
    if (fs.existsSync(this.manifestPath)) {
      const stat = fs.lstatSync(this.manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw libraryError('UNSAFE_CHARACTER_FILE', '形象库索引路径不安全。');
    }
    const temporary = this._storedPath('.library-' + crypto.randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ version: 1, characters: this.characters, nameOverrides: this.nameOverrides }, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.manifestPath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  _pathFor(record, builtIn) {
    return builtIn ? path.join(this.assetRoot, record.file) : this._storedPath(record.file);
  }

  _available(file, builtIn = false) {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && (builtIn || !stat.isSymbolicLink()) && stat.size > 0 && stat.size <= MAX_IMAGE_BYTES;
    } catch { return false; }
  }

  _entry(record, builtIn) {
    const file = this._pathFor(record, builtIn);
    return {
      id: record.id,
      name: builtIn ? this.nameOverrides[record.id] || record.name : record.name,
      url: pathToFileURL(file).href,
      builtIn,
      available: this._available(file, builtIn),
    };
  }

  list() {
    return [...BUILT_INS.map(record => this._entry(record, true)), ...this.characters.map(record => this._entry(record, false))];
  }

  get(id) {
    const builtin = BUILT_INS.find(record => record.id === id);
    if (builtin) return this._entry(builtin, true);
    const record = this.characters.find(record => record.id === id);
    return record ? this._entry(record, false) : null;
  }

  _findHash(hash) {
    for (const record of BUILT_INS) {
      const file = this._pathFor(record, true);
      if (this._available(file, true) && sha256(fs.readFileSync(file)) === hash) return this._entry(record, true);
    }
    for (const record of this.characters) {
      if (record.sha256 === hash && this._available(this._pathFor(record, false))) return this._entry(record, false);
    }
    return null;
  }

  _readImage(file) {
    if (typeof file !== 'string' || !file || !path.isAbsolute(file)) throw libraryError('INVALID_IMAGE_PATH', '请选择本地图片文件。');
    const extension = path.extname(file).toLowerCase();
    if (!EXTENSIONS.has(extension)) throw libraryError('UNSUPPORTED_IMAGE', '支持 PNG、WebP、JPG 和 GIF 图片。');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw libraryError('INVALID_IMAGE', '所选项目不是图片文件。');
    if (stat.size > MAX_IMAGE_BYTES) throw libraryError('IMAGE_TOO_LARGE', '单张图片不能超过 15 MB。');
    const buffer = fs.readFileSync(file);
    if (buffer.length > MAX_IMAGE_BYTES) throw libraryError('IMAGE_TOO_LARGE', '单张图片不能超过 15 MB。');
    const format = imageFormat(buffer);
    if (!format || (format === 'jpeg' ? !['.jpg', '.jpeg'].includes(extension) : extension !== '.' + format)) {
      throw libraryError('INVALID_IMAGE', '图片格式无效或与扩展名不符，请重新导出图片。');
    }
    if (this.validateImage && this.validateImage(file) === false) throw libraryError('INVALID_IMAGE', '无法解码图片，请重新导出图片。');
    return { buffer, extension };
  }

  importFiles(paths) {
    if (!Array.isArray(paths)) throw new TypeError('importFiles requires an array of absolute file paths.');
    const result = { imported: [], existing: [], errors: [] };
    for (const file of paths) {
      let target;
      let record;
      let created = false;
      try {
        const { buffer, extension } = this._readImage(file);
        const hash = sha256(buffer);
        const existing = this._findHash(hash);
        if (existing) { result.existing.push(existing); continue; }
        if (this.characters.length >= MAX_CHARACTERS) throw libraryError('CHARACTER_LIBRARY_FULL', '形象库最多保存 500 个导入形象。');
        const id = 'custom-' + crypto.randomUUID();
        const basename = path.basename(file, path.extname(file)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
        record = { id, name: Array.from(basename || '新形象').slice(0, 40).join(''), file: id + extension, sha256: hash };
        target = this._storedPath(record.file);
        const fd = fs.openSync(target, 'wx');
        created = true;
        try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.characters.push(record);
        this._save();
        result.imported.push(this._entry(record, false));
      } catch (error) {
        if (record) {
          const index = this.characters.indexOf(record);
          if (index !== -1) this.characters.splice(index, 1);
        }
        if (created) {
          try { fs.unlinkSync(target); } catch { /* A failed import never replaces an existing file. */ }
        }
        let message = error.message;
        if (error.code === 'ENOENT') message = '图片不存在，或原文件已移动。';
        else if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) message = '无法读取图片或写入形象库，请检查文件权限。';
        result.errors.push({ name: typeof file === 'string' ? path.basename(file) : '未知文件', message });
      }
    }
    return result;
  }

  rename(id, name) {
    const normalized = normalizeName(name);
    const builtin = BUILT_INS.find(record => record.id === id);
    const record = this.characters.find(entry => entry.id === id);
    if (!builtin && !record) throw libraryError('UNKNOWN_CHARACTER', '未找到该形象。');
    const previous = builtin ? this.nameOverrides[id] : record.name;
    if (builtin) this.nameOverrides[id] = normalized;
    else record.name = normalized;
    try { this._save(); } catch (error) {
      if (builtin) {
        if (previous === undefined) delete this.nameOverrides[id];
        else this.nameOverrides[id] = previous;
      } else record.name = previous;
      throw error;
    }
    return this.get(id);
  }

  remove(id) {
    if (BUILT_INS.some(record => record.id === id)) throw libraryError('BUILTIN_CHARACTER_PROTECTED', '内置形象不能删除，可以随时切换。');
    const index = this.characters.findIndex(record => record.id === id);
    if (index === -1) return false;
    const record = this.characters[index];
    const target = this._storedPath(record.file);
    let staged;
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw libraryError('UNSAFE_CHARACTER_FILE', '形象文件路径不安全，未删除任何文件。');
      staged = this._storedPath('.removed-' + crypto.randomUUID() + '.tmp');
      fs.renameSync(target, staged);
    }
    this.characters.splice(index, 1);
    try { this._save(); } catch (error) {
      this.characters.splice(index, 0, record);
      if (staged) fs.renameSync(staged, target);
      throw error;
    }
    // A locked recovery file may remain after a successful manifest update.
    // Keeping it is safer than undoing the user's selection or risking data loss.
    if (staged) { try { fs.unlinkSync(staged); } catch { /* harmless recovery copy */ } }
    return true;
  }

  migrateLegacy(file) {
    if (!file || typeof file !== 'string') return null;
    const result = this.importFiles([file]);
    if (result.errors.length) throw libraryError('LEGACY_CHARACTER_IMPORT_FAILED', '旧形象导入失败：' + result.errors[0].message);
    return result.imported[0] || result.existing[0] || null;
  }
}

module.exports = { CharacterLibrary, MAX_IMAGE_BYTES };
