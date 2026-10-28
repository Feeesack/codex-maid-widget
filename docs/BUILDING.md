# Build and verification

Build on the target operating system with **Node.js 22.12 or newer** and npm. Install dependencies with `npm ci` to use the committed lockfiles. Running or installing a packaged release does not require Node.js or npm.

## Shared version

The root `package.json` is the shared release-version source. Root and Mac package manifests and lockfiles must agree. Run this from the repository root:

```sh
node distribution/check-versions.cjs
node --test distribution/test/version.test.cjs
```

Keep both platform versions aligned when preparing a release.

## Windows x64

Run in PowerShell from the repository root:

```powershell
npm ci
node scripts/prepare-chat-semantic.cjs --download
npm test
npm run smoke
npm run check:native
npm run check:drag-dpi
npm run check:window
npm run check:follow
npm run build
```

The explicit preparation command downloads the pinned public multilingual encoder and verifies its revision, byte lengths and SHA-256 hashes. It sends no chat records. Later builds can use `node scripts/prepare-chat-semantic.cjs` to verify existing resources without downloading. Runtime inference is local CPU only and never downloads a model. Build from a clean controlled source tree with a real dependency installation: production dependency junctions or symlinks are rejected. Install with `npm ci` in that tree instead of linking the development workspace's `node_modules`.

`npm run build` produces the portable application at `release/Codex-Maid-Widget-win32-x64/`. Production dependencies and model resources are copied into its `resources` directory; running it needs no development Node.js, Python, GPU or network model service. Use a separate build output and the project's local upgrade procedure when the application is already running; preserve the old application and user data.

Only after an explicit release request, run `node distribution/windows/build.cjs` and `node distribution/windows/test-install.cjs` to generate and verify an installer. Daily local updates do not generate installers.

The installer builder uses Inno Setup. If its local compiler is missing, the bootstrap script downloads the pinned official compiler and verifies its checksum and publisher signature. You may instead provide its executable through `ISCC_PATH`.

The installer test uses a dedicated temporary installation and isolated widget/Codex profiles. It verifies installation, runtime controls, bundled-runtime MCP, upgrade, uninstall, and user-data preservation. It must not be redirected to a real user's installation or personal Codex profile.

## macOS universal package

Use a Mac with macOS development tools, including the command-line tools needed by `lipo`, `codesign`, `pkgbuild`, and `productbuild`:

```sh
cd macos
npm ci
node scripts/prepare-chat-semantic.cjs --download
npm test
npm run smoke
npm run check:native
npm run check:follow
npm run build:mac
```

Install dependencies on the target Mac architecture. The build checks ONNX CPU and Sharp resources for the requested target and fails if they are missing, instead of silently packaging another platform's native modules. Universal builds require both arm64 and x64 native dependency resources; single-architecture dependency installation alone does not prove universal readiness. Native Mac build and manual experience must be checked on macOS separately from Windows source tests.

Only after an explicit release request, `npm run build:installer` creates a package under `macos/release/<version>/installers/` with a SHA-256 checksum. It checks universal executables, application layout, embedded runtime and connector, resource permissions, and app signatures.

The app uses an ad-hoc signature. Developer ID Application/Installer signing and Apple notarization are not configured. A successful build does not imply notarization.

## CI and lifecycle tests

The macOS workflow builds one universal installer and installs that same artifact on Apple Silicon and Intel macOS runners. It checks installed-app startup, embedded-runtime MCP, rendering and follow behavior, and the native login helper.

Window display uses different platform mechanisms. The production Windows follow path is an independent top-level widget owned by the Codex main window; it follows the host's bounds and minimizes/restores with it, without attaching the windows' input queues. macOS uses a separate window constrained to Codex's bounds and visibility. A Windows containment check does not verify Mac Spaces or full-screen behavior. Report native runner results and manual desktop acceptance separately.

`macos/scripts/check-macos-startup.cjs` exercises real launchd registration, removal, and cleanup. It is restricted to an isolated GitHub Actions runner and is not a daily local-development command. Do not change its isolation guard or run startup tests against personal login items.

`check:follow` uses isolated simulated client lifecycles. Real Codex sessions, authentication, and personal startup/plugin settings must remain outside test fixtures.

On Windows, `check:drag-dpi` runs the production drag handlers against native Electron windows at 100%, 125%, 150%, 175%, and 200% device scale. Each isolated profile compares the previous position-only behavior with fixed preferred bounds, including repeated movement, immediate left/right mirroring, bottom-corner snapping and free placement near other edges. It records normal pixel rounding separately and requires the fixed size range to stay within one DIP. It does not move the user's cursor or load personal widget/Codex profiles.

`check:window` creates a separate Electron host and exercises the native provider and containment adapter with isolated profiles. It covers fixed geometry, native modal pickers, minimization and restoration, visibility recovery, style-cache loss and surface recreation, plus the retained child-window compatibility path. Older child-composition checks do not establish acceptance of the production owned-top-level input and stacking behavior. The check does not attach to or control the user's Codex window. Cross-process child attachment in that compatibility path requires matching HWND DPI-awareness contexts.

## Optional checks

```sh
node --test distribution/integration/test/*.test.cjs
```

Rendering and native tests require a working desktop environment. Demo mode (`npm run demo`) uses visibly labelled sample data. Real-account probing is optional and should never be used to populate public screenshots or CI logs with personal account data.

The hosted Windows workflow selects a supported display mode of at least 1920×1080 before the complete DPI matrix, so its largest widget still fits at 200% scaling. `scripts/configure-ci-display.ps1` refuses to change a developer desktop or a self-hosted runner; failed geometry checks retain only isolated reports as CI artifacts.

## Release outputs

Upload current installers and their SHA-256 checksums as GitHub Release assets. Source control should contain current source, necessary runtime assets, tests, build configuration, licenses, and public documentation. Exclude dependency trees, generated installers, temporary builds, logs, credentials, personal profiles, chat backups, and development-history archives.

Check [installation instructions](INSTALLATION.md), [security guidance](../SECURITY.md), and [artwork licensing](../ARTWORK_LICENSE.md) when preparing a release.
