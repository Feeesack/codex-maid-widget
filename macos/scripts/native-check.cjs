'use strict';
// Load the production main process with an isolated data directory supplied by
// the test runner. Suppress its window while exercising the native tray/IPC.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.CODEX_MAID_HOME) throw new Error('Run native-check with an isolated CODEX_MAID_HOME.');
app.setPath('userData', process.env.CODEX_MAID_HOME);
if (process.env.CODEX_MAID_TEST_IMPORT) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: JSON.parse(process.env.CODEX_MAID_TEST_IMPORT) });
app.on('browser-window-created', (_event, win) => {
  win.on('show', () => win.hide());
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().endsWith('/index.html')) return;
    fs.writeFileSync(path.join(process.env.CODEX_MAID_HOME,'native-window.json'), JSON.stringify(win.getBounds()));
    if (!process.env.CODEX_MAID_TEST_IMPORT) return;
    const report = path.join(process.env.CODEX_MAID_HOME,'gallery-check.json');
    try {
      const run = code => win.webContents.executeJavaScript(code);
      const fixturePaths = JSON.parse(process.env.CODEX_MAID_TEST_IMPORT);
      const gifFile = fixturePaths.find(file=>file.endsWith('.gif'));
      const webpFile = fixturePaths.find(file=>file.endsWith('.webp'));
      fs.writeFileSync(gifFile,Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
      const webp = await run(`(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='#52a98b';ctx.fillRect(0,0,2,2);return canvas.toDataURL('image/webp').split(',')[1]})()`);
      fs.writeFileSync(webpFile,Buffer.from(webp,'base64'));
      const initial = await run('window.maid.getState()');
      assert.equal(initial.characters.length,2);
      assert.equal(initial.activeCharacterId,'lilac-dragon');
      const imported = await run('window.maid.importCharacters()');
      assert.equal(imported.importedCount,3);assert.equal(imported.errors.length,1);
      const custom = imported.state.characters.find(item => !item.builtIn);
      assert.ok(custom?.available);
      const renamed = await run(`window.maid.renameCharacter(${JSON.stringify(custom.id)},'我的测试形象')`);
      assert.equal(renamed.characters.find(item => item.id===custom.id).name,'我的测试形象');
      const selected = await run(`window.maid.selectCharacter(${JSON.stringify(custom.id)})`);
      assert.equal(selected.activeCharacterId,custom.id);
      const removed = await run(`window.maid.removeCharacter(${JSON.stringify(custom.id)})`);
      assert.equal(removed.activeCharacterId,'lilac-dragon');assert.equal(removed.characters.length,4);
      for(const other of removed.characters.filter(item=>!item.builtIn)) await run(`window.maid.removeCharacter(${JSON.stringify(other.id)})`);
      await assert.rejects(run(`window.maid.removeCharacter('mint-maid')`));
      const dragon = await run(`window.maid.selectCharacter('lilac-dragon')`);
      assert.equal(dragon.activeCharacterId,'lilac-dragon');
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await run(`document.getElementById('maid-image').src.includes('lilac-dragon.png')`),true);
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_MAID_HOME,'settings.json'),'utf8'));
      assert.equal(saved.activeCharacterId,'lilac-dragon');
      fs.writeFileSync(report,JSON.stringify({ok:true}));
    } catch(error) { fs.writeFileSync(report,JSON.stringify({ok:false,error:error.message})); }
  });
});
require('../src/main.cjs');
