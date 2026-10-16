# Installation and everyday use

[English README](../README.md) · [简体中文 README](../README.zh-CN.md)

## Current installers

Both platforms use **v0.3.12**.

| Platform | Download |
| --- | --- |
| Windows x64 | [Windows setup.exe](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.12/Codex-Maid-Widget-0.3.12-windows-x64-setup.exe) |
| macOS 13+, Apple Silicon and Intel | [Mac universal.pkg](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.12/Codex-Maid-Widget-0.3.12-macOS-universal.pkg) |

The [Release page](https://github.com/Feeesack/codex-maid-widget/releases/tag/v0.3.12) provides SHA-256 checksums. Installers include Electron and the optional local Codex-plugin connector; you do not need Node.js, npm, a source checkout, or an API key.

Real quota requires the official Codex desktop app to be installed and signed in. The widget does not sign you in or include account credentials.

## Windows

1. Download and run the Windows installer.
2. Choose the installation location and optional shortcuts. Installation defaults to the current user's application area and does not need administrator privileges.
3. Optionally select **连接 Codex 插件** (connect Codex plugin) and launch the widget at the end of setup.
4. Later, use the Start menu to launch either the widget or the plugin connector.

Use Windows **Installed apps** to uninstall. Personal settings and imported images are retained. Upgrades and uninstallation operate on the selected installed widget, without closing Codex or other portable copies.

## macOS

1. Download and open the universal `.pkg`.
2. Follow the installer to install the app in `/Applications`; macOS may request administrator authentication.
3. Open **Codex-Maid-Widget** from Applications.
4. To enable chat tools, choose **连接 Codex 工具…** from the widget's menu bar menu, or open the installed connection launcher.

Before removing the Mac app, disable **跟随 Codex 桌面端** in its settings to remove the login helper, then quit the widget. Move the app and its connection launcher from Applications to the Trash. Personal settings and imported images remain in the widget data directory.

## Startup and settings

Open the installed widget once to register its current-user helper. The default **跟随 Codex 桌面端** setting enables a helper at login; it waits for Codex and opens the widget when Codex starts. Fully quitting Codex closes the widget. Closing only the Codex window while the client remains in the background does not end its session.

Use the gear, right-click, or tray/menu bar for settings. Turn off the follow setting to remove its login registration. If system policy blocks startup, the settings page shows the issue; review Windows Startup Apps or macOS Login Items & Extensions.

## Optional Codex tools

Run the installed connector only when you want the plugin. It uses the official Codex CLI to register and install a local plugin source in your widget data directory. Restart Codex and begin a new chat after connecting. Keep the widget running for tool calls.

The tools can read widget status and perform fixed actions: show, hide, refresh, bounce, and open settings. No arbitrary command or URL interface is exposed.

## Data location and interpretation

Settings, imported images, and integration files are stored in `~/.codex-maid-widget`. Imported images are copied there, so deleting the original image does not remove the saved character. The widget and connector should use the same data directory.

Quota percentages reflect the currently signed-in Codex account. Token totals combine available local logs from all accounts on this device; the week begins Monday in local time. Incomplete records are labelled. These numbers are not a monetary bill or a cross-device account total.

## Source confirmation and troubleshooting

Installers currently lack developer distribution certificates. The Mac application is ad-hoc signed and the package is not Apple-notarized. Confirm the repository and checksum before accepting any operating-system source warning. Use the operating system's normal source-confirmation interface; do not disable system-wide protections.

For connection trouble, first confirm that Codex itself is installed, signed in, and can reach its service. Quota refresh depends on that connection. Retry the installed connector after updating Codex if plugin commands are unavailable.

When reporting a problem, include the version, platform/architecture, reproduction steps, and redacted screenshots. Never attach credentials, full configurations, raw conversation logs, or local control tokens. See [SECURITY.md](../SECURITY.md) for private vulnerability reporting.
