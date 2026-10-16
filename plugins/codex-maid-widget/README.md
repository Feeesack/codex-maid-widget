# Codex Maid Widget local plugin

[English project README](../../README.md) · [简体中文项目说明](../../README.zh-CN.md)

This optional plugin connects to the running local desktop widget. It exposes `get_widget_status` and `control_widget`; supported actions are show, hide, refresh, bounce, and open settings. It does not start or quit the desktop app automatically.

## Installed application

Use the **连接 Codex 插件** shortcut supplied by the Windows installer. It uses the bundled runtime, registers and installs the plugin through the official Codex CLI, and does not need a separate Node.js installation. Restart Codex and start a new chat afterward.

## Source checkout on Windows

Use Node.js 22.12 or newer and a Codex CLI with local-plugin support. From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

The script writes local absolute runtime paths into this plugin's `.mcp.json` and registers the repository marketplace. Restart Codex, select **Codex 女仆挂件 · 本地** in Plugins, install the widget plugin, and start a new chat. The source installer registers the marketplace; plugin installation is a separate user action.

Append `-PrepareOnly` to prepare local paths without registering the marketplace. Keep generated machine-specific paths out of commits. After moving a source checkout, rerun the preparation script before reinstalling the plugin.

Start the desktop widget with `npm start`, `start.cmd`, or the installed application before calling tools. The widget and MCP server share `~/.codex-maid-widget` by default. Set `CODEX_MAID_HOME` consistently for both if using a custom data directory.

Local communication uses loopback and a per-launch random token. The token is not returned by tools, and the plugin does not expose arbitrary command execution or URL requests. See [installation](../../docs/INSTALLATION.md) and [security guidance](../../SECURITY.md).
