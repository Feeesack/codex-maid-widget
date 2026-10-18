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
npm test
npm run smoke
npm run check:native
npm run check:drag-dpi
npm run check:window
npm run check:follow
npm run build
node distribution/windows/build.cjs
node distribution/windows/test-install.cjs
```

`npm run build` produces the complete portable application at `release/Codex-Maid-Widget-win32-x64/`. The installer builder packages it with the local plugin connector and writes the `.exe` and its checksum under `release/installers/`.

The installer builder uses Inno Setup. If its local compiler is missing, the bootstrap script downloads the pinned official compiler and verifies its checksum and publisher signature. You may instead provide its executable through `ISCC_PATH`.

The installer test uses a dedicated temporary installation and isolated widget/Codex profiles. It verifies installation, runtime controls, bundled-runtime MCP, upgrade, uninstall, and user-data preservation. It must not be redirected to a real user's installation or personal Codex profile.

## macOS universal package

Use a Mac with macOS development tools, including the command-line tools needed by `lipo`, `codesign`, `pkgbuild`, and `productbuild`:

```sh
cd macos
npm ci
npm test
npm run smoke
npm run check:native
npm run check:follow
npm run build:installer
```

The installer builder creates one package for Apple Silicon and Intel under `macos/release/<version>/installers/`, with a SHA-256 checksum. It checks universal executables, application layout, embedded runtime and connector, resource permissions, and app signatures.

The app uses an ad-hoc signature. Developer ID Application/Installer signing and Apple notarization are not configured. A successful build does not imply notarization.

## CI and lifecycle tests

The macOS workflow builds one universal installer and installs that same artifact on Apple Silicon and Intel macOS runners. It checks installed-app startup, embedded-runtime MCP, rendering and follow behavior, and the native login helper.

Window display uses different platform mechanisms: Windows attaches a native child window to the Codex main window; macOS uses a separate window constrained to Codex's bounds and visibility. A Windows containment check does not verify Mac Spaces or full-screen behavior. Report native runner results and manual desktop acceptance separately.

`macos/scripts/check-macos-startup.cjs` exercises real launchd registration, removal, and cleanup. It is restricted to an isolated GitHub Actions runner and is not a daily local-development command. Do not change its isolation guard or run startup tests against personal login items.

`check:follow` uses isolated simulated client lifecycles. Real Codex sessions, authentication, and personal startup/plugin settings must remain outside test fixtures.

On Windows, `check:drag-dpi` runs the production drag handlers against native Electron windows at 100%, 125%, 150%, 175%, and 200% device scale. Each isolated profile compares the previous position-only behavior with fixed preferred bounds, including repeated movement, immediate left/right mirroring, bottom-corner snapping and free placement near other edges. It records normal pixel rounding separately and requires the fixed size range to stay within one DIP. It does not move the user's cursor or load personal widget/Codex profiles.

`check:window` creates a separate Electron host and exercises the production native provider and containment adapter with isolated profiles. It checks real child composition, fixed geometry, native modal pickers, minimization and restoration, visibility recovery, style-cache loss and surface recreation, and clean detachment. It does not attach to or control the user's Codex window. Cross-process attachment requires matching HWND DPI-awareness contexts.

## Optional checks

```sh
node --test distribution/integration/test/*.test.cjs
```

Rendering and native tests require a working desktop environment. Demo mode (`npm run demo`) uses visibly labelled sample data. Real-account probing is optional and should never be used to populate public screenshots or CI logs with personal account data.

## Release outputs

Upload current installers and their SHA-256 checksums as GitHub Release assets. Source control should contain current source, necessary runtime assets, tests, build configuration, licenses, and public documentation. Exclude dependency trees, generated installers, temporary builds, logs, credentials, personal profiles, chat backups, and development-history archives.

Check [installation instructions](INSTALLATION.md), [security guidance](../SECURITY.md), and [artwork licensing](../ARTWORK_LICENSE.md) when preparing a release.
