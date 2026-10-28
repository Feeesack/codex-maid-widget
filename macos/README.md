# Codex Maid Widget for macOS

[English documentation](../README.md) · [简体中文文档](../README.zh-CN.md)

Contact: [feeesack9449@gmail.com](mailto:feeesack9449@gmail.com)

Windows and macOS share released version **0.5.14**. The universal installer targets Apple Silicon and Intel on macOS 13 or newer. This release adds companion text/image chat, persistent memory and offline archives, native chat usage records, seven chat-management pages, five settings categories, an expandable writing card, reset forecasts and bounded public announcement reminders. Announcement, observation, Tibo self-report and real quota confirmation remain separate; stale public data never blocks startup. Chinese remains the default; custom names, phrases and project names stay as written. See the [changelog](../CHANGELOG.md) and [release notes](../docs/releases/0.5.14.md). The latest installers are on the [v0.5.14 release page](https://github.com/Feeesack/codex-maid-widget/releases/tag/v0.5.14).

Shared features include conversation context/Git status, compaction totals, local account reset countdowns, paired press/release interactions and five sound choices including DSH Duck. The built-in list starts with 小龙娘-托腮 and 小龙娘-端庄, followed by the original mint maid and lilac dragon maid; 小龙娘-托腮 is the default for fresh settings and the fallback after removing the selected custom character. Existing valid selections and user-defined names are retained. See the [bilingual release notes](../docs/releases/0.3.48.md) and [audio source/license scope](docs/interaction-audio.md).

Settings hide the corner-hiding sliders until peeking is enabled, preview changes while dragging and save on release. Bottom hiding defaults to 50% and side hiding to 100%; saved values are retained.

The renderer also supports live size/opacity previews, Motion-powered mirroring, Hugeicons controls, previous/next arrows and a page editor with SortableJS ordering, visibility and default selection. Native Mac build and installer validation for 0.5.14 are pending; Windows tests of the shared source do not establish native Mac or hands-on acceptance.

- [Planned Mac installer location, available after release](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.5.14/Codex-Maid-Widget-0.5.14-macOS-universal.pkg)
- [Installation and plugin connection](../docs/INSTALLATION.md)
- [Build and validation details](../docs/BUILDING.md)
- [Artwork sources](docs/asset-provenance.md) and [artwork license](ARTWORK_LICENSE.md)

From this directory, on a Mac with Node.js 22.12 or newer and the macOS command-line development tools:

```sh
npm ci
node scripts/prepare-chat-semantic.cjs --download
npm test
npm run smoke
npm run check:native
npm run check:follow
npm run build:installer
```

When explicitly preparing a release, the source writes the package under `release/<version>/installers/` within this Mac source tree. The build uses ad-hoc app signing; Developer ID signing and Apple notarization are not configured. Native login-helper registration tests are restricted to disposable GitHub Actions runners; see the build guide before running lifecycle tests.

The optional **仅在 Codex 窗口内显示** setting follows Codex with a separate widget window. It hides when another app is active or Codex is minimized. Bottom-corner peeking, continuous dragging, mirrored layouts and the 3/5-second bubble options are shared. The default bubble timeout is 5 seconds, while upgrades retain saved choices.

The Mac workflow checks the universal package on Apple Silicon and Intel runners. Those checks do not replace hands-on Mac acceptance, including Spaces, full screen, multiple displays, Retina scaling, audio, and login sessions.

Companion chat uses the signed-in ChatGPT account through Codex and consumes quota. Messages, attached images and selected project memory are sent to the model service; checkpoint and automatic dream maintenance can also make model requests. Review the dream mode after creating a project and choose manual mode if you prefer to start those jobs yourself. Quota displays do not send model prompts, and no separate API key is needed. See [data and privacy](../README.md#data-and-privacy).

Original code and documentation use [MIT](LICENSE). The original mint maid, lilac dragon maid and application icon artwork use [CC BY 4.0](ARTWORK_LICENSE.md). The supplied 小龙娘 images have authorization for built-in use and naming in this project, with no additional copyright or reuse license asserted here. The OpenAI mark and other third-party materials remain excluded from the artwork grant; see [NOTICE](NOTICE).
