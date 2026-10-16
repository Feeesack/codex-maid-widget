'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { parseArgs } = require('node:util');
const { buildOptions } = require('./build-config.cjs');
const { verifyPackage } = require('./verify-package.cjs');
const { writeMacIcon } = require('./mac-icon.cjs');

async function main({ arch, argv = process.argv.slice(2) } = {}) {
  const { values } = parseArgs({ args: argv, options: { arch: { type: 'string' } } });
  const root = path.resolve(__dirname, '..');
  const options = buildOptions({ root, arch: arch || values.arch });
  if (!fs.existsSync(path.join(root, 'assets', 'maid.png'))) throw new Error('缺少 assets/maid.png 角色素材');
  // Frameworks in a .app contain real symlinks. Fail before runtime downloads
  // instead of letting Packager silently skip a target on this Windows host.
  if (process.platform === 'win32') {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-build-symlink-'));
    try {
      fs.writeFileSync(path.join(probe, 'target'), 'test');
      fs.symlinkSync('target', path.join(probe, 'link'));
    } catch (error) {
      throw new Error('当前 Windows 无法创建 macOS .app 必需的符号链接（' + error.code + '）。请在 Mac 执行 npm ci && npm run build:mac，或运行 macOS 手动构建工作流。详见 docs/macos.md；无需下载虚拟机或更改系统权限。');
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  }
  writeMacIcon(root);
  const { packager } = await import('@electron/packager');
  const output = await packager(options);
  if (output.length !== 1) throw new Error('打包未生成唯一目标；禁止将跳过或旧目录报告为成功。');
  const result = await verifyPackage({ directory: output[0], arch: options.arch });
  console.log(`Verified macOS/${result.arch} app v${result.version}: ${output[0]}`);
  console.log(process.platform === 'darwin' ? 'Local ad-hoc signature verified. This is not an Apple Developer ID notarized distribution.' : 'Cross-built app: native execution and signing must still be verified on macOS.');
  return output[0];
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
