'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The accepted Windows application defines the shared product release version.
// Dependencies retain independent versions; the bundled plugin follows the app.
function checkVersions({ root = path.resolve(__dirname, '..') } = {}) {
  root = path.resolve(root);
  const read = relative => {
    try { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
    catch (error) { throw new Error(`Cannot check application versions: ${relative}: ${error.message}`); }
  };
  const windows = read('package.json');
  const windowsLock = read('package-lock.json');
  const mac = read('macos/package.json');
  const macLock = read('macos/package-lock.json');
  const versions = [
    ['package.json version (Windows authority)', windows.version],
    ['package-lock.json version', windowsLock.version],
    ['package-lock.json packages[""].version', windowsLock.packages?.['']?.version],
    ['macos/package.json version', mac.version],
    ['macos/package-lock.json version', macLock.version],
    ['macos/package-lock.json packages[""].version', macLock.packages?.['']?.version],
    ['Windows plugin version', read('plugins/codex-maid-widget/.codex-plugin/plugin.json').version],
    ['macOS plugin version', read('macos/plugins/codex-maid-widget/.codex-plugin/plugin.json').version],
  ];
  const expected = windows.version;
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expected)
      || versions.some(([, actual]) => actual !== expected)) {
    throw new Error('Application versions must match the Windows package.json version before building.\n'
      + versions.map(([label, value]) => `  ${label}: ${JSON.stringify(value) ?? 'missing'}`).join('\n'));
  }
  return expected;
}

if (require.main === module) {
  try { console.log(`Application versions aligned: Windows = macOS = ${checkVersions()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkVersions };
