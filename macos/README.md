# Codex Maid Widget for macOS

[English documentation](../README.md) · [简体中文文档](../README.zh-CN.md)

The Mac implementation shares release **0.3.21** with Windows. One universal installer supports Apple Silicon and Intel on macOS 13 or newer.

- [Download the Mac installer](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.21/Codex-Maid-Widget-0.3.21-macOS-universal.pkg)
- [Installation and plugin connection](../docs/INSTALLATION.md)
- [Build and validation details](../docs/BUILDING.md)
- [Artwork sources](docs/asset-provenance.md) and [artwork license](ARTWORK_LICENSE.md)

From this directory, on a Mac with Node.js 22.12 or newer and the macOS command-line development tools:

```sh
npm ci
npm test
npm run smoke
npm run check:native
npm run check:follow
npm run build:installer
```

The package is written under `release/0.3.21/installers/`. The build uses ad-hoc app signing; Developer ID signing and Apple notarization are not configured. Native login-helper registration tests are restricted to disposable GitHub Actions runners; see the build guide before running lifecycle tests.

The optional **仅在 Codex 窗口内显示** setting follows Codex with a separate widget window. It hides when another app is active or Codex is minimized; Windows native child-window attachment is not used on macOS. Bottom-corner peeking, continuous dragging, mirrored layouts, and the new 3/5-second bubble options are shared. The default bubble timeout is 5 seconds, while upgrades retain saved choices.

The Mac workflow checks the universal package on Apple Silicon and Intel runners. Those checks do not replace hands-on Mac acceptance, including Spaces, full screen, multiple displays, Retina scaling, audio, and login sessions.

Original code and documentation use [MIT](LICENSE). Project-provided character and application icon artwork uses [CC BY 4.0](ARTWORK_LICENSE.md). The OpenAI mark and other third-party materials remain excluded from the artwork grant; see [NOTICE](NOTICE).
