[CmdletBinding()]
param(
    [switch]$PrepareOnly,
    [string]$CodexCli
)

$ErrorActionPreference = 'Stop'
$maidProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$maidPluginRoot = Join-Path $maidProjectRoot 'plugins\codex-maid-widget'
$maidServerFile = Join-Path $maidPluginRoot 'mcp.cjs'
if (!(Test-Path -LiteralPath $maidServerFile -PathType Leaf)) {
    throw 'Plugin files are missing. Extract the complete project before running this script.'
}

$maidNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$maidNode) { throw 'Node.js is required. Install Node.js 22 or newer, reopen the terminal, and retry.' }
$maidNodeVersion = & $maidNode.Source --version
if ($LASTEXITCODE -ne 0 -or $maidNodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'Node.js 22 or newer is required.'
}

# Write absolute paths before Codex caches the plugin. This also works with
# compatibility clients that do not expand PLUGIN_ROOT in .mcp.json.
$maidServer = [ordered]@{
    command = $maidNode.Source
    args = @($maidServerFile)
}
if ($env:CODEX_MAID_HOME) {
    $maidServer['env'] = @{ CODEX_MAID_HOME = [IO.Path]::GetFullPath($env:CODEX_MAID_HOME) }
}
$maidMcp = @{ mcpServers = @{ maid = $maidServer } } | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $maidPluginRoot '.mcp.json'), $maidMcp + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Host 'Prepared local MCP configuration with absolute Node.js and server paths.'

if ($PrepareOnly) {
    Write-Host 'Preparation complete. No Codex user settings were changed.'
    Write-Host 'Restart Codex, open Plugins, select Codex Maid Widget local marketplace, and install the plugin.'
    exit 0
}

if (!$CodexCli) {
    $maidCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($maidCodexCommand) { $CodexCli = $maidCodexCommand.Source }
}
if (!$CodexCli) {
    Write-Warning 'Codex CLI was not found. The repo marketplace is ready; reopen this project in Codex and install from Plugins, or rerun with -CodexCli.'
    exit 0
}
if (!(Test-Path -LiteralPath $CodexCli -PathType Leaf)) { throw 'The specified Codex CLI path does not exist.' }

# Use the supported CLI registration flow rather than editing config.toml.
& $CodexCli plugin marketplace add $maidProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Marketplace registration failed. Use a Codex CLI with plugin marketplace support, or use the repo marketplace from Codex Plugins.'
}
Write-Host 'Marketplace registered. Restart Codex, open Plugins, select the Codex Maid Widget local marketplace, and install the maid widget.'
Write-Host 'Start the desktop companion with start.cmd before calling its tools. Open a new Codex chat after installing.'
