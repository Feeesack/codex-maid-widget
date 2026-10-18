# Codex Maid Widget

**English** | [简体中文](README.zh-CN.md)

A small desktop companion for Codex. It shows your remaining quota and local token usage, and gives a little “duang” when a turn finishes. If you've wandered off to your phone, that might be your cue to come back.

<img src="assets/icons/app-128.png" width="96" alt="Codex Maid Widget application icon">

<img src="docs/screenshots/widget-dragon-demo.png" width="228" alt="Widget preview with explicitly marked demo quota">

## Download and install

Windows and macOS share release version **v0.3.21**.

| Platform | Installer |
| --- | --- |
| Windows x64 | [Download Windows installer (.exe)](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.21/Codex-Maid-Widget-0.3.21-windows-x64-setup.exe) |
| macOS 13+, Apple Silicon and Intel | [Download universal Mac installer (.pkg)](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.21/Codex-Maid-Widget-0.3.21-macOS-universal.pkg) |

Release notes and SHA-256 checksums are on the [Releases](https://github.com/Feeesack/codex-maid-widget/releases) page. The installers include the runtime and optional local Codex plugin, so you don't need to install Node.js or npm, or download the source.

1. Install and sign in to the official Codex desktop app to see real account quota.
2. Run the installer, then open Codex Maid Widget from the Windows Start menu or macOS Applications folder.
3. Use the gear button, right-click the character, or open the system tray/menu bar menu to adjust settings.

The app's interface is currently in Simplified Chinese. The English and Chinese READMEs cover the same release.

The installers don't yet have developer distribution certificates. The Mac app is ad-hoc signed, and the package has not been notarized by Apple. Your operating system may ask you to confirm its source. Use the downloads from this repository's Releases page and check the supplied checksum.

## Features

- Quota percentages and reset countdowns, with support for multiple quota buckets. Updates happen automatically, or when you click refresh.
- Local token totals for today, this week, and the most recently completed turn.
- A bounce and optional short sound when the widget sees a newly completed turn: “duang.” You can also click the character or use a shortcut to trigger it yourself. It reacts to these events; it isn't a timed reminder.
- Automatic startup alongside Codex. A login helper waits in the background, opens the widget when Codex starts, and closes it after Codex fully quits. You can turn this off in settings.
- Two built-in characters, a local image library, custom phrases, and bubble colors that match the character.
- Dragging with a fixed character size, bottom-corner snapping, mirrored layouts, size and opacity settings, always-on-top, click-through, and remembered window placement. The character turns as you drag it across the screen's midpoint.
- Optional display inside the Codex window. On Windows, the character is attached to the main window and moves, minimizes and restores with it. On macOS, a separate widget window follows Codex's bounds and visibility.
- Optional head peeking at the two bottom corners. Drag inward to reveal the whole character; release near a bottom corner to let it settle back.
- Bubble auto-collapse after 3, 5, 10, 30 or 60 seconds, or keep it visible. The default is 5 seconds; saved choices are retained on upgrade.
- Breathing, bouncing, rolling numbers, and a shimmer on quota values. Sound is optional, and animations respect the system's reduced-motion setting.
- An optional local MCP plugin so Codex can read widget status, refresh quota, show or hide the widget, trigger a bounce, or open settings.

Quota percentages come from the account currently signed in to Codex. Token totals add up the available session logs from **all accounts on this device**, with the week starting on Monday in local time. The widget marks missing or incomplete records. These are local usage counts, not a bill or an account total across devices.

## Controls

| Action | Control |
| --- | --- |
| Move | Drag the character or bubble |
| Refresh | Click the bubble or refresh button |
| Change bubble view | Click `···`: quota, today, week, last turn, phrases |
| Bounce / interaction | Click the character or heart; press `Q` or Space while focused |
| Settings | Gear, right-click, or tray/menu bar |
| Show / hide | Windows `Ctrl+Alt+M`; Mac `Control+Option+M` |
| Bounce | Windows `Ctrl+Alt+Q`; Mac `Control+Option+Q` |
| Toggle click-through | Windows `Ctrl+Alt+Shift+M`; Mac `Control+Option+Shift+M` |
| Restore position / quit | Tray/menu bar menu |

If another app uses the same shortcut, you can use the tray/menu bar instead. Hover over the character to show a bubble that has been automatically hidden.

### Window display and corner peeking

Both options are off by default. On Windows, enable **固定在 Codex 窗口内** in settings to keep the character inside Codex. It follows the main window's movement and system minimize/restore animation. Other apps and dialogs cover it according to normal window ordering, and it does not float above them. Turning the option off restores the saved desktop position and always-on-top preference.

On macOS, the equivalent option is labelled **仅在 Codex 窗口内显示**. It uses a separate window, hides when another app is active or Codex is minimized, and does not use Windows native child-window attachment. Mac Spaces and full-screen behavior still need hands-on validation.

Enable **底角吸附时只露头部** to tuck the character behind the side and bottom edges at either bottom corner. Dragging inward gradually brings the full character into view; dragging outward keeps it following the pointer. Releasing near a bottom corner snaps it back with a short settling animation. Other edges do not attract the widget. This works in desktop mode and inside Codex.

### Automatic startup

Open the widget once after installation to register the login helper for your user account. **Follow Codex desktop** is on by default: the helper starts when you log in, waits for Codex, then opens the widget. Sending Codex to the background doesn't count as quitting it. If you quit the widget yourself, it stays closed until a new Codex desktop session starts.

Turning off the follow setting removes the helper's login registration. If the operating system blocks background startup, the settings page will report it. Check Startup Apps on Windows or Login Items & Extensions on macOS.

### Optional Codex tools

- **Windows:** select “Connect Codex plugin” at the end of installation, or use its Start menu shortcut.
- **macOS:** choose **连接 Codex 工具…** from the widget's menu bar menu, or use the installed connection launcher.

This registers a local plugin through the official Codex CLI. After connecting, restart Codex and start a new chat. Keep the widget running while using its tools. The connector uses the installer's bundled runtime, so no separate Node.js installation is needed. It only changes the connection setup when you choose to run it.

Before uninstalling a connected widget, use **Disconnect Codex plugin** in the Windows Start menu, or **Codex-Maid-Widget-断开 Codex.command** in Mac Applications. This removes the widget's local plugin, keeps your images and settings, and leaves other plugins alone. Restart Codex afterwards. The Windows uninstaller also offers this step; for silent uninstallation, disconnect first.

## Data and privacy

The widget gets quota from the local Codex app-server and reads token counter events from local session and archived-session logs. Codex handles authentication. The widget doesn't read the contents of `auth.json`, ask for an API key, or send prompts to a model. It has no application analytics.

Imported images still use their filenames as the default local names. Those names, including any labels you edit, stay out of MCP tool results; tools use fixed built-in labels or “自定义形象” (custom character).

Settings, imported character images, and local integration files live in `~/.codex-maid-widget`. The optional control interface listens only on loopback, uses a new random token each time the widget starts, and accepts a fixed set of widget actions. It can't run arbitrary commands or fetch URLs.

Please remove account details, credentials, personal paths, and conversation content before posting an issue or screenshot. To report a security issue, see [SECURITY.md](SECURITY.md).

## Build from source

You'll need Node.js **22.12 or newer** and a development environment for the platform you're building. The lockfiles pin dependency versions.

Windows, from the repository root:

```powershell
npm ci
npm test
npm run build
node distribution/windows/build.cjs
```

macOS, on a Mac:

```sh
cd macos
npm ci
npm test
npm run build:installer
```

Windows and macOS use the same release version. The build stops if their manifests disagree. Packaging instructions are in [distribution/README.md](distribution/README.md); contribution notes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Testing

Windows has been checked locally for installation, launch, local controls and MCP, upgrade, uninstall, dragging at fractional display scaling, and native containment. Source tests cover rendering, settings, data parsing, corner peeking, and following Codex as it starts and quits. The Mac workflow builds a universal package and checks installation, launch, MCP, and the launchd helper on Apple Silicon and Intel runners.

Those automated checks can't cover every account or desktop setup. Real signed-in accounts and Mac use with multiple monitors, Spaces, Retina displays, audio, and login sessions still need broader hands-on testing.

## Acknowledgements and licenses

- All character illustrations and app icon artwork were generated with **GPTimage2.5**. The different icon sizes and platform formats come from that artwork. Bundled project artwork is licensed under [CC BY 4.0](licenses/CC-BY-4.0.txt). If you reuse it, credit **Codex Maid Widget contributors** and link to this repository. See [asset provenance](docs/asset-provenance.md).
- Thanks to the maintainers and contributors of [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget), the DeepSeek/DSH whale widget. Its companion, speech bubble, drag-and-snap behavior, and interactions inspired this project.
- [Yang-huai406/Codex-Whale-Public](https://github.com/Yang-huai406/Codex-Whale-Public) was another reference for a Codex desktop companion. The visibility recovery module adapts its MIT-licensed implementation and retains the license notice. The interface, artwork and quota reader are separate; neither reference project's whale artwork, animations nor audio is redistributed here.
- This app uses [Electron](https://www.electronjs.org/), [Node.js](https://nodejs.org/), [Inno Setup](https://jrsoftware.org/isinfo.php), and the Codex app-server and plugin interfaces. Their licenses remain with their respective authors.
- The bundled OpenAI mark comes from the [official OpenAI Agents repository](https://github.com/openai/openai-agents-python/blob/main/docs/assets/logo.svg). It is not covered by this project's artwork license, and its inclusion grants no trademark rights or endorsement.

The original code is licensed under [MIT](LICENSE). See [NOTICE](NOTICE) and [asset provenance](docs/asset-provenance.md) for artwork and third-party notices. This is a community project, unaffiliated with OpenAI.
