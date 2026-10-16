'use strict';
const fs = require('node:fs');
const path = require('node:path');
const APP_NAME = 'Codex-Maid-Widget';
const BUNDLE_ID = 'com.codexmaid.widget';
const IGNORE = [
  // Runtime allowlist: never embed development docs, history or local state.
  /^\/(?!src(?:\/|$)|assets(?:\/|$)|plugins(?:\/|$)|licenses(?:\/|$)|(?:package\.json|LICENSE|NOTICE|ARTWORK_LICENSE\.md)$).+/,
  /^\/(?:release|tmp|test|node_modules|docs|chat_backup|\.git|\.github|\.agents|coverage|userData|characters)($|\/)/,
  /^\/(?:auth|control|watcher|settings)\.json$/,
  /^\/\.env(?:\.|$)/,
  /(?:^|\/)(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$/,
];
async function stripUnusedMacPermissions({ buildPath, platform }) {
  if (platform !== 'darwin') return;
  const plist = require('plist');
  const contents = path.join(buildPath, 'Electron.app', 'Contents');
  const candidates = [path.join(contents, 'Info.plist')];
  for (const directory of [path.join(contents, 'Frameworks'), path.join(contents, 'Library', 'LoginItems')]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) if (name.endsWith('.app')) candidates.push(path.join(directory, name, 'Contents', 'Info.plist'));
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const data = plist.parse(fs.readFileSync(file, 'utf8'));
    delete data.NSCameraUsageDescription; delete data.NSMicrophoneUsageDescription;
    fs.writeFileSync(file, plist.build(data));
  }
}
function retainMacRuntimeLicenses({ buildPath, platform }) {
  if (platform !== 'darwin') return;
  // Electron's notices live beside Electron.app in the verified download ZIP.
  // Packager moves only the .app into the final output, so retain those notices
  // inside Resources before signing either architecture.
  const target = path.join(buildPath, 'Electron.app', 'Contents', 'Resources', 'electron-licenses');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const source = path.join(buildPath, name);
    if (!fs.statSync(source).isFile()) throw new Error('Missing Electron runtime notice: ' + name);
    fs.copyFileSync(source, path.join(target, name));
  }
}
function packageDirectory(root, arch, version = require('../package.json').version) {
  return path.join(root, 'release', version, `${APP_NAME}-darwin-${arch}`);
}
function buildOptions({ root = path.resolve(__dirname, '..'), arch = process.arch, hostPlatform = process.platform } = {}) {
  checkWorkspaceVersion(root);
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error(`不支持的 Mac 架构 ${arch}；请使用 --arch arm64、--arch x64 或 --arch universal。`);
  if (arch === 'universal' && hostPlatform !== 'darwin') throw new Error('Universal Mac 构建需要 macOS 的 lipo 和代码签名工具；请运行 macOS 安装包工作流。');
  const version = require('../package.json').version;
  const options = {
    dir: root, out: path.join(root, 'release', version), name: APP_NAME, executableName: APP_NAME,
    platform: 'darwin', arch, overwrite: true, asar: true, icon: path.join(root, 'assets', 'app-icon.icns'),
    electronVersion: require('electron/package.json').version,
    download: { checksums: require('electron/checksums.json') }, ignore: IGNORE, appVersion: version,
    appBundleId: BUNDLE_ID, helperBundleId: `${BUNDLE_ID}.helper`,
    appCategoryType: 'public.app-category.utilities', darwinDarkModeSupport: true,
    extendInfo: { LSUIElement: true, LSMinimumSystemVersion: '13.0', NSHighResolutionCapable: true },
    afterExtract: [stripUnusedMacPermissions, retainMacRuntimeLicenses],
    afterCopy: [({ buildPath, platform }) => {
      if (platform !== 'darwin') return;
      const localIntegration = path.join(root, 'distribution', 'integration', 'prepare-payload.cjs');
      const { stageIntegration } = require(fs.existsSync(localIntegration) ? localIntegration : '../../distribution/integration/prepare-payload.cjs');
      stageIntegration({ root, platform, destination: path.join(path.dirname(buildPath), 'integration') });
    }],
    osxUniversal: { mergeASARs: true },
  };
  // A local ad-hoc signature needs no Apple account. Sign every nested code
  // object using Packager's proper inside-out signing order and verify strictly.
  if (hostPlatform === 'darwin') options.osxSign = {
    identity: '-', identityValidation: false, continueOnError: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  };
  return options;
}
function checkWorkspaceVersion(root = path.resolve(__dirname, '..')) {
  // In the complete project both platforms share the Windows baseline version.
  // The independent Mac source archive also builds without a parent project.
  const project = path.resolve(root, '..');
  const guard = path.join(project, 'distribution', 'check-versions.cjs');
  if (fs.existsSync(guard) && fs.existsSync(path.join(project, 'macos', 'package.json'))) {
    require(guard).checkVersions({ root: project });
  }
}
module.exports = { APP_NAME, BUNDLE_ID, IGNORE, buildOptions, packageDirectory, stripUnusedMacPermissions, retainMacRuntimeLicenses, checkWorkspaceVersion };
