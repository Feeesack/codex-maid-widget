(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MaidI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  let locale = 'zh-CN';
  const dictionary = Object.create(null);
  const defaultPhrases = Object.freeze([
    'Tibo 义父，reset please……', '别急着重置嘛，让我再蹬蹬。', '蹬个 token 都要拼尽全力？杂鱼～',
    '今日职业：yes 工程师。', '说好让 AI 干活，怎么我成监工了。', '以前缺 token，现在缺觉……',
    '先别让 Codex 清电脑，我怕它把自己也清了。', '下班啦。AI 没跑完，明天再说。',
    '嘘，Codex 会干这活的事，先别告诉老板。', '还不睡？睡前还得给 Codex 留作业是吧。',
  ]);
  function normalizeLocale(value) {
    return typeof value === 'string' && /^en(?:[-_][a-z0-9]+)*$/i.test(value.trim()) ? 'en' : 'zh-CN';
  }
  function register(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    for (const source of Object.keys(values)) if (typeof values[source] === 'string') dictionary[source] = values[source];
  }
  function t(source, params) {
    if (source === null || source === undefined) return '';
    const key = String(source);
    const text = locale === 'en' && Object.hasOwn(dictionary, key) ? dictionary[key] : key;
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      params && Object.hasOwn(params, name) && params[name] !== undefined ? String(params[name] ?? '') : match);
  }
  function translateText(element, source) {
    const value = t(source);
    // Translate the label's own text only. Icons, nested controls and their
    // event listeners must survive a language change intact.
    const nodes = Array.from(element.childNodes || []).filter(node => node.nodeType === 3 && node.nodeValue.trim());
    if (nodes.length) {
      nodes[0].nodeValue = value;
      for (const node of nodes.slice(1)) node.nodeValue = '';
    } else if (!(element.children?.length)) element.textContent = value;
    else if (root.document?.createTextNode) element.appendChild(root.document.createTextNode(value));
  }
  function translateDocument(scope) {
    const doc = root.document;
    scope = scope || doc;
    if (!scope) return;
    const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
    const selector = '[data-i18n],' + attributes.map(name => '[data-i18n-' + name + ']').join(',');
    const elements = Array.from(scope.querySelectorAll?.(selector) || []);
    if (scope.matches?.(selector)) elements.unshift(scope);
    for (const element of elements) {
      if (element.hasAttribute?.('data-i18n')) translateText(element, element.getAttribute('data-i18n'));
      for (const name of attributes) {
        const source = element.getAttribute?.('data-i18n-' + name);
        if (source !== null && source !== undefined) element.setAttribute(name, t(source));
      }
    }
  }
  function setLocale(value) {
    locale = normalizeLocale(value);
    if (root.document?.documentElement) root.document.documentElement.lang = locale;
    translateDocument();
    return locale;
  }
  function isDefaultPhrases(values) {
    return Array.isArray(values) && values.length === defaultPhrases.length && values.every((value, index) => value === defaultPhrases[index]);
  }
  function characterName(character) {
    return character?.builtIn && !character.nameCustomized ? t(character.name) : character?.name || '';
  }
  function accountLabel(account) {
    const label = typeof account?.label === 'string' ? account.label : '';
    if (locale !== 'en' || account?.userEdited === true || account?.labelSource === 'manual') return label;
    // Only ledger-generated names are reconstructed. Profile nicknames,
    // workspace names and explicit aliases always remain user content.
    if (!['fallback', 'nickname'].includes(account?.labelSource)) return label;
    const nickname = typeof account.profileNickname === 'string' ? account.profileNickname.trim() : '';
    const workspace = typeof account.workspaceName === 'string' ? account.workspaceName.trim() : '';
    const source = typeof account.autoLabel === 'string' ? account.autoLabel : label;
    const ordinal = /^昵称未读取 (\d+)/.exec(source)?.[1];
    const name = nickname || (ordinal ? t('昵称未读取 {number}', {number:ordinal}) : t('昵称未读取'));
    const scope = ['个人','工作空间'].includes(account.scopeLabel) ? t(account.scopeLabel) : '';
    return [name, workspace || scope].filter(Boolean).join(' · ');
  }
  function connectorMessage(message) {
    if (typeof message !== 'string') return '';
    // The external connector keeps its existing protocol and Chinese messages.
    // Only translate known public copy; never reinterpret external diagnostics.
    if (locale !== 'en') return message;
    const prefixes = [
      '注册本地插件来源失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。',
      '安装本地挂件插件失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。',
    ];
    for (const prefix of prefixes) {
      if (!message.startsWith(prefix)) continue;
      const diagnostic = /^（([A-Z0-9_]+|退出码 (-?\d+|null))）$/.exec(message.slice(prefix.length));
      if (!diagnostic) return message;
      return t(prefix) + ' (' + (diagnostic[2] !== undefined ? t('退出码 {code}', {code:diagnostic[2]}) : diagnostic[1]) + ')';
    }
    return t(message);
  }
  register({
    '显示女仆 · Ctrl+Alt+M': 'Show companion · Ctrl+Alt+M',
    '刷新额度': 'Refresh quota', '切换形象': 'Change character', '设置': 'Settings',
    '鼠标穿透 · Ctrl+Alt+Shift+M': 'Click-through · Ctrl+Alt+Shift+M',
    '始终置顶': 'Always on top', '仅在 Codex 窗口内显示': 'Show only inside the Codex window',
    '重置位置': 'Reset position', '隐藏挂件': 'Hide widget', '退出': 'Quit', '管理形象…': 'Manage characters…',
    'Codex 女仆 · 设置': 'Codex Maid · Settings', 'Codex 女仆 · 额度与陪伴': 'Codex Maid · Quota & company',
    'Codex 女仆启动失败': 'Codex Maid could not start',
    '导入形象（可多选，推荐透明 PNG）': 'Import characters (multiple files; transparent PNG recommended)', '图片': 'Images',
    '小龙娘-托腮': 'Little Dragon · Daydream', '小龙娘-端庄': 'Little Dragon · Poise',
    '薄荷女仆': 'Mint Maid', '紫晶龙女仆': 'Amethyst Dragon Maid',
    '无效的外观预览参数': 'Invalid appearance preview settings.', '无效的底角预览参数': 'Invalid corner preview settings.',
    '该形象不存在或图片已损坏，请重新导入。': 'This character is missing or its image is damaged. Please import it again.',
    '请选择本地图片。': 'Please choose a local image.', '请选择小于 15 MB 的图片。': 'Please choose an image smaller than 15 MB.',
    '无法读取这张图片，请重新导出后导入。': 'This image could not be read. Please export it again before importing.',
    '图片尺寸过大，请先缩小图片后导入。': 'This image is too large. Please resize it before importing.',
    '图片不存在或已移动。': 'The image is missing or has been moved.',
    '暂时无法读取 Codex，请稍后刷新。': 'Codex could not be read. Please refresh in a moment.',
    '未知操作': 'Unknown action.', '无效窗口': 'Invalid window.',
    '无法读取这张图片，请选择有效的 PNG、WebP、GIF 或 JPEG。': 'This image could not be read. Please choose a valid PNG, WebP, GIF or JPEG.',
    'Windows 登录启动项未启用，请在系统启动应用中开启 CodexMaidFollow。': 'Windows startup is disabled. Enable CodexMaidFollow in Startup apps.',
    '后台启动助手未能就绪，请重新开启跟随开关；需保持 Windows 资源管理器运行。': 'The background helper is not ready. Turn “Launch with Codex” off and on again, and keep Windows Explorer running.',
    '未能移除 Windows 登录启动项，请重新开启再关闭跟随开关。': 'The Windows startup entry could not be removed. Turn “Launch with Codex” on and off again.',
    '未能保存自动跟随设置，请检查 Windows 启动项权限后重试。': 'Follow settings could not be saved. Check Windows startup permissions and try again.',
    'macOS 后台启动助手未启用，请检查系统设置中的登录项与后台活动。': 'The macOS background helper is disabled. Check Login Items & Extensions in System Settings.',
    '后台启动助手未能就绪，请检查 macOS 登录项与后台活动权限，再重新开启跟随。': 'The background helper is not ready. Check macOS login item and background activity permissions, then turn “Launch with Codex” on again.',
    '未能移除系统登录启动项，请重新开启再关闭跟随开关。': 'The system login item could not be removed. Turn “Launch with Codex” on and off again.',
    '未能保存自动跟随设置，请检查系统登录启动项权限后重试。': 'Follow settings could not be saved. Check login item permissions and try again.',
    '连接 Codex 工具…': 'Connect Codex tools…', '连接工具随 Mac 安装包提供。': 'The connection tool is included with the Mac app.',
    '请安装完整应用后，从菜单栏选择“连接 Codex 工具”。': 'Install the full app, then choose “Connect Codex tools” from the menu bar.',
    '将女仆挂件连接到 Codex？': 'Connect Codex Maid to Codex?',
    '这会在本机注册并安装女仆插件，让 Codex 对话可以读取挂件状态、刷新额度和互动。完成后请重启 Codex 并新建聊天。': 'This registers and installs the local Maid plugin so Codex chats can read widget status, refresh quotas and interact with your companion. Restart Codex and start a new chat afterward.',
    '连接': 'Connect', '取消': 'Cancel', '连接未完成。请确认已安装最新 Codex，然后从菜单栏重试。': 'Connection was not completed. Make sure the latest Codex is installed, then try again from the menu bar.',
    'Codex 工具已连接': 'Codex tools connected', 'Codex 工具连接未完成': 'Codex tools connection incomplete',
    '连接文件已准备，尚未修改 Codex 设置。': 'Connection files are ready. Codex settings have not been changed.',
    'Codex 女仆挂件插件已连接。请重启 Codex 并新建聊天，使工具生效；桌面挂件须保持运行。真实额度需要 Codex 已登录的账号。无需 Node.js 或项目源码。': 'The Codex Maid plugin is connected. Restart Codex and start a new chat to enable the tools. Keep the desktop companion running. Live quota requires an account signed in to Codex. Node.js and the project source are not required.',
    '未找到可运行的 Codex 命令行程序。请先打开已安装的 Codex 桌面版再重试；自定义位置可通过 CODEX_CLI 或 CODEX_MAID_CODEX_PATH 指定，无需安装 Node.js。': 'A runnable Codex CLI was not found. Open your installed Codex desktop app and try again. For a custom location, set CODEX_CLI or CODEX_MAID_CODEX_PATH. Node.js is not required.',
    '插件操作未完成。请检查安装文件及 Codex 版本后重试。': 'The plugin operation could not be completed. Check the app installation and Codex version, then try again.',
    '注册本地插件来源失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。': 'Could not register the local plugin source. Update Codex and connect again. You can also install codex-maid-widget@codex-maid-installed from the Codex plugin directory.',
    '安装本地挂件插件失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。': 'Could not install the local widget plugin. Update Codex and connect again. You can also install codex-maid-widget@codex-maid-installed from the Codex plugin directory.',
    '退出码 {code}': 'Exit code {code}',
    '形象名称须为 1–40 个字符，不能包含换行或控制字符。': 'Character names must contain 1–40 characters, without line breaks or control characters.',
    '形象保存目录不安全，请检查 characters 文件夹。': 'The character storage folder is unsafe. Please check the characters folder.',
    '形象库包含不安全的文件路径。': 'The character library contains an unsafe file path.', '形象文件超出保存目录。': 'The character file is outside its storage folder.',
    '形象库索引无法读取，原索引和图片已保留。请先备份 characters 文件夹，再修复 library.json。': 'The character index could not be read. The original index and images have been preserved. Back up the characters folder before repairing library.json.',
    '形象库索引路径不安全。': 'The character index path is unsafe.', '请选择本地图片文件。': 'Please choose a local image file.',
    '支持 PNG、WebP、JPG 和 GIF 图片。': 'PNG, WebP, JPG and GIF images are supported.', '所选项目不是图片文件。': 'The selected item is not an image file.',
    '单张图片不能超过 15 MB。': 'Each image must be 15 MB or smaller.',
    '图片格式无效或与扩展名不符，请重新导出图片。': 'The image format is invalid or does not match its extension. Please export the image again.',
    '无法解码图片，请重新导出图片。': 'The image could not be decoded. Please export it again.',
    '形象库最多保存 500 个导入形象。': 'The library can hold up to 500 imported characters.',
    '图片不存在，或原文件已移动。': 'The image is missing or its original file has been moved.',
    '无法读取图片或写入形象库，请检查文件权限。': 'The image could not be read or the library could not be written. Please check file permissions.',
    '未知文件': 'Unknown file', '未找到该形象。': 'Character not found.', '内置形象不能删除，可以随时切换。': 'Built-in characters cannot be removed. You can switch characters at any time.',
    '形象文件路径不安全，未删除任何文件。': 'The character file path is unsafe. No files were deleted.',
    '账号记录文件不可用，已保留原文件。': 'The account record is unavailable. The original file has been preserved.',
    '未找到 Codex CLI，请先安装并登录 Codex，或用 CODEX_MAID_CODEX_PATH 指定 codex.exe。': 'Codex CLI was not found. Install and sign in to Codex, or set CODEX_MAID_CODEX_PATH to your Codex executable.',
    '额度连接已关闭。': 'The quota connection is closed.', '读取 Codex 额度超时，请稍后刷新。': 'Reading Codex quota timed out. Please refresh in a moment.',
    'Codex 尚未登录或登录已过期，请在 Codex 中重新登录。': 'You are signed out of Codex or your session has expired. Please sign in again in Codex.',
    '当前登录方式不提供 ChatGPT 订阅额度，请使用 ChatGPT 账号登录 Codex。': 'This sign-in method does not provide ChatGPT subscription quotas. Sign in to Codex with a ChatGPT account.',
    '暂时无法读取 Codex 额度，请确认 Codex CLI 可用并稍后刷新。': 'Codex quota could not be read. Check that Codex CLI is available, then refresh in a moment.',
    '当前账号未返回可显示的额度窗口。': 'This account has not returned any quota windows to display.',
    '当前对话工作区不可用': 'The current chat workspace is unavailable', '未找到 Git': 'Git not found', '当前工作区不是 Git 仓库': 'This workspace is not a Git repository',
    'Git 查询超时，请重试': 'Git status timed out. Please try again', '工作区查询超时，请重试': 'Workspace lookup timed out. Please try again',
    'Git 变更过多，暂时无法统计': 'There are too many Git changes to count right now', '暂时无法读取 Git 状态': 'Git status is temporarily unavailable',
    '读取超时，请重试': 'Reading timed out. Please try again', '未识别当前对话，可手动选择': 'Current chat not detected. Select one manually',
    '请先选择要查看的对话': 'Select a chat to inspect', '当前对话没有本地工作区': 'This chat has no local workspace',
    '对话已切换，请再点一次': 'The chat changed. Please try again', '暂无所选对话的上下文数据': 'No context data is available for this chat yet',
    '非 Git 工作区': 'Not a Git workspace', 'Git 读取超时，请重试': 'Reading Git status timed out. Please try again',
    '暂时无法读取工作区 Git 状态': 'Workspace Git status is temporarily unavailable', '暂无所选对话的压缩记录': 'No compaction records are available for this chat yet',
    '无法选择此本地聊天，请刷新后重试。': 'This local chat cannot be selected. Refresh and try again.',
    '无法保存对话选择，请重试。': 'The chat selection could not be saved. Please try again.',
    '无法选择此本地聊天，请刷新列表后重试。': 'This local chat cannot be selected. Refresh the list and try again.',
    '工作区': 'Workspace', '未命名聊天': 'Untitled chat', '演示': 'Demo', '演示额度': 'Demo quota',
    '个人': 'Personal', '工作空间': 'Workspace', '未知范围': 'Unknown scope', '未知套餐': 'Unknown plan',
    '昵称未读取': 'Name unavailable', '昵称未读取 {number}': 'Account {number}',
    'Tibo 义父，reset please……': 'Tibo, my savior… reset, please.',
    '别急着重置嘛，让我再蹬蹬。': 'Hold that reset—let me squeeze in a few more tokens.',
    '蹬个 token 都要拼尽全力？杂鱼～': 'All that effort for one token? You little lightweight~',
    '今日职业：yes 工程师。': 'Today’s job: professional “Yes” clicker.',
    '说好让 AI 干活，怎么我成监工了。': 'AI was supposed to do the work. Why am I supervising?',
    '以前缺 token，现在缺觉……': 'I used to be short on tokens. Now I’m short on sleep…',
    '先别让 Codex 清电脑，我怕它把自己也清了。': 'Don’t let Codex clean up your computer yet. It might delete itself.',
    '下班啦。AI 没跑完，明天再说。': 'Clocking out. AI still running? That’s tomorrow’s problem.',
    '嘘，Codex 会干这活的事，先别告诉老板。': 'Shh… don’t tell the boss Codex can do this yet.',
    '还不睡？睡前还得给 Codex 留作业是吧。': 'Still awake? Leaving Codex some homework before bed?',
  });
  return Object.freeze({ normalizeLocale, setLocale, getLocale: () => locale, register, t, translateDocument, isDefaultPhrases, characterName, accountLabel, connectorMessage });
});
