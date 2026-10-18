# Changelog

## 0.3.21 — 2026-10-18

Shared Windows and macOS release.

- Fix window-size growth during dragging at fractional Windows display scaling.
- Add optional display inside the Codex main window. Windows uses native child-window attachment to follow movement, minimization and restoration, with normal system occlusion by other windows and dialogs. macOS uses a separate window that follows Codex's bounds and visibility.
- Mirror the character when it crosses into the left half of the current screen or Codex window.
- Limit magnetic snapping to the two bottom corners. Add optional side-and-bottom peeking, continuous pointer-following dragging and interruptible settling after release.
- Add 3-second and 5-second bubble auto-collapse choices, with 5 seconds as the default. Preserve existing saved preferences, images and character libraries during upgrades.
- Expand isolated native, renderer and regression checks, and handle closed smoke-test output pipes.

Both window display and corner peeking are off by default. Manual Mac desktop acceptance is separate from CI. Installers remain without developer distribution certificates, and the Mac package is not Apple-notarized.

## 0.3.13 — 2026-10-17

- Keep filenames and edited character labels in the local UI, while returning fixed character labels from MCP tools.
- Add explicit local-plugin disconnection on both platforms. Windows offers it during interactive uninstallation; Mac includes a disconnection launcher in Applications. Other plugins and user data are retained.
- Read the Windows app-server handshake version from the application manifest, matching macOS and the shared release version.

## 0.3.12 — 2026-10-17

Initial public release, with one shared version for Windows and macOS.

- Windows x64 installer and macOS 13+ universal installer for Apple Silicon and Intel, including the application runtime and local plugin connector.
- Animated desktop companion with character images, themed thought bubbles, breathing and bounce interactions, and optional synthesized sound.
- Codex quota percentages, reset countdowns, multiple quota buckets, and configurable automatic refresh.
- Device-local token totals for today, the current week, and the most recently completed turn, with incomplete-record indicators.
- Current-user login helper and automatic widget startup and exit alongside Codex desktop.
- Saved position, edge snapping, mirrored layouts, size, opacity, always-on-top, click-through, custom phrases, and a local character library.
- Optional local MCP tools for widget status and fixed interaction controls, using the installer's bundled runtime.
- English and Simplified Chinese documentation; code under MIT and project-provided artwork under CC BY 4.0.

Validation includes Windows install/launch/control/MCP/upgrade/uninstall checks and universal Mac installation, startup, MCP, and launchd-helper checks on Apple Silicon and Intel macOS runners. Real-account and manual desktop-experience acceptance remains subject to broader user testing.

Installers currently lack developer distribution certificates; the Mac package is not Apple-notarized.
