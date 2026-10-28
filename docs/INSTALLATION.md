# Installation and everyday use

[English README](../README.md) · [简体中文 README](../README.zh-CN.md)

## Current installers

Both platforms use candidate version **v0.5.14**. These are planned download locations and become available after publication. The last published installers remain [v0.3.51](https://github.com/Feeesack/codex-maid-widget/releases/tag/v0.3.51).

| Platform | Download |
| --- | --- |
| Windows x64 | [Windows setup.exe, pending release](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.5.14/Codex-Maid-Widget-0.5.14-windows-x64-setup.exe) |
| macOS 13+, Apple Silicon and Intel | [Mac universal.pkg, pending release](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.5.14/Codex-Maid-Widget-0.5.14-macOS-universal.pkg) |

The planned [Release page](https://github.com/Feeesack/codex-maid-widget/releases/tag/v0.5.14) will provide SHA-256 checksums. Installers include Electron, the local semantic-search resources and the optional Codex-plugin connector; you do not need Node.js, npm, a source checkout, or a separate API key.

Real quota requires the official Codex desktop app to be installed and signed in. Optional companion chat requires a ChatGPT login accepted by the installed Codex client and a verified available model. The widget does not sign you in or include account credentials. Chat and model-based memory maintenance consume that account's quota; quota display alone makes no model requests.

## Windows

1. Download and run the Windows installer.
2. Choose the installation location and optional shortcuts. Installation defaults to the current user's application area and does not need administrator privileges.
3. Optionally select **连接 Codex 插件** (connect Codex plugin) and launch the widget at the end of setup.
4. Later, use the Start menu to launch either the widget or the plugin connector.

Use Windows **Installed apps** to uninstall. If you connected the local plugin, choose **Disconnect Codex plugin** in the Start menu first and restart Codex. Interactive uninstallation also offers to disconnect it before removing the runtime; a failed disconnect stops uninstallation so you can retry. Choosing to keep the connection can leave a plugin pointing at a removed runtime. Silent uninstallation never changes Codex configuration, so disconnect first when needed. Personal settings and imported images are retained. Upgrades and uninstallation operate on the selected installed widget, without closing Codex or other portable copies.

## macOS

1. Download and open the universal `.pkg`.
2. Follow the installer to install the app in `/Applications`; macOS may request administrator authentication.
3. Open **Codex-Maid-Widget** from Applications.
4. To enable chat tools, choose **Connect Codex tools…** (**连接 Codex 工具…**) from the widget's menu bar menu, or open the installed connection launcher.

Before removing a connected Mac app, run **Codex-Maid-Widget-断开 Codex.command** from Applications and restart Codex. Then disable **跟随 Codex 桌面端** in the widget settings to remove the login helper and quit the widget. Move the app and its connection/disconnection launchers from Applications to the Trash. Personal settings and imported images remain in the widget data directory.

## Startup and settings

Open the installed widget once to register its current-user helper. The default **跟随 Codex 桌面端** setting enables a helper at login; it waits for Codex and opens the widget when Codex starts. Fully quitting Codex closes the widget. Closing only the Codex window while the client remains in the background does not end its session.

Use the gear, right-click, or tray/menu bar for settings. Turn off the follow setting to remove its login registration. If system policy blocks startup, the settings page shows the issue; review Windows Startup Apps or macOS Login Items & Extensions.

The separate window display option is off by default. On Windows, **Stay inside the Codex window** (**固定在 Codex 窗口内**) keeps an independent top-level widget within the Codex main window's bounds and uses an owner relationship for window ordering. It moves and minimizes/restores with Codex while accepting normal text input; other applications cover it normally. On Mac, **Show only inside the Codex window** (**仅在 Codex 窗口内显示**) keeps a separate widget window inside Codex's bounds and hides it when another app is active or Codex is minimized. Turning the option off restores the saved desktop position and always-on-top preference.

**Peek from a bottom corner** (**底角吸附时只露头部**) is also off by default. It tucks the character behind the side and bottom edges when it snaps to either bottom corner. Drag inward to reveal the whole character; release near a bottom corner to settle back. Bubble auto-collapse supports 3, 5, 10, 30 and 60 seconds, or always visible. The default is 5 seconds, and upgrades retain any saved timeout.

## Companion chat

Companion chat and the optional control plugin are separate features. To chat, enable its bubble page in Settings and create or resume a dedicated project from the chat-management window. Choose a location you want to keep: it stores checkpoint archives, original attached images, memory revisions, retrieval indexes and native chat usage records. Enter adds a line, Ctrl+Enter on Windows or Cmd+Enter on Mac sends, and Escape collapses the writing card.

Messages, images and selected project memory are sent through Codex to the model service. Checkpoint and dream maintenance can also make model requests. Review automatic/manual dream mode in the maintenance page after creating a project; automatic mode can run when the documented idle, quota and maintenance conditions are met. Its budget is an estimate rather than an absolute charge limit. Do not place data in the project that you do not want included in model context.

## Optional Codex tools

Run the installed connector only when you want the plugin. It uses the official Codex CLI to register and install a local plugin source in your widget data directory. Restart Codex and begin a new chat after connecting. Keep the widget running for tool calls.

The tools can read widget status and perform fixed actions: show, hide, refresh, bounce, and open settings. No arbitrary command or URL interface is exposed.

Disconnection uses the official CLI to remove only `codex-maid-widget@codex-maid-installed`. It keeps the local source and user data, and does not remove other plugins. You can reconnect later using the same connector. The app's bundled connector also accepts `--remove` (or `--uninstall`) for an explicit command-line disconnection.

## Data location and interpretation

Settings, imported images, and integration files are stored in `~/.codex-maid-widget`. Imported images are copied there, so deleting the original image does not remove the saved character. The widget and connector should use the same data directory.

Imported filenames and edited character labels remain local. MCP status uses fixed built-in labels or a generic custom-character label instead of those names.

Quota percentages reflect the currently signed-in Codex account. Token totals combine available local logs from all accounts on this device; the week begins Monday in local time. Incomplete records are labelled. These numbers are not a monetary bill or a cross-device account total.

The separate companion-chat ledger records only that project's native request usage. Missing fields remain unknown; cached input is part of input, and reasoning output is part of output. Do not add those subsets twice or infer exact task cost from shared account quota changes. Switching accounts on one device does not automatically create a different companion identity or project.

## Source confirmation and troubleshooting

Installers currently lack developer distribution certificates. The Mac application is ad-hoc signed and the package is not Apple-notarized. Confirm the repository and checksum before accepting any operating-system source warning. Use the operating system's normal source-confirmation interface; do not disable system-wide protections.

For connection trouble, first confirm that Codex itself is installed, signed in, and can reach its service. Quota refresh depends on that connection. Retry the installed connector after updating Codex if plugin commands are unavailable.

When reporting a problem, include the version, platform/architecture, reproduction steps, and redacted screenshots. Never attach credentials, full configurations, raw conversation logs, or local control tokens. See [SECURITY.md](../SECURITY.md) for private vulnerability reporting.
