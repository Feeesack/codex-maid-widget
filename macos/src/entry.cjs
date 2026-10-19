'use strict';
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { prepareDataHome } = require('./data-home.cjs');
require('./runtime-environment.cjs').applyRuntimeEnvironmentArguments(process.argv);
app.setName('codex-maid-widget');
const homeArgument = process.argv.find(value => value.startsWith('--maid-home='));
const dataEnv = homeArgument ? {...process.env,CODEX_MAID_HOME:homeArgument.slice('--maid-home='.length)} : process.env;
const dataDir = prepareDataHome({env:dataEnv,legacyDir:app.getPath('userData')});
// Use one physical directory across Store-app and Explorer launch contexts.
process.env.CODEX_MAID_HOME = dataDir;
fs.mkdirSync(dataDir,{recursive:true});
app.setPath('userData',dataDir);
if (process.argv.includes('--watch-codex')) {
  require('./desktop-watcher.cjs').run({ app, dataDir, settingsFile: path.join(dataDir, 'settings.json'),
    executable: process.execPath, appRoot: path.join(__dirname, '..'), packaged: app.isPackaged });
} else {
  require('./main.cjs');
}
