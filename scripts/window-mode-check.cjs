'use strict';
const { app, BrowserWindow, screen, ipcMain, desktopCapturer } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib'), { spawn } = require('node:child_process');
if (!process.env.CODEX_MAID_WINDOW_CHECK) throw Error('Run scripts/check-window-mode.cjs with an isolated profile.');
const config = JSON.parse(fs.readFileSync(process.env.CODEX_MAID_WINDOW_CHECK, 'utf8')), profile = path.resolve(config.profile);
assert.equal(path.resolve(process.env.CODEX_HOME), path.join(profile, 'codex'));
assert.equal(path.resolve(process.env.CODEX_MAID_HOME), path.join(profile, 'widget'));
assert.equal(path.resolve(process.env.USERPROFILE), profile);
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, path.join(profile, name));
for (const name of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) {
  const directory = path.join(profile, name[0].toUpperCase() + name.slice(1)); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
}
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const { CodexWindowMode } = require('../src/window-mode.cjs');
const { CodexWindowProvider } = require('../src/codex-window.cjs');
for (const file of ['data-home.cjs', 'codex-data.cjs', 'auth-change-watch.cjs', 'main.cjs']) assert.equal(Object.keys(require.cache).some(name => name.endsWith(path.sep + 'src' + path.sep + file)), false, 'Unexpected application dependency: ' + file);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 12000) { const deadline = Date.now() + timeout; do { if (await predicate()) return; await wait(35); } while (Date.now() < deadline); throw Error(message); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', file))).digest('hex'); }
app.whenReady().then(async () => {
  const report = { ok: false, platform: process.platform, electron: process.versions.electron, factor: config.factor,
    isolation: { profile: true, trustedRootsReplacedWithSelfCreatedHostPid: true, appStartupNotLoaded: true },
    sourceSha256: Object.fromEntries(['window-mode.cjs', 'window-topmost.cjs', 'window-containment.cjs', 'codex-window.cjs', 'window-visibility.cjs'].map(file => [file, sha(file)])),
    realNativeChild: true, realProductionProvider: true, cases: [] };
  let hostProcess, occluderProcess, hostId, hostPid, widget, mode, provider, probe, queryKind = 'known', lastNative = null;
  let queries = 0, factories = 0, recreates = 0, request = 0;
  const size = { width: 228, height: 288 }, readyFile = path.join(profile, 'host-ready.json'), commandFile = path.join(profile, 'host-command.json'), responseFile = path.join(profile, 'host-response.json');
  fs.writeFileSync(commandFile, '{}');
  async function hostCommand(action, extra = {}) { const id = ++request; fs.writeFileSync(commandFile, JSON.stringify({ id, action, ...extra })); await until(() => readJson(responseFile)?.id === id, 'Self-host command failed: ' + action); assert.equal(readJson(responseFile).ok, true); }
  function createProvider(injectFailures = true) {
    const value = new CodexWindowProvider({ widgetHandle: widget.getNativeWindowHandle(), timeout: 12000, spawn(file, args, options) {
      const index = args.indexOf('-EncodedCommand') + 1; let bootstrap = Buffer.from(args[index], 'base64').toString('utf16le');
      const compressed = bootstrap.match(/FromBase64String\('([^']+)'\)/); assert.ok(compressed, 'Native bootstrap changed.');
      let script = zlib.gunzipSync(Buffer.from(compressed[1], 'base64')).toString('utf8'), replacements = 0;
      script = script.replace(/var roots = ValidatedRoots\((?:true|false)\);/g, () => { replacements++; return 'var roots = new HashSet<uint> { ' + hostPid + ' };'; });
      assert.ok(replacements >= 3, 'Native checks must use only the self-created process.');
      // Geometry is emitted ONLY by the test worker; the production transport
      // discards it. The real C# provider and adapter remain otherwise intact.
      script = script.replace('return answer;', `Rect fixtureRect; GetWindowRect(widget,out fixtureRect);
        answer["fixtureWidgetBounds"]=new Dictionary<string,object>{{"x",fixtureRect.Left},{"y",fixtureRect.Top},{"width",fixtureRect.Right-fixtureRect.Left},{"height",fixtureRect.Bottom-fixtureRect.Top}};
        answer["fixtureWidgetStyle"]=ownWidget?GetLong(widget,-16).ToInt64():0;
        answer["fixtureWidgetExStyle"]=ownWidget?GetLong(widget,-20).ToInt64():0; return answer;`);
      script = script.replace('public static object SetOwner(', `
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hwnd,bool altTab);
    public static object FixtureFocusWindow(long value,uint pid){var hwnd=new IntPtr(value);bool own=IsWindow(hwnd)&&Pid(hwnd)==pid;
      if(own)SwitchToThisWindow(hwnd,true);return new Dictionary<string,object>{{"known",true},{"supported",true},{"ok",own}};}
    public static object FixtureHideWidget(){var hwnd=new IntPtr(${widget.getNativeWindowHandle().readBigUInt64LE()});
      bool own=IsWindow(hwnd)&&Pid(hwnd)==${process.pid};if(own)ShowWindow(hwnd,0);
      return new Dictionary<string,object>{{"known",true},{"supported",true},{"ok",own}};}
    public static object FixtureClosePicker(){EnumWindows(delegate(IntPtr hwnd,IntPtr unused){
      if(Pid(hwnd)==${hostPid} && GetWindow(hwnd,4)==new IntPtr(${hostId})){var name=new System.Text.StringBuilder(256);
      if(GetClassName(hwnd,name,name.Capacity)>0&&name.ToString()=="#32770")PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);}return true;},IntPtr.Zero);
      return new Dictionary<string,object>{{"known",true},{"supported",true},{"ok",true}};}
    public static object SetOwner(`);
      script = script.replace("elseif ($request -match '^owner", () => "elseif ($request -match '^fixture-focus ([1-9][0-9]*) ([1-9][0-9]*)$') { $answer = [MaidWindowNative.MaidCodexWindow]::FixtureFocusWindow([long]$Matches[1],[uint32]$Matches[2]) }\n    elseif ($request -eq 'fixture-hide-widget') { $answer = [MaidWindowNative.MaidCodexWindow]::FixtureHideWidget() }\n    elseif ($request -eq 'fixture-close-picker') { $answer = [MaidWindowNative.MaidCodexWindow]::FixtureClosePicker() }\n    elseif ($request -match '^owner");
      bootstrap = bootstrap.replace(compressed[1], zlib.gzipSync(Buffer.from(script)).toString('base64'));
      const next = [...args]; next[index] = Buffer.from(bootstrap, 'utf16le').toString('base64'); const child = spawn(file, next, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', chunk => fs.appendFileSync(path.join(profile, 'native-worker-stderr.log'), chunk));
      let pending = ''; child.stdout.on('data', chunk => { pending += chunk.toString('utf8'); let newline;
        while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline).replace(/^\uFEFF/, '').trim(); pending = pending.slice(newline + 1);
          try { const item = JSON.parse(line); if (item.fixtureWidgetBounds) lastNative = { bounds: item.fixtureWidgetBounds, style: item.fixtureWidgetStyle,
            exStyle: item.fixtureWidgetExStyle, parentId: item.widgetParentId, visible: item.widgetVisible, parented: item.widgetParented }; } catch {} }
      }); return child;
    } });
    if (injectFailures) { const query = value.query.bind(value); value.query = async () => { queries++;
      if (queryKind === 'unknown') return { known: false, supported: true }; if (queryKind === 'throw') throw Error('Isolated query failure.');
      return query();
    }; } return value;
  }
  function newMode() { return new CodexWindowMode({ widget, screen, getSize: () => size, intervalMs: 50, staleAfterMs: 1600,
    topmostProviderFactory: () => createProvider(false),
    providerFactory: () => { factories++; provider = createProvider(); return provider; }, onRecreate: () => { recreates++; } }); }
  async function observation() { const value = await provider.query(); assert.equal(value.known, true, 'Native self-host observation unavailable.'); return value; }
  function inside(a, b) { return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1; }
  async function settled() {
    await until(async () => { if (widget.isDestroyed() || mode.getState().reason !== 'contained') return false;
      const value = await observation(), host = value.windows.find(item => item.id === hostId);
      return value.widgetParented && value.widgetVisible && host?.widgetAboveHost && lastNative && inside(lastNative.bounds, host.bounds);
    }, 'Native child did not settle visibly inside host.');
    const host = (await observation()).windows.find(item => item.id === hostId), expected = screen.dipToScreenRect(null, { ...mode.getBounds(), ...size }), actual = lastNative.bounds;
    assert.ok(Math.abs(actual.width - expected.width) <= 1 && Math.abs(actual.height - expected.height) <= 1, 'Native child dimensions drifted.');
    assert.equal(widget.webContents.getZoomFactor(), 1); assert.equal(widget.isAlwaysOnTop(), false);
    assert.equal((lastNative.exStyle & 0x00000008) !== 0, false, 'Embedded child must not be globally topmost.');
    const presence = await widget.webContents.executeJavaScript('({opacity:+getComputedStyle(document.body).opacity,scale:parseFloat(getComputedStyle(document.body).scale)||1,inert:document.body.inert})');
    assert.equal(presence.opacity, 1); assert.equal(presence.scale, 1); assert.equal(presence.inert, false); return host;
  }
  function capture(name) { report.cases.push({ name, state: mode?.getState(), native: lastNative, alive: !widget.isDestroyed() }); }
  async function standaloneTopmost(expected) {
    await until(() => !mode.enabled && !mode.embedded && mode.getState().topmost.verified &&
      mode.getState().topmost.desired === expected, 'Native standalone topmost verification failed.');
    probe = createProvider(false); const value = await probe.query();
    assert.equal(value.known, true); assert.equal(value.widgetParented, false); assert.equal(value.widgetParentId, '0');
    assert.equal(value.widgetTopmost, expected);
    assert.equal((lastNative.exStyle & 0x00000008) !== 0, expected, 'Actual HWND ExStyle disagrees with the requested topmost state.');
    probe.close(); probe = null;
  }
  async function composed(name) { await wait(250);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1400, height: 1100 }, fetchWindowIcons: false });
    const own = sources.find(item => item.id === 'window:' + hostId + ':0'); assert.ok(own, 'Self-host thumbnail missing.');
    const pixels = own.thumbnail.toBitmap(); let purple = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 140 && pixels[i + 1] > 50 && pixels[i + 1] < 130 && pixels[i + 2] > 85 && pixels[i + 2] < 170) purple++;
    assert.ok(purple > 5000, 'Pet surface missing from HOST DWM thumbnail.'); fs.writeFileSync(path.join(profile, name + '.png'), own.thumbnail.toPNG());
    report.cases.push({ name, hostDwmPetPixels: purple, thumbnailSize: own.thumbnail.getSize() });
  }
  try {
    const display = screen.getPrimaryDisplay(); assert.ok(Math.abs(display.scaleFactor - config.factor) < .01, 'DPI factor inactive.');
    const area = display.workArea, bounds = { x: area.x + 30, y: area.y + 30, width: Math.min(760, area.width - 80), height: Math.min(650, area.height - 80) };
    assert.ok(bounds.width >= 500 && bounds.height >= 450, 'Display too small.'); const standalone = { x: area.x + 7, y: area.y + 9 };
    const hostConfig = path.join(profile, 'host-config.json'); fs.writeFileSync(hostConfig, JSON.stringify({ profile: path.join(profile, 'host'), bounds, readyFile, commandFile, responseFile }));
    const env = { ...process.env, CODEX_MAID_TEST_HOST: hostConfig }; delete env.ELECTRON_RUN_AS_NODE;
    hostProcess = spawn(process.execPath, [path.join(__dirname, 'fixtures/window-mode-host.cjs'), '--force-device-scale-factor=' + config.factor], { cwd: path.dirname(__dirname), env, windowsHide: true, stdio: 'ignore' });
    await until(() => readJson(readyFile)?.id, 'Separate host did not start.'); ({ id: hostId, pid: hostPid } = readJson(readyFile)); assert.notEqual(hostPid, process.pid);
    const createWidget = () => new BrowserWindow({ ...standalone, ...size, frame: false, show: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, '../src/preload.cjs'), backgroundThrottling: false } });
    widget = createWidget();
    ipcMain.handle('state', () => ({ windowContainment: mode?.getState() })); ipcMain.on('pointer-region', () => {}); mode = newMode();
    mode.configure(false, { position: standalone, alwaysOnTop: true }); assert.equal(factories, 0); capture('default-off-no-provider');
    await standaloneTopmost(true); capture('standalone-native-topmost-on');
    mode.configure(false, { alwaysOnTop: false }); await standaloneTopmost(false); capture('standalone-native-topmost-off');
    mode.configure(true, { position: standalone, alwaysOnTop: true }); await widget.loadFile(path.join(__dirname, '../test/window-presence.html'));
    await settled(); capture('initial-hidden-show-projects-correctly'); await composed('host-composes-child');
    const beforeMove = mode.getArea(), initial = mode.getBounds(), moved = { ...bounds, x: bounds.x + 53, y: bounds.y + 37 };
    await hostCommand('bounds', { bounds: moved }); await until(() => mode.getArea()?.x !== beforeMove.x, 'Host move not observed.'); await settled();
    assert.ok(Math.abs(mode.getBounds().x - initial.x - (mode.getArea().x - beforeMove.x)) <= 2); capture('host-move');
    const smaller = { ...moved, width: moved.width - 100, height: moved.height - 70 }; await hostCommand('bounds', { bounds: smaller });
    await until(() => mode.getArea()?.width < beforeMove.width, 'Host resize not observed.'); await settled(); await composed('resize-repairs-child-stack');
    for (const p of [{ x: -100000, y: -100000 }, { x: 100000, y: -100000 }, { x: 100000, y: 100000 }, { x: -100000, y: 100000 }]) { assert.equal(mode.moveTo(p.x, p.y), true); await settled(); }
    capture('fixed-size-drag-clamps-four-edges');
    const anchor = mode.getBounds(), areaBeforePicker = mode.getArea(); await hostCommand('picker');
    await until(async () => (await observation()).windows.find(item => item.id === hostId)?.modal, 'Own native picker did not open.');
    await settled(); assert.deepEqual(mode.getArea(), areaBeforePicker); assert.deepEqual(mode.getBounds(), anchor); capture('native-picker-keeps-main-child-and-anchor');
    assert.equal((await provider.request('fixture-close-picker', 'owner')).ok, true);
    await until(async () => !(await observation()).windows.find(item => item.id === hostId)?.modal, 'Own picker did not close.');
    await settled(); assert.deepEqual(mode.getBounds(), anchor); await composed('picker-close-preserves-pet');
    // Exercise the actual cross-process child-HWND focus while a separate
    // Chromium host continually restores its own DOM editor focus. No real
    // Codex window, data-home, account or conversation participates.
    await hostCommand('focus');
    assert.equal((await provider.request('fixture-focus ' + hostId + ' ' + hostPid, 'owner')).ok, true);
    await until(async () => (await observation()).foregroundPid === hostPid, 'Synthetic editor host did not acquire foreground before the test.');
    await hostCommand('editor-focus-loop');
    await widget.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend",\'<textarea id="fixture-editor" aria-label="Synthetic widget input"></textarea>\')');
    const focusRemapsBefore = mode.visibility.snapshot().remaps;
    assert.equal(await mode.setInputActive(true), true);
    assert.equal((await observation()).widgetParented, true);
    assert.equal(mode.nativeChild, true);
    widget.webContents.focus();
    await widget.webContents.executeJavaScript('document.getElementById("fixture-editor").focus()');
    await until(async () => (await observation()).foregroundPid === hostPid && await widget.webContents.executeJavaScript('document.hasFocus()&&document.activeElement.id==="fixture-editor"'), 'Embedded editor did not acquire native and DOM focus.');
    const editorQueries = queries;
    for (let index = 0; index < 12; index++) {
      widget.webContents.sendInputEvent({ type: 'char', keyCode: 'a' });
      await wait(55);
      assert.equal((await observation()).foregroundPid, hostPid, 'Host focus changed during embedded widget typing.');
    }
    assert.equal(await widget.webContents.executeJavaScript('document.getElementById("fixture-editor").value'), 'a'.repeat(12));
    assert.ok(queries >= editorQueries + 4); assert.equal(mode.enabled, true); assert.equal(mode.nativeChild, true);
    assert.equal(mode.visibility.snapshot().remaps, focusRemapsBefore, 'Input focus must not remap or hide/show the widget.');
    capture('editor-typing-retains-native-child-and-dom-focus-through-host-focus-loop');
    const editorBounds = mode.getBounds(), editorArea = mode.getArea();
    await hostCommand('bounds', { bounds: { ...smaller, x: smaller.x + 17, y: smaller.y + 13 } });
    await until(() => mode.getArea()?.x !== editorArea.x, 'Detached editor did not keep following its host.');
    assert.equal((await observation()).foregroundPid, hostPid);
    assert.ok(Math.abs(mode.getBounds().x - editorBounds.x - 17) <= 2); capture('editor-follow-update-does-not-activate-host');
    await hostCommand('focus');
    await until(async () => (await observation()).foregroundPid === hostPid, 'Synthetic host did not regain focus.');
    assert.equal(await mode.setInputActive(false), true); await settled();
    assert.equal(mode.visibility.snapshot().remaps, focusRemapsBefore, 'Input blur must not remap or hide/show the widget.');
    for (let index = 0; index < 4; index++) { await wait(65); assert.equal((await observation()).foregroundPid, hostPid, 'Reattachment stole focus back from host.'); }
    await hostCommand('editor-focus-stop'); await hostCommand('bounds', { bounds: smaller });
    await until(() => mode.getArea()?.x === editorArea.x, 'Host restoration after editing was not observed.'); await settled();
    assert.deepEqual(mode.getBounds(), anchor); capture('editor-blur-reattaches-without-taking-host-focus');
    const focusMain = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
    const focusStart = focusMain.indexOf("  handle('widget-input-active',"), focusEnd = focusMain.indexOf('  const chatHandle', focusStart);
    require('node:vm').runInNewContext(focusMain.slice(focusStart, focusEnd), { widget, windowMode: mode, widgetInputSequence: 0,
      // Synthetic Tab is dispatched to this fixture's own textarea; bind its
      // pointer witness to the same surface instead of moving the user's cursor.
      screen: { getCursorScreenPoint: () => { const b = widget.getBounds(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } },
      settingsWindow: null, chatWindow: null, quitting: false, t: value => value,
      handle: (name, handler) => ipcMain.handle(name, async (event, ...args) => {
        (report.keyboardEvents ||= []).push({ args, focused: widget.isFocused(), detached: mode.inputDetached, transition: mode.inputTransition });
        const result = await handler(event, ...args);
        report.keyboardEvents.push({ result, focused: widget.isFocused(), detached: mode.inputDetached, transition: mode.inputTransition });
        return result;
      }) }, { filename: 'isolated-production-focus-ipc.cjs' });
    await widget.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/widget-input-focus.js'), 'utf8'));
    await widget.webContents.executeJavaScript('window.fixtureEditorFocus=MaidInputFocus.connect({window,document,maid:window.maid});document.body.tabIndex=0;document.body.focus()');
    widget.focus(); widget.webContents.focus();
    await widget.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true}));document.getElementById("fixture-editor").focus()');
    await until(async () => mode.nativeChild && (await observation()).foregroundPid === hostPid &&
      await widget.webContents.executeJavaScript('document.hasFocus()&&document.activeElement.id==="fixture-editor"'), 'Keyboard editor activation was cancelled by native reparent blur.');
    capture('editor-tab-enters-through-production-ipc-and-renderer');
    await hostCommand('focus'); await until(() => mode.nativeChild, 'Renderer window blur did not release keyboard editing.'); await settled();
    await widget.webContents.executeJavaScript('window.fixtureEditorFocus.dispose()'); ipcMain.removeHandler('widget-input-active');
    mode.hide(); await until(async () => !(await observation()).widgetVisible, 'Manual hide failed.'); const hiddenQueries = queries;
    await until(() => queries >= hiddenQueries + 3, 'No polling while hidden.'); assert.equal((await observation()).widgetVisible, false); capture('manual-hide-stable');
    mode.show(); await settled(); capture('explicit-show-recovers-child');
    assert.equal((await provider.request('fixture-hide-widget', 'owner')).ok, true);
    await until(async () => !(await observation()).widgetVisible, 'Native visibility fault injection failed.'); capture('native-hidden-fault');
    await settled(); capture('native-visibility-watchdog-recovers');
    // A different, self-created process covers the right half of the host.
    // The pet is anchored on the left after the four-edge drag above.
    const otherDirectory = path.join(profile, 'half-window'); fs.mkdirSync(otherDirectory, { recursive: true });
    const otherReady = path.join(otherDirectory, 'ready.json'), otherCommand = path.join(otherDirectory, 'command.json'), otherResponse = path.join(otherDirectory, 'response.json');
    const otherConfig = path.join(otherDirectory, 'config.json'); fs.writeFileSync(otherCommand, '{}');
    fs.writeFileSync(otherConfig, JSON.stringify({ profile: path.join(otherDirectory, 'profile'), focus: true,
      bounds: { x: smaller.x + Math.round(smaller.width / 2), y: smaller.y, width: Math.max(300, Math.round(smaller.width / 2)), height: smaller.height },
      readyFile: otherReady, commandFile: otherCommand, responseFile: otherResponse }));
    occluderProcess = spawn(process.execPath, [path.join(__dirname, 'fixtures/window-mode-host.cjs'), '--force-device-scale-factor=' + config.factor],
      { cwd: path.dirname(__dirname), env: { ...env, CODEX_MAID_TEST_HOST: otherConfig }, windowsHide: true, stdio: 'ignore' });
    await until(() => readJson(otherReady)?.id, 'Own half-window process did not start.');
    fs.writeFileSync(otherCommand, JSON.stringify({ id: 1, action: 'focus' }));
    const otherPid = readJson(otherReady).pid;
    assert.equal(otherPid, occluderProcess.pid, 'Foreground target must be this check own spawned process.');
    assert.equal((await provider.request('fixture-focus ' + readJson(otherReady).id + ' ' + otherPid, 'owner')).ok, true);
    let foregroundOther = false; const focusDeadline = Date.now() + 2500;
    do { if ((await observation()).foregroundPid === otherPid) { foregroundOther = true; break; } await wait(50); } while (Date.now() < focusDeadline);
    if (foregroundOther) { await settled(); const covered = await observation();
      assert.equal(covered.widgetParentId, hostId); assert.equal(covered.widgetVisible, true); assert.equal((lastNative.style & 0x10000000) !== 0, true);
      assert.deepEqual(mode.getBounds(), anchor); capture('other-process-half-window-retains-child');
      await mode.setInputActive(true);
      assert.equal(await mode.canActivateInput(), false, 'A stationary widget pointer must not permit activation over another native foreground process.');
      assert.equal((await observation()).foregroundPid, otherPid);
      await mode.setInputActive(false); await settled();
      assert.equal((await observation()).foregroundPid, otherPid); capture('foreign-foreground-blocks-late-editor-activation');
    } else report.cases.push({ name: 'other-process-half-window-retains-child', skipped: true, reason: 'Windows foreground lock denied the self-created window.' });
    fs.writeFileSync(otherCommand, JSON.stringify({ id: 2, action: 'close' }));
    await until(() => readJson(otherResponse)?.id === 2, 'Own half-window failed to close.'); occluderProcess.kill(); occluderProcess = null;
    await hostCommand('minimize'); await until(async () => (await observation()).windows.find(item => item.id === hostId)?.minimized, 'Host minimize failed.');
    assert.equal((lastNative.style & 0x10000000) !== 0, true, 'App hid child before host OS animation.'); capture('minimize-preserves-visible-style');
    await hostCommand('restore'); await settled(); assert.deepEqual(mode.getBounds(), anchor); await composed('restore-composes-child');
    await hostCommand('hide'); await until(async () => !(await observation()).widgetVisible, 'Child did not follow parent hide.');
    assert.equal((lastNative.style & 0x10000000) !== 0, true, 'Parent hide must preserve child visible style.'); capture('native-parent-hide');
    await hostCommand('show'); await settled(); capture('native-parent-show');
    queryKind = 'unknown'; await until(() => mode.getState().reason === 'unknown', 'Unknown query unhandled.'); capture('unknown-query');
    queryKind = 'known'; await settled(); capture('unknown-recovery');
    queryKind = 'throw'; await until(() => mode.getState().reason === 'unknown', 'Rejected native query unhandled.'); capture('rejected-query');
    queryKind = 'known'; await settled(); capture('rejected-query-recovery');
    mode.configure(false, { position: standalone, alwaysOnTop: true });
    await until(() => !mode.enabled && !mode.embedded && widget.isVisible() && widget.isAlwaysOnTop(), 'Disable failed to restore standalone.');
    assert.ok(Math.abs(widget.getBounds().x - standalone.x) <= 1 && Math.abs(widget.getBounds().y - standalone.y) <= 1, 'Standalone position not restored.');
    await standaloneTopmost(true); capture('disable-detaches-position-and-top');
    mode.configure(true, { position: standalone, alwaysOnTop: false }); await settled();
    mode.configure(false, { alwaysOnTop: false }); await standaloneTopmost(false); capture('second-detach-preserves-topmost-off');
    mode.configure(true, { position: standalone, alwaysOnTop: true }); await settled();
    const beforeRecreate = recreates; provider.fail();
    await until(() => recreates > beforeRecreate, 'Restarted worker lost style cache without requesting recreation.'); capture('worker-restart-requests-recreate');
    mode.close(); mode = null; widget.destroy(); widget = createWidget();
    mode = newMode(); mode.configure(false, { position: standalone, alwaysOnTop: true });
    await widget.loadFile(path.join(__dirname, '../test/window-presence.html')); mode.show();
    await standaloneTopmost(true); capture('replacement-standalone-topmost-recovers');
    mode.configure(true, { position: standalone, alwaysOnTop: true }); await settled(); capture('replacement-child-surface-recovers');
    const reloaded = new Promise(resolve => widget.webContents.once('did-finish-load', resolve)); widget.webContents.reload(); await reloaded;
    await settled(); capture('renderer-reload-reapplies-presence');
    await hostCommand('close'); await until(() => widget.isDestroyed(), 'Host destruction did not destroy native child surface.'); capture('host-destroys-child-surface'); mode.close(); mode = null;
    report.queries = queries; report.factories = factories; report.recreateNotifications = recreates;
    if (config.probeCodex) { probe = new CodexWindowProvider({ timeout: 15000 }); const value = await probe.query(); report.codexProbe = { known: value.known, supported: value.supported,
      visibleWindowCount: value.windows?.filter(item => item.visible && !item.minimized && !item.cloaked).length }; assert.equal(value.known, true); probe.close(); probe = null; }
    report.ok = true;
  } catch (error) { report.error = String(error.stack || error.message).slice(0, 2500);
    report.failureState = { state: mode?.getState(), native: lastNative, recreates, host: mode?.host, geometryReady: mode?.geometryReady,
      bindingRevision: mode?.bindingRevision, controller: mode?.controller?.getState() };
  }
  finally { mode?.close(); probe?.close(); if (widget && !widget.isDestroyed()) widget.destroy(); occluderProcess?.kill(); hostProcess?.kill(); fs.writeFileSync(config.reportFile, JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1); }
}).catch(() => app.exit(1));
