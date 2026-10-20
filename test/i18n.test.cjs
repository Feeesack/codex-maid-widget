'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

for (const directory of ['src', 'macos/src']) {
  function load(document) {
    const context = { module: { exports: {} }, document };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', directory, 'i18n.js'), 'utf8'), context);
    return context.module.exports;
  }
  test(directory + ': locale defaults and interpolation preserve unknown and user text', () => {
    const i18n = load();
    for (const input of [undefined, null, {}, 'fr', 'zh-CN', 'toString']) assert.equal(i18n.normalizeLocale(input), 'zh-CN');
    for (const input of ['en', 'EN-us', ' en_GB ']) assert.equal(i18n.normalizeLocale(input), 'en');
    assert.equal(i18n.getLocale(), 'zh-CN');
    i18n.register({ '剩余 {amount}%': '{amount}% remaining', '带 {name}': 'With {name}' });
    assert.equal(i18n.t('剩余 {amount}%', { amount: 25 }), '剩余 25%');
    i18n.setLocale('en');
    assert.equal(i18n.t('剩余 {amount}%', { amount: 25 }), '25% remaining');
    assert.equal(i18n.t('带 {name}', { name: '<img src=x>' }), 'With <img src=x>');
    assert.equal(i18n.t('剩余 {amount}%'), '{amount}% remaining');
    assert.equal(i18n.t('用户自定义名称'), '用户自定义名称');
    assert.equal(i18n.t('读取超时，请重试'), 'Reading timed out. Please try again');
    assert.equal(i18n.t('toString'), 'toString');
    assert.equal(i18n.accountLabel({label:'中文昵称 · 自定义工作空间',labelSource:'nickname',profileNickname:'中文昵称',workspaceName:'自定义工作空间',scopeLabel:'工作空间'}), '中文昵称 · 自定义工作空间');
    assert.equal(i18n.accountLabel({label:'保留我的名称',labelSource:'manual',userEdited:true}), '保留我的名称');
    assert.equal(i18n.accountLabel({label:'昵称未读取 12 · 工作空间',labelSource:'fallback',scopeLabel:'工作空间'}), 'Account 12 · Workspace');
    i18n.setLocale('invalid');
    assert.equal(i18n.t('读取超时，请重试'), '读取超时，请重试');
  });
  test(directory + ': locale changes update only marked labels while preserving nested icons and controls', () => {
    const text = { nodeType: 3, nodeValue: '设置' };
    const icon = { nodeType: 1, identity: 'unchanged icon' };
    const attrs = { 'data-i18n': '设置', 'data-i18n-title': '刷新额度', 'data-i18n-aria-label': '设置' };
    const element = { childNodes: [icon, text], children: [icon], hasAttribute: name => Object.hasOwn(attrs, name),
      getAttribute: name => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = value; } };
    const document = { documentElement: { lang: 'zh-CN' }, querySelectorAll: () => [element] };
    const i18n = load(document);
    i18n.setLocale('en');
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(text.nodeValue, 'Settings');
    assert.equal(attrs.title, 'Refresh quota');
    assert.equal(attrs['aria-label'], 'Settings');
    assert.strictEqual(element.childNodes[0], icon);
    assert.equal(attrs['data-i18n'], '设置');
    i18n.setLocale('zh-CN');
    assert.equal(text.nodeValue, '设置');
    assert.equal(attrs.title, '刷新额度');
  });
  test(directory + ': settings language survives isolated storage and does not rewrite custom preferences', t => {
    // Settings only reads the explicit fixture path. No data-home provider,
    // real settings directory, credentials or application bootstrap is loaded.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-language-中文 space-'));
    t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
    const filename = path.join(isolated, 'settings.json');
    const settings = require(path.join(__dirname, '..', directory, 'settings.cjs'));
    assert.equal(settings.sanitize().language, 'zh-CN');
    const custom = { sizeBaseline: 2, language: 'en', phrases: ['我自己写的台词', 'My custom line'], activeCharacterId: 'custom-kept',
      scale: 1.23, mirror: true, position: { x: -300, y: 40 }, bubblePageOrder: ['phrase', 'accounts'] };
    settings.writeSettings(filename, custom);
    const english = settings.readSettings(filename);
    assert.equal(english.language, 'en');
    assert.deepEqual(english.phrases, custom.phrases);
    assert.equal(english.activeCharacterId, custom.activeCharacterId);
    assert.equal(english.scale, custom.scale);
    assert.deepEqual(english.position, custom.position);
    settings.writeSettings(filename, { ...english, language: 'zh-CN' });
    const chinese = settings.readSettings(filename);
    assert.deepEqual({ ...chinese, language: 'en' }, english);
    for (const language of [null, 'fr', 1, ['en']]) assert.equal(settings.sanitize({ language }).language, 'zh-CN');
    const i18n = load(); i18n.setLocale('en');
    assert.equal(i18n.isDefaultPhrases(settings.DEFAULTS.phrases), true);
    assert.equal(i18n.isDefaultPhrases(custom.phrases), false);
    assert.equal(i18n.characterName({ name: '薄荷女仆', builtIn: true }), 'Mint Maid');
    assert.equal(i18n.characterName({ name: '薄荷女仆', builtIn: true, nameCustomized: true }), '薄荷女仆');
    assert.equal(i18n.characterName({ name: '薄荷女仆', builtIn: false }), '薄荷女仆');
  });
  test(directory + ': explicitly renamed built-ins remain literal even when their alias matches a shipped name', t => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-character-language-中文 space-'));
    t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
    const assetRoot = path.join(isolated, 'assets'), dataDir = path.join(isolated, 'data');
    fs.mkdirSync(assetRoot);
    fs.writeFileSync(path.join(assetRoot, 'maid.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64'));
    const { CharacterLibrary } = require(path.join(__dirname, '..', directory, 'character-library.cjs'));
    let library = new CharacterLibrary({assetRoot,dataDir});
    const i18n = load(); i18n.setLocale('en');
    assert.equal(library.get('mint-maid').nameCustomized, false);
    assert.equal(i18n.characterName(library.get('mint-maid')), 'Mint Maid');
    library.rename('mint-maid', '薄荷女仆');
    library = new CharacterLibrary({assetRoot,dataDir});
    assert.equal(library.get('mint-maid').nameCustomized, true);
    assert.equal(i18n.characterName(library.get('mint-maid')), '薄荷女仆');
    i18n.setLocale('zh-CN');
    assert.equal(i18n.characterName(library.get('mint-maid')), '薄荷女仆');
  });
}
