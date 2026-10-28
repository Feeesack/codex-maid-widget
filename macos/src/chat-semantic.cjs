'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module'), { pathToFileURL } = require('node:url');
const manifest = require('./chat-semantic-manifest.cjs');
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
function discoverResources({ resourceRoot, env = process.env, resourcesPath = process.resourcesPath, sourceRoot = path.resolve(__dirname, '..') } = {}) {
  const candidates = resourceRoot ? [resourceRoot] : env.CODEX_MAID_SEMANTIC_RESOURCES ? [env.CODEX_MAID_SEMANTIC_RESOURCES] : [resourcesPath && path.join(resourcesPath, 'chat-semantic'), path.join(sourceRoot, 'resources', 'chat-semantic')].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { const real = fs.realpathSync(candidate); if (fs.statSync(real).isDirectory()) return real; } catch {}
  }
  return null;
}
async function verifyResources(root) {
  if (!root) throw new Error('CHAT_SEMANTIC_RESOURCES_UNAVAILABLE');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(root, 'model', ...name.split('/')), stat = await fs.promises.lstat(file);
    for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
      if ((await fs.promises.lstat(parent)).isSymbolicLink()) throw new Error('CHAT_SEMANTIC_RESOURCE_CHANGED');
      if (path.dirname(parent) === parent) throw new Error('CHAT_SEMANTIC_RESOURCE_CHANGED');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) throw new Error('CHAT_SEMANTIC_RESOURCE_CHANGED');
    const real = await fs.promises.realpath(file), relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CHAT_SEMANTIC_RESOURCE_CHANGED');
    const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    if (hash.digest('hex') !== expected.sha256) throw new Error('CHAT_SEMANTIC_RESOURCE_CHANGED');
  }
  return true;
}
class SemanticEncoder {
  constructor(options = {}) { this.root = discoverResources(options); this.state = this.root ? 'loading' : 'unavailable'; this.reason = this.root ? 'model-cold' : 'resources-missing'; this.promise = null; this.pipeline = null; this.closed = false; }
  warm() {
    if (this.closed) return Promise.resolve(false);
    if (this.promise) return this.promise;
    this.promise = (async () => {
      await verifyResources(this.root);
      const resolvers = [require, ...(process.resourcesPath ? [createRequire(path.join(process.resourcesPath, 'semantic-loader.cjs'))] : [])];
      let target; for (const resolver of resolvers) { try { target = resolver.resolve(manifest.runtime); break; } catch {} }
      if (!target) throw new Error('CHAT_SEMANTIC_RUNTIME_UNAVAILABLE');
      const runtimeManifest = JSON.parse(await fs.promises.readFile(path.resolve(path.dirname(target), '../package.json'), 'utf8'));
      if (runtimeManifest.version !== manifest.runtimeVersion) throw new Error('CHAT_SEMANTIC_RUNTIME_VERSION');
      const loaded = await import(pathToFileURL(target).href), { pipeline, env } = loaded.default || loaded;
      env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false; env.useBrowserCache = false;
      env.localModelPath = this.root + path.sep;
      const loadedPipeline = await pipeline('feature-extraction', path.join(this.root, 'model'), { dtype: manifest.dtype, device: 'cpu', local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
      if (this.closed) { await loadedPipeline?.dispose?.(); return false; }
      this.pipeline = loadedPipeline;
      this.state = 'ready'; this.reason = null; return true;
    })().catch(error => { this.state = 'unavailable'; this.reason = /^CHAT_SEMANTIC_/.test(error.message) ? error.message : 'model-load-failed'; return false; });
    return this.promise;
  }
  tokenCount(text, query = false) { if (!this.pipeline) throw new Error('CHAT_SEMANTIC_NOT_READY'); return this.pipeline.tokenizer.encode((query ? manifest.queryPrefix : manifest.passagePrefix) + text).length; }
  async encode(texts, { query = false } = {}) {
    if (!await this.warm()) throw new Error('CHAT_SEMANTIC_UNAVAILABLE');
    if (!Array.isArray(texts) || texts.length > 16 || texts.some(text => typeof text !== 'string' || this.tokenCount(text, query) > manifest.maximumTokens)) throw new Error('CHAT_SEMANTIC_INPUT_LIMIT');
    const result = await this.pipeline(texts.map(text => (query ? manifest.queryPrefix : manifest.passagePrefix) + text), { pooling: 'mean', normalize: true, truncation: false });
    return result.tolist().map(vector => Float32Array.from(vector));
  }
  status() { return { semantic: this.state, semanticReason: this.reason, modelRevision: manifest.revision, modelFingerprint: fingerprint }; }
  async close() {
    this.closed = true;
    // Never terminate a worker while ONNX is still constructing a native
    // session. Await the same warm promise first, then dispose the completed
    // pipeline in its owning thread.
    try { await this.promise; } catch {}
    try { await this.pipeline?.dispose?.(); } catch {}
    this.pipeline = null;
  }
}
module.exports = { SemanticEncoder, discoverResources, verifyResources, manifest, fingerprint };
