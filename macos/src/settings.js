'use strict';
const $ = id => document.getElementById(id);
const booleans = ['showBubble','alwaysOnTop','clickThrough','sound','followCodex'];
const numbers = ['scale','opacity','refreshSeconds','autoHideSeconds'];
let current, phrasesEdited = false;
const characterCards = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function characterFeedback(message, errors = []) {
  const container = $('character-feedback');
  container.replaceChildren();
  container.classList.toggle('has-error', errors.length > 0);
  container.hidden = !message && !errors.length;
  if (message) container.append(element('p', '', message));
  if (errors.length) {
    const list = element('ul');
    for (const error of errors) list.append(element('li', '', `${error.name || '图片'}：${error.message || '导入失败'}`));
    container.append(list);
  }
}
function setCharacterBusy(entry, busy) {
  entry.busy = busy;
  for (const button of entry.card.querySelectorAll('button')) button.disabled = busy;
  entry.select.disabled = busy || !entry.character.available;
  entry.input.disabled = busy;
}
async function characterAction(entry, action) {
  if (entry.busy) return false;
  entry.error.hidden = true;
  setCharacterBusy(entry, true);
  try {
    const state = await action();
    if (state) render(state);
    return true;
  } catch (error) {
    entry.error.textContent = error?.message || '操作未完成，请再试一次。';
    entry.error.hidden = false;
    return false;
  } finally {
    setCharacterBusy(entry, false);
  }
}
function closeCharacterEditor(entry) {
  entry.renameForm.hidden = true;
  entry.removeConfirm.hidden = true;
  entry.actions.hidden = false;
  entry.error.hidden = true;
}
function createCharacterCard(character) {
  const card = element('article', 'character-card');
  card.dataset.characterId = character.id;
  const select = element('button', 'character-select');
  select.type = 'button';
  select.dataset.action = 'select';
  const imageFrame = element('span', 'character-image-frame');
  const image = element('img', 'character-image');
  image.alt = '';
  const missing = element('span', 'character-missing', '图片无法读取');
  missing.hidden = true;
  imageFrame.append(image, missing);
  const caption = element('span', 'character-caption');
  const name = element('strong', 'character-name');
  const badge = element('span', 'character-badge');
  caption.append(name, badge);
  select.append(imageFrame, caption);
  const meta = element('div', 'character-meta');
  const kind = element('span', 'character-kind');
  const availability = element('span', 'character-availability', '文件损坏或丢失');
  availability.hidden = true;
  meta.append(kind, availability);
  const actions = element('div', 'character-actions');
  const rename = element('button', 'secondary', '重命名');
  rename.type = 'button'; rename.dataset.action = 'rename';
  const remove = element('button', 'character-remove', '删除');
  remove.type = 'button'; remove.dataset.action = 'remove';
  actions.append(rename, remove);
  const renameForm = element('form', 'character-rename-form');
  renameForm.hidden = true;
  const label = element('label', '', '形象名称');
  const input = element('input', 'character-name-input');
  input.type = 'text'; input.maxLength = 40; input.required = true;
  label.append(input);
  const renameActions = element('div', 'character-editor-actions');
  const save = element('button', '', '保存');
  save.type = 'submit'; save.dataset.action = 'save-name';
  const cancelRename = element('button', 'secondary', '取消');
  cancelRename.type = 'button'; cancelRename.dataset.action = 'cancel-rename';
  renameActions.append(save, cancelRename);
  renameForm.append(label, renameActions);
  const removeConfirm = element('div', 'character-remove-confirm');
  removeConfirm.hidden = true;
  const removeMessage = element('p');
  const confirmActions = element('div', 'character-editor-actions');
  const confirmRemove = element('button', 'danger', '确认删除');
  confirmRemove.type = 'button'; confirmRemove.dataset.action = 'confirm-remove';
  const cancelRemove = element('button', 'secondary', '取消');
  cancelRemove.type = 'button'; cancelRemove.dataset.action = 'cancel-remove';
  confirmActions.append(confirmRemove, cancelRemove);
  removeConfirm.append(removeMessage, confirmActions);
  const error = element('p', 'character-card-error');
  error.hidden = true; error.setAttribute('role', 'alert');
  card.append(select, meta, actions, renameForm, removeConfirm, error);
  const entry = {card, select, image, missing, name, badge, kind, availability, actions, renameForm, input, removeConfirm, removeMessage, remove, error, character, busy: false};
  select.addEventListener('click', () => {
    if (entry.character.available) characterAction(entry, () => window.maid.selectCharacter(entry.character.id));
  });
  // Only update this keyed card during data refreshes, so editing a name retains its caret and selection.
  rename.addEventListener('click', () => {
    closeCharacterEditor(entry);
    actions.hidden = true;
    renameForm.hidden = false;
    input.value = entry.character.name;
    input.focus(); input.select();
  });
  cancelRename.addEventListener('click', () => { closeCharacterEditor(entry); rename.focus(); });
  renameForm.addEventListener('submit', async event => {
    event.preventDefault();
    const nextName = input.value.trim();
    if (!nextName) {
      error.textContent = '请填写形象名称。'; error.hidden = false; input.focus(); return;
    }
    if (await characterAction(entry, () => window.maid.renameCharacter(entry.character.id, nextName))) {
      closeCharacterEditor(entry); rename.focus();
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !entry.busy) { closeCharacterEditor(entry); rename.focus(); }
  });
  remove.addEventListener('click', () => {
    closeCharacterEditor(entry);
    actions.hidden = true;
    removeConfirm.hidden = false;
    removeMessage.textContent = `删除「${entry.character.name}」？已保存的图片也会一并删除。`;
    cancelRemove.focus();
  });
  cancelRemove.addEventListener('click', () => { closeCharacterEditor(entry); remove.focus(); });
  confirmRemove.addEventListener('click', async () => {
    if (await characterAction(entry, () => window.maid.removeCharacter(entry.character.id))) {
      characterFeedback('形象已删除。');
      $('import-characters').focus();
    }
  });
  image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; });
  image.addEventListener('load', () => { image.hidden = false; missing.hidden = true; });
  return entry;
}
function renderCharacters(value) {
  const characters = value.characters || [];
  const active = characters.find(character => character.id === value.activeCharacterId);
  const activeName = value.characterName || active?.name || '默认形象';
  if ($('preview').getAttribute('src') !== value.characterUrl) $('preview').src = value.characterUrl;
  $('preview').alt = `当前使用：${activeName}`;
  $('current-character-name').textContent = activeName;
  $('character-count').textContent = `已保存 ${characters.length} 个形象`;
  const ids = new Set(characters.map(character => character.id));
  for (const [id, entry] of characterCards) {
    if (!ids.has(id)) { entry.card.remove(); characterCards.delete(id); }
  }
  for (const [index, character] of characters.entries()) {
    let entry = characterCards.get(character.id);
    if (!entry) { entry = createCharacterCard(character); characterCards.set(character.id, entry); }
    entry.character = character;
    const selected = character.id === value.activeCharacterId;
    entry.card.classList.toggle('selected', selected);
    entry.card.classList.toggle('unavailable', !character.available);
    entry.select.setAttribute('aria-pressed', String(selected));
    entry.select.setAttribute('aria-label', selected ? `当前使用：${character.name}` : `选用 ${character.name}`);
    entry.select.disabled = entry.busy || !character.available;
    entry.name.textContent = character.name;
    entry.name.title = character.name;
    entry.badge.textContent = selected ? '使用中 ✓' : '选用';
    entry.kind.textContent = character.builtIn ? '内置形象' : '已保存到本机';
    entry.remove.hidden = character.builtIn;
    entry.availability.hidden = character.available;
    if (entry.image.getAttribute('src') !== character.url) {
      if (character.url) entry.image.src = character.url;
      else entry.image.removeAttribute('src');
    }
    if (!character.available) { entry.image.hidden = true; entry.missing.hidden = false; }
    if (!entry.removeConfirm.hidden) entry.removeMessage.textContent = `删除「${character.name}」？已保存的图片也会一并删除。`;
    // Do not detach/reappend an unchanged card: that would disturb focused inputs in Chromium.
    const currentNode = $('character-grid').children[index];
    if (currentNode !== entry.card) $('character-grid').insertBefore(entry.card, currentNode || null);
  }
}
function render(value) {
  current=value;
  $('version').textContent = 'v'+value.version;
  for(const id of booleans) $(id).checked = value.settings[id];
  for(const id of [...numbers,'mode']) $(id).value = value.settings[id];
  $('scale-value').textContent = Math.round(value.settings.scale*100)+'%';
  $('opacity-value').textContent = Math.round(value.settings.opacity*100)+'%';
  $('bucketId').replaceChildren();
  for(const item of [{id:'',name:'自动选择'},...(value.snapshot.buckets || [])]) { const option=document.createElement('option'); option.value=item.id; option.textContent=item.name||item.id; $('bucketId').append(option); }
  $('bucketId').value=value.settings.bucketId;
  if(!phrasesEdited) $('phrases').value=value.settings.phrases.join('\n');
  renderCharacters(value);
  const status=value.snapshot.status;
  $('status-dot').classList.toggle('live',['live','demo'].includes(status));
  $('status-text').textContent=({live:'已连接本机 Codex',partial:'部分数据可用',offline:'暂时无法连接 Codex',connecting:'正在连接 Codex',demo:'正在预览演示数据'})[status]||status;
  $('error').textContent=value.snapshot.error||''; $('error').hidden=!value.snapshot.error;
  $('data-detail').textContent=value.snapshot.account?.planType ? `当前套餐：${value.snapshot.account.planType} · 额度来自 Codex app-server` : '额度来自本机 Codex app-server；不需要填写密钥。';
  $('demo-note').textContent=value.demo?'· 当前为演示模式':'';
  $('autostart-note').textContent=value.followError || (value.followSupported === false ? 'Windows 可携版和 macOS 应用版支持自动跟随，演示或源码模式不修改系统启动项。' : '打开客户端时启动，退出客户端后自动退出；启动助手在后台等待下次打开。');
  if (value.platform === 'darwin') for (const label of document.querySelectorAll('.help dd')) label.textContent = label.textContent.replaceAll('Alt', 'Option');
}
for(const id of booleans) $(id).addEventListener('change',()=>window.maid.setSettings({[id]:$(id).checked}));
for(const id of [...numbers,'mode','bucketId']) {
  $(id).addEventListener('change',()=>window.maid.setSettings({[id]:numbers.includes(id)?Number($(id).value):$(id).value}));
}
for(const id of ['scale','opacity']) $(id).addEventListener('input',()=>$(id+'-value').textContent=Math.round(Number($(id).value)*100)+'%');
$('phrases').addEventListener('input',()=>{phrasesEdited=true;$('saved').textContent='';});
$('save-phrases').addEventListener('click',async()=>{const phrases=$('phrases').value.split('\n').map(x=>x.trim()).filter(Boolean);if(!phrases.length){$('saved').textContent='请至少写一句台词';return;}await window.maid.setSettings({phrases});phrasesEdited=false;$('saved').textContent='已保存';});
$('refresh').addEventListener('click',async()=>{$('refresh').disabled=true;$('refresh').textContent='刷新中…';try{await window.maid.refresh();}finally{$('refresh').disabled=false;$('refresh').textContent='刷新 ↻';}});
$('import-characters').addEventListener('click', async () => {
  const button = $('import-characters');
  button.disabled = true; button.textContent = '正在导入…';
  try {
    const result = await window.maid.importCharacters();
    if (result.state) render(result.state);
    const imported = result.importedCount || 0, existing = result.existingCount || 0, errors = result.errors || [];
    const messages = [];
    if (imported) messages.push(`已导入 ${imported} 个形象`);
    if (existing) messages.push(`${existing} 张图片已在形象库中`);
    if (errors.length) messages.push(`${errors.length} 张未能导入`);
    if (messages.length) characterFeedback(messages.join('，') + '。', errors);
  } catch (error) {
    characterFeedback('导入未完成。', [{name: '图片', message: error?.message || '请重新选择本地图片。'}]);
  } finally {
    button.disabled = false; button.textContent = '＋ 导入形象';
  }
});
window.maid.onState(render);window.maid.getState().then(render);
