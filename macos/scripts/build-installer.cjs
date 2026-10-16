'use strict';
// A genuine Apple Installer product archive. Only macOS's own packaging tools
// produce this file; an archive renamed to .pkg is never reported as a build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { APP_NAME, BUNDLE_ID, packageDirectory, checkWorkspaceVersion } = require('./build-config.cjs');
const { verifyPackage } = require('./verify-package.cjs');
const { verifyInstaller } = require('./verify-installer.cjs');

const RECEIPT_ID = `${BUNDLE_ID}.installer`;
const CONNECTOR_NAME = `${APP_NAME}-连接 Codex.command`;
function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}
function distributionXml(version) {
  const id = xmlEscape(RECEIPT_ID);
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Codex 女仆挂件 ${xmlEscape(version)}</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="13.0"/></allowed-os-versions></volume-check>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <choices-outline><line choice="widget"/></choices-outline>
  <choice id="widget" title="Codex 女仆挂件" description="完整应用及本地 Codex 插件连接器" visible="false"><pkg-ref id="${id}"/></choice>
  <pkg-ref id="${id}" version="${xmlEscape(version)}" onConclusion="None">component.pkg</pkg-ref>
  <pkg-ref id="${id}"><must-close><app id="${xmlEscape(BUNDLE_ID)}"/></must-close></pkg-ref>
</installer-gui-script>
`;
}
function connectorScript() {
  return `#!/bin/sh
set -eu
maid_app='/Applications/${APP_NAME}.app'
export ELECTRON_RUN_AS_NODE=1
"$maid_app/Contents/MacOS/${APP_NAME}" "$maid_app/Contents/Resources/integration/connect.cjs" --install
printf '\\n%s\\n' '连接已完成；请重启 Codex。按回车关闭此窗口。'
read -r maid_close
`;
}
function html(title, body) { return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${xmlEscape(title)}</title><body style="font-family:-apple-system,sans-serif;font-size:15px"><h2>${xmlEscape(title)}</h2>${body}</body></html>\n`; }
async function main() {
  if (process.platform !== 'darwin') throw new Error('生成真正的 Mac 安装包需要 macOS 自带的 pkgbuild、productbuild、codesign 和 lipo。请运行 macOS 安装包工作流。当前主机不能生成或验收 .pkg。');
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false } } });
  for (const tool of ['/usr/bin/pkgbuild', '/usr/bin/productbuild', '/usr/sbin/pkgutil', '/usr/bin/codesign', '/usr/bin/ditto', '/usr/bin/lipo']) {
    if (!fs.existsSync(tool)) throw new Error(`缺少 macOS 构建工具 ${tool}。请安装 Apple Command Line Tools 后重试。`);
  }
  const root = path.resolve(__dirname, '..');
  checkWorkspaceVersion(root);
  if (!values['skip-build']) await require('./build.cjs').main({ arch: 'universal', argv: [] });
  const version = require('../package.json').version;
  const packed = await verifyPackage({ directory: packageDirectory(root, 'universal'), arch: 'universal' });
  const output = path.join(root, 'release', version, 'installers');
  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync(path.join(output, '.mac-installer-'));
  try {
    const payload = path.join(stage, 'payload');
    const applications = path.join(payload, 'Applications'); fs.mkdirSync(applications, { recursive: true });
    const bundle = path.join(applications, `${APP_NAME}.app`);
    execFileSync('/usr/bin/ditto', [packed.bundle, bundle]);
    const connector = path.join(applications, CONNECTOR_NAME);
    fs.writeFileSync(connector, connectorScript(), { mode: 0o755 }); fs.chmodSync(connector, 0o755);
    const componentPlist = path.join(stage, 'components.plist');
    execFileSync('/usr/bin/pkgbuild', ['--analyze', '--root', payload, componentPlist]);
    const plist = require('plist');
    const components = plist.parse(fs.readFileSync(componentPlist, 'utf8'));
    const application = components.find(item => item.RootRelativeBundlePath === `Applications/${APP_NAME}.app`);
    if (!application) throw new Error('pkgbuild 未找到预期的应用组件。');
    application.BundleIsRelocatable = false;
    application.BundleHasStrictIdentifier = true;
    // An explicit installation atomically replaces the existing application.
    application.BundleIsVersionChecked = false;
    application.BundleOverwriteAction = 'upgrade';
    fs.writeFileSync(componentPlist, plist.build(components));
    execFileSync('/usr/bin/pkgbuild', ['--root', payload, '--component-plist', componentPlist, '--identifier', RECEIPT_ID, '--version', version, '--install-location', '/', '--ownership', 'recommended', path.join(stage, 'component.pkg')], { stdio: 'inherit' });
    const resources = path.join(stage, 'installer-resources'); fs.mkdirSync(resources);
    fs.writeFileSync(path.join(resources, 'welcome.html'), html('安装 Codex 女仆挂件', '<p>一个安装包支持 Apple Silicon 与 Intel，适用于 macOS 13 及以上。</p><p>完整应用、Electron 运行环境、角色素材与本地插件连接器均已包含；使用者无需 Node.js、npm、源码或编译工具。</p><p>安装到“应用程序”，保留原有用户设置和角色。真实额度、账号信息与插件功能需要本机已经安装并登录 Codex。</p>'));
    fs.writeFileSync(path.join(resources, 'conclusion.html'), html('安装完成', `<p>从“应用程序”打开 <b>${APP_NAME}</b>。</p><p>需要在聊天中操作挂件时，双击“应用程序”中的 <b>${CONNECTOR_NAME}</b>，按提示完成本地连接并重启 Codex；不需要安装 Node.js。</p><p>设置、导入形象与跟随启动状态保存在当前用户的 ~/.codex-maid-widget。安装不会读取或替换 Codex 认证文件。</p>`));
    const distribution = path.join(stage, 'Distribution.xml'); fs.writeFileSync(distribution, distributionXml(version));
    const name = `${APP_NAME}-${version}-macOS-universal.pkg`;
    const candidate = path.join(stage, name);
    execFileSync('/usr/bin/productbuild', ['--distribution', distribution, '--resources', resources, '--package-path', stage, candidate], { stdio: 'inherit' });
    await verifyInstaller({ file: candidate, version });
    const target = path.join(output, name);
    fs.renameSync(candidate, target);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    fs.writeFileSync(path.join(output, `${name}.sha256`), `${sha256}  ${name}\n`);
    console.log(`PASS: Apple Installer universal product archive: ${target}`);
    console.log('The app is ad-hoc signed. The installer is unsigned and not notarized; native installation and startup checks must pass before delivery.');
    return target;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { RECEIPT_ID, CONNECTOR_NAME, xmlEscape, distributionXml, connectorScript, main };
