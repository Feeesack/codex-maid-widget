'use strict';
// Load the production main process with an isolated data directory supplied by
// the test runner. Suppress its window while exercising the native tray/IPC.
const { app, dialog, BrowserWindow } = require('electron');
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
      assert.equal(initial.characters.length,4);
      assert.equal(initial.activeCharacterId,'frost-glass-cheek');
      for(const [id,name] of [['frost-glass-idle','小龙娘-端庄'],['frost-glass-cheek','小龙娘-托腮']]) {
        const builtin=initial.characters.find(item=>item.id===id);assert.ok(builtin?.builtIn&&builtin.available);
        const selected=await run(`window.maid.selectCharacter(${JSON.stringify(id)})`);
        assert.equal(selected.activeCharacterId,id);assert.equal(selected.characterName,name);
        const rendered=await run(`(async()=>{const id=${JSON.stringify(id)};for(let attempt=0;attempt<40;attempt++){const image=document.getElementById('maid-image'),widget=document.getElementById('widget');if(image.src.endsWith('/'+id+'.png')&&widget.dataset.themeCharacter===id&&widget.dataset.themeSource==='builtin'){await image.decode();return {width:image.naturalWidth,height:image.naturalHeight,alt:image.alt};}await new Promise(resolve=>setTimeout(resolve,25));}return null;})()`);
        assert.deepEqual(rendered,{width:1381,height:1139,alt:name});
        await assert.rejects(run(`window.maid.removeCharacter(${JSON.stringify(id)})`));
      }
      const imported = await run('window.maid.importCharacters()');
      assert.equal(imported.importedCount,3);assert.equal(imported.errors.length,1);
      const custom = imported.state.characters.find(item => !item.builtIn);
      assert.ok(custom?.available);
      const renamed = await run(`window.maid.renameCharacter(${JSON.stringify(custom.id)},'我的测试形象')`);
      assert.equal(renamed.characters.find(item => item.id===custom.id).name,'我的测试形象');
      const selected = await run(`window.maid.selectCharacter(${JSON.stringify(custom.id)})`);
      assert.equal(selected.activeCharacterId,custom.id);
      const removed = await run(`window.maid.removeCharacter(${JSON.stringify(custom.id)})`);
      assert.equal(removed.activeCharacterId,'frost-glass-cheek');assert.equal(removed.characters.length,6);
      for(const other of removed.characters.filter(item=>!item.builtIn)) await run(`window.maid.removeCharacter(${JSON.stringify(other.id)})`);
      await assert.rejects(run(`window.maid.removeCharacter('mint-maid')`));
      const dragon = await run(`window.maid.selectCharacter('lilac-dragon')`);
      assert.equal(dragon.activeCharacterId,'lilac-dragon');
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await run(`document.getElementById('maid-image').src.includes('lilac-dragon.png')`),true);
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_MAID_HOME,'settings.json'),'utf8'));
      assert.equal(saved.activeCharacterId,'lilac-dragon');
      await assert.rejects(run("window.maid.previewCornerPeek({peekSidePercent:0})"));
      await run("window.maid.action('settings')");
      const pane = BrowserWindow.getAllWindows().find(candidate => candidate !== win && !candidate.isDestroyed());
      assert.ok(pane, 'production settings window opens for the preview check');
      if (pane.webContents.isLoadingMainFrame()) await new Promise(resolve => pane.webContents.once('did-finish-load', resolve));
      const inSettings = code => pane.webContents.executeJavaScript(code);
      await inSettings('window.maid.setSettings({peekAtCorners:true})');
      const beforePreview = await inSettings('window.maid.getState()');
      const savedFile = path.join(process.env.CODEX_MAID_HOME,'settings.json'), savedBytes = fs.readFileSync(savedFile);
      const fixedBounds = win.getBounds(), factor = fixedBounds.width / 380;
      assert.ok(['left','right'].includes(beforePreview.cornerDock.corner));
      for (const [side,bottom] of [[0,200],[200,0],[175,25]]) {
        const preview = await inSettings('window.maid.previewCornerPeek('+JSON.stringify({peekSidePercent:side,peekBottomPercent:bottom})+')');
        assert.deepEqual(preview.settings,beforePreview.settings);
        assert.equal(preview.settingsRevision,beforePreview.settingsRevision);
        assert.deepEqual(fs.readFileSync(savedFile),savedBytes,'live preview cannot write the settings file');
        assert.deepEqual(win.getBounds(),fixedBounds,'live preview cannot relayout the native window');
        assert.ok(Math.abs(preview.visualPose.offset.x-(beforePreview.cornerDock.corner==='left'?-48:48)*factor*side/100)<.00001);
        assert.ok(Math.abs(preview.visualPose.offset.y-56*factor*bottom/100)<.00001);
      }
      const cancelled = await inSettings('window.maid.previewCornerPeek(null)');
      assert.deepEqual(cancelled.visualPose,beforePreview.visualPose);
      await assert.rejects(run("window.maid.previewAppearance({scale:1.6})"));
      for (const [scale,opacity] of [[0.6,0.35],[1.6,1],[1.25,0.6]]) {
        const preview = await inSettings('window.maid.previewAppearance('+JSON.stringify({scale,opacity})+')');
        assert.deepEqual(preview.settings,beforePreview.settings);
        assert.equal(preview.settingsRevision,beforePreview.settingsRevision);
        assert.deepEqual(fs.readFileSync(savedFile),savedBytes,'appearance draft cannot write the settings file');
        const live = win.getBounds();
        assert.equal(live.width,Math.round(228*scale));assert.equal(live.height,Math.round(288*scale));
        assert.ok(Math.abs(win.getOpacity()-opacity)<.02,'native opacity follows the current draft');
        assert.equal(preview.cornerDock.corner,beforePreview.cornerDock.corner,'size previews retain the docked corner');
      }
      await inSettings('window.maid.previewAppearance(null)');
      assert.deepEqual(win.getBounds(),fixedBounds,'cancel restores preferred native size and the original dock');
      assert.ok(Math.abs(win.getOpacity()-beforePreview.settings.opacity)<.02);
      await inSettings('window.maid.previewAppearance({scale:1.6,opacity:0.35})');
      await inSettings('window.maid.previewCornerPeek({peekSidePercent:200,peekBottomPercent:0})');
      const closed = new Promise(resolve => pane.once('closed',resolve));pane.close();await closed;
      assert.deepEqual((await run('window.maid.getState()')).visualPose,beforePreview.visualPose,'closing settings discards a live preview');
      assert.deepEqual(fs.readFileSync(savedFile),savedBytes);
      await run('window.maid.setSettings({peekAtCorners:false})');
      assert.deepEqual(win.getBounds(),fixedBounds,'closing settings also restores appearance preview geometry');
      assert.ok(Math.abs(win.getOpacity()-beforePreview.settings.opacity)<.02);
      fs.writeFileSync(report,JSON.stringify({ok:true,previewChecked:true,appearancePreviewChecked:true}));
    } catch(error) { fs.writeFileSync(report,JSON.stringify({ok:false,error:error.message})); }
  });
});
require('../src/main.cjs');
