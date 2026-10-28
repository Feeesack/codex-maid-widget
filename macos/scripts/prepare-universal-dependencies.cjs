'use strict';
// npm installs optional native packages for the host CPU only. A universal
// application also needs the other CPU's locked Sharp packages. Fetch the
// exact lockfile tarballs and verify their integrity instead of asking npm to
// pretend that an arm64 host is x64 (npm 11 rejects that override).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function verifyIntegrity(bytes, integrity, name) {
  const [algorithm, expected] = String(integrity || '').split('-', 2);
  if (!algorithm || !expected) throw new Error('Missing package integrity: ' + name);
  const actual = crypto.createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) throw new Error('Package integrity mismatch: ' + name);
}

function prepare({ root = path.resolve(__dirname, '..') } = {}) {
  if (process.platform !== 'darwin') throw new Error('Universal dependency preparation requires macOS.');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const entries = [];
  for (const arch of ['arm64', 'x64']) {
    for (const name of [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`]) {
      const key = `node_modules/${name}`, entry = lock.packages[key];
      if (!entry?.version || !entry.integrity || !entry.resolved || !entry.cpu?.includes(arch) || !entry.os?.includes('darwin')) {
        throw new Error('Missing locked universal dependency: ' + name);
      }
      entries.push({ name, arch, entry });
    }
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-universal-dependencies-'));
  try {
    for (const { name, arch, entry } of entries) {
      const downloadDir = path.join(stage, arch, name.replaceAll('/', '-'));
      const extracted = path.join(downloadDir, 'extracted');
      fs.mkdirSync(downloadDir, { recursive: true });
      const packed = JSON.parse(execFileSync('npm', ['pack', `${name}@${entry.version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--json', '--pack-destination', downloadDir], {
        cwd: root, encoding: 'utf8', windowsHide: true,
      }));
      const archive = path.join(downloadDir, packed[0].filename);
      const bytes = fs.readFileSync(archive);
      verifyIntegrity(bytes, entry.integrity, name);
      fs.mkdirSync(extracted);
      execFileSync('tar', ['-xzf', archive, '-C', extracted], { windowsHide: true });
      const source = path.join(extracted, 'package');
      const target = path.join(root, 'node_modules', ...name.split('/'));
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      if (manifest.version !== entry.version) throw new Error('Package version differs from lock: ' + name);
      if (fs.existsSync(target)) {
        const current = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
        if (current.version !== entry.version) throw new Error('Installed native dependency differs from lock: ' + name);
      } else fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    }
    return { verified: true, architectures: ['arm64', 'x64'], packages: entries.length, source: 'npm-pack-integrity-checked' };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try { console.log(JSON.stringify(prepare())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare, verifyIntegrity };
