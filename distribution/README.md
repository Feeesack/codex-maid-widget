# Installers and local integration

The Windows and macOS release candidate shares version **0.5.14**. Its installers include the application runtime, pinned offline semantic-search resources and optional Codex plugin connector. Candidate downloads remain unavailable until publication; the last published installers are 0.3.51. End users do not need Node.js, npm, a source checkout, or a separate API key. Real quota requires an installed, signed-in Codex desktop app. Optional companion chat and model-based memory maintenance use the signed-in ChatGPT account through Codex and consume its quota.

- [Download and installation](../docs/INSTALLATION.md)
- [Build commands and verification](../docs/BUILDING.md)
- [English README](../README.md) · [简体中文 README](../README.zh-CN.md)

## Layout

| Directory or file | Purpose |
| --- | --- |
| `windows/` | Windows installer compiler setup, packaging, lifecycle integration, and isolated installer checks |
| `integration/` | Shared local plugin payload and explicit connection launcher |
| `check-versions.cjs` | Require matching root and Mac release versions |
| `test/` | Release-version guard checks |
| `../macos/scripts/build-installer.cjs` | Universal macOS package construction |

From a current source checkout, build the target platform following the build guide. Windows outputs installers under `release/installers/`; macOS outputs under `macos/release/<version>/installers/`.

Connecting the local plugin is a user action performed by the installed connector; building or packaging must not install the plugin into the developer's personal Codex profile. Automated installer and lifecycle checks use isolated profiles or disposable CI runners.

Installers currently lack developer distribution certificates. The Mac application is ad-hoc signed and its package is not Apple-notarized. Publish the current installer and SHA-256 checksum together in GitHub Releases, keeping generated outputs and private runtime files outside source control.
