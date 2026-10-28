'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const manifest = require('../src/chat-semantic-manifest.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function rejectAncestorLinks(target) {
  for (let current = path.resolve(target);;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('CHAT_SEMANTIC_RESOURCE_LINK');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function prepare({ destination = path.resolve(__dirname, '../resources/chat-semantic'), download = false } = {}) {
  destination = path.resolve(destination);
  rejectAncestorLinks(destination);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(destination, 'model', ...name.split('/'));
    rejectAncestorLinks(file);
    if (fs.existsSync(file)) { const bytes = fs.readFileSync(file); if (bytes.length === expected.size && hash(bytes) === expected.sha256) continue; }
    if (!download) throw new Error('CHAT_SEMANTIC_RESOURCE_MISSING_OR_CHANGED');
    const response = await fetch(`https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${name}`, { signal: AbortSignal.timeout(240000) });
    if (!response.ok) throw new Error('CHAT_SEMANTIC_DOWNLOAD_FAILED');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error('CHAT_SEMANTIC_DOWNLOAD_HASH');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { verified: true, model: manifest.model, revision: manifest.revision, files: Object.keys(manifest.files).length };
}
if (require.main === module) prepare({ download: process.argv.includes('--download'), ...(process.argv.includes('--destination') ? { destination: process.argv[process.argv.indexOf('--destination') + 1] } : {}) }).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, rejectAncestorLinks };
