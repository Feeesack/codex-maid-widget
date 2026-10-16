'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const portable = path.join(root, 'release/Codex-Maid-Widget-win32-x64');
const stage = path.join(root, 'tmp/installers/windows-staging');
const output = path.join(root, 'release/installers');
const compiler = process.env.ISCC_PATH || path.join(root, 'tmp/installer-tools/inno-6.7.3/ISCC.exe');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function inventory(directory) {
  const result = {};
  function walk(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) result[path.relative(directory, file).split(path.sep).join('/')] = hashFile(file);
      else throw new Error(`Unsupported link or special file: ${file}`);
    }
  }
  walk(directory);
  return result;
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}).`);
}

async function build() {
  const { checkVersions } = require('../check-versions.cjs');
  const version = checkVersions({ root });
  console.log(`Application versions aligned: Windows = macOS = ${version}`);
  if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
  const { extractFile } = await import('@electron/asar');
  const archive = path.join(portable, 'resources/app.asar');
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (manifest.version !== version) throw new Error('Windows portable version must match the shared release version.');
  const { verifyRuntimeArchive } = require('../../scripts/build.cjs');
  await verifyRuntimeArchive(archive);
  const before = inventory(portable);
  fs.mkdirSync(path.dirname(stage), { recursive: true });
  // The only cleared directory is a fixed build staging directory within tmp.
  if (!stage.startsWith(path.join(root, 'tmp') + path.sep)) throw new Error('Unsafe staging path.');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(portable, stage, { recursive: true, errorOnExist: true });
  const { stageIntegration } = require('../integration/prepare-payload.cjs');
  stageIntegration({ root, platform: 'win32', destination: path.join(stage, 'resources/integration') });
  const helper = path.join(stage, 'resources/installer');
  fs.mkdirSync(helper, { recursive: true });
  for (const file of ['lifecycle.ps1', 'INSTALLATION.txt']) fs.copyFileSync(path.join(__dirname, file), path.join(helper, file));
  for (const file of ['LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md']) fs.copyFileSync(path.join(root, file), path.join(helper, file));
  fs.cpSync(path.join(root, 'licenses'), path.join(helper, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(root, 'assets/app-icon.ico'), path.join(helper, 'app-icon.ico'));
  if (!fs.existsSync(compiler)) run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'bootstrap-inno.ps1')]);
  fs.mkdirSync(output, { recursive: true });
  run(compiler, [`/DPayloadDir=${stage}`, `/DOutputDir=${output}`, `/DAppVersion=${manifest.version}`, path.join(__dirname, 'installer.iss')]);
  const after = inventory(portable);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Original Windows portable files changed during installer build.');
  const name = `Codex-Maid-Widget-${manifest.version}-windows-x64-setup.exe`;
  const installer = path.join(output, name);
  const sha256 = hashFile(installer);
  const info = { platform: 'win32', arch: 'x64', appVersion: manifest.version, installer: name, sha256, bytes: fs.statSync(installer).size, originalPortable: before, installedPayload: inventory(stage) };
  fs.writeFileSync(installer + '.sha256', `${sha256}  ${name}\n`);
  fs.writeFileSync(installer + '.payload.json', JSON.stringify(info, null, 2) + '\n');
  console.log(`Verified unchanged Windows ${manifest.version} portable (${Object.keys(before).length} files).`);
  console.log(`Installer: ${installer}\nSHA256: ${sha256}`);
  return info;
}

if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build, inventory, hashFile };
