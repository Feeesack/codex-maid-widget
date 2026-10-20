# Codex Maid Widget for macOS

[English documentation](../README.md) · [简体中文文档](../README.zh-CN.md)

Contact: [feeesack9449@gmail.com](mailto:feeesack9449@gmail.com)

Windows and macOS share release version **0.3.51**. The universal installer targets Apple Silicon and Intel on macOS 13 or newer. This release adds Simplified Chinese / English settings, reviewed English copy and the [PR #1](https://github.com/Feeesack/codex-maid-widget/pull/1) window-identification, smooth-following, stacking-recovery and focus-clipping fixes. Chinese remains the default; custom names, phrases and project names stay as written. See the [0.3.51 release notes](../docs/releases/0.3.51.md).

Shared features include conversation context/Git status, compaction totals, local account reset countdowns, paired press/release interactions and five sound choices including DSH Duck. The built-in list starts with 小龙娘-托腮 and 小龙娘-端庄, followed by the original mint maid and lilac dragon maid; 小龙娘-托腮 is the default for fresh settings and the fallback after removing the selected custom character. Existing valid selections and user-defined names are retained. See the [bilingual release notes](../docs/releases/0.3.48.md) and [audio source/license scope](docs/interaction-audio.md).

Settings hide the corner-hiding sliders until peeking is enabled, preview changes while dragging and save on release. Bottom hiding defaults to 50% and side hiding to 100%; saved values are retained.

The renderer also supports live size/opacity previews, Motion-powered mirroring, Hugeicons controls, previous/next arrows and a page editor with SortableJS ordering, visibility and default selection. The universal package is built on a native Mac runner, with installation, launch, MCP, native window and launchd-helper checks on Apple Silicon and Intel runners. These checks do not establish hands-on Mac acceptance.

- [Download the Mac installer](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.51/Codex-Maid-Widget-0.3.51-macOS-universal.pkg)
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

When explicitly preparing a release, the source writes the package under `release/<version>/installers/` within this Mac source tree. The build uses ad-hoc app signing; Developer ID signing and Apple notarization are not configured. Native login-helper registration tests are restricted to disposable GitHub Actions runners; see the build guide before running lifecycle tests.

The optional **仅在 Codex 窗口内显示** setting follows Codex with a separate widget window. It hides when another app is active or Codex is minimized; Windows native child-window attachment is not used on macOS. Bottom-corner peeking, continuous dragging, mirrored layouts, and the new 3/5-second bubble options are shared. The default bubble timeout is 5 seconds, while upgrades retain saved choices.

The Mac workflow checks the universal package on Apple Silicon and Intel runners. Those checks do not replace hands-on Mac acceptance, including Spaces, full screen, multiple displays, Retina scaling, audio, and login sessions.

Original code and documentation use [MIT](LICENSE). The original mint maid, lilac dragon maid and application icon artwork use [CC BY 4.0](ARTWORK_LICENSE.md). The supplied 小龙娘 images have authorization for built-in use and naming in this project, with no additional copyright or reuse license asserted here. The OpenAI mark and other third-party materials remain excluded from the artwork grant; see [NOTICE](NOTICE).
