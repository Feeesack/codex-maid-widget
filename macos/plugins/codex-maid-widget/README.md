# Codex Maid Widget local plugin for macOS

[English project README](../../../README.md) · [简体中文项目说明](../../../README.zh-CN.md)

This optional plugin connects to the running local desktop widget. It exposes `get_widget_status` and `control_widget`; supported actions are show, hide, refresh, bounce, and open settings. It does not start or quit the desktop app automatically.

## Installed application

Choose **连接 Codex 工具…** from the widget's menu bar menu or use the installed connection launcher. It uses the bundled runtime, registers and installs the local plugin through the official Codex CLI, and does not need a separate Node.js installation. Restart Codex and start a new chat afterward.

## Source checkout on macOS

Use Node.js 22.12 or newer and a Codex CLI with local-plugin support. From the `macos` project directory:

```sh
sh install-plugin.command --register
```

The command prepares absolute runtime paths in this plugin's `.mcp.json` and registers this Mac project's marketplace. Restart Codex, select **Codex 女仆挂件 · 本地** in Plugins, install the widget plugin, and start a new chat. The source installer registers the marketplace; plugin installation is a separate user action.

To prepare paths without changing Codex marketplace registration:

```sh
sh install-plugin.command
```

Keep generated machine-specific paths out of commits. After moving a source checkout, rerun preparation before reinstalling the plugin. The root Windows marketplace and this Mac marketplace are alternative platform sources for the same plugin; use the appropriate project root.

Start the widget with `npm start`, `start.command`, or the installed app before calling tools. The widget and MCP server share `~/.codex-maid-widget` by default. Set `CODEX_MAID_HOME` consistently for both if using a custom data directory.

Local communication uses loopback and a per-launch random token. The token is not returned by tools, and the plugin does not expose arbitrary command execution or URL requests. See [installation](../../../docs/INSTALLATION.md) and [security guidance](../../../SECURITY.md).
