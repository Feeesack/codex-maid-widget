'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Observe metadata only. Authentication contents, keys and tokens are never read.
function watchAuthChanges(codexHome, onChange, { interval = 1500 } = {}) {
  const file = path.join(codexHome, 'auth.json');
  const changed = (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs ||
        current.size !== previous.size || current.ino !== previous.ino) onChange();
  };
  fs.watchFile(file, { interval, persistent: false }, changed);
  return () => fs.unwatchFile(file, changed);
}
module.exports = { watchAuthChanges };
