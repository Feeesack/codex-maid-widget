[CmdletBinding()]
param([switch]$Quiet, [switch]$Remove, [string]$CodexCli)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$maidTitle = if ($Remove) { '断开 Codex 女仆挂件' } else { '连接 Codex 女仆挂件' }
if (!$Quiet) {
    $maidPrompt = if ($Remove) { '将通过 Codex 自带的命令行卸载本项目的本地插件。其他插件、挂件设置与导入形象均保留。完成后请重启 Codex。是否继续？' } else { '将通过 Codex 自带的命令行注册并安装本地挂件插件。无需 Node.js 或项目源码；请先安装并登录 Codex。是否继续？' }
    $maidConsent = [System.Windows.Forms.MessageBox]::Show($maidPrompt, $maidTitle, 'YesNo', 'Question')
    if ($maidConsent -ne 'Yes') { exit 0 }
}
$maidResultFile = [IO.Path]::GetTempFileName()
try {
    $maidRuntime = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtime.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $maidExe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $maidRuntime.executableRelative))
    $maidScript = Join-Path $PSScriptRoot 'connect.cjs'
    $maidAction = if ($Remove) { '--remove' } else { '--install' }
    $maidArgs = @(('"' + $maidScript + '"'), $maidAction, '--result-file', ('"' + $maidResultFile + '"'))
    if ($CodexCli) { $maidArgs += @('--codex-cli', ('"' + $CodexCli + '"')) }
    function Invoke-MaidConnection {
        param([string[]]$Arguments)
        $maidPrevious = $env:ELECTRON_RUN_AS_NODE
        try {
            $env:ELECTRON_RUN_AS_NODE = '1'
            $script:maidProcess = Start-Process -FilePath $maidExe -ArgumentList $Arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait -PassThru
        } finally { $env:ELECTRON_RUN_AS_NODE = $maidPrevious }
        return [IO.File]::ReadAllText($maidResultFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    $maidResult = Invoke-MaidConnection -Arguments $maidArgs
    if (!$maidResult.ok -and $maidResult.code -eq 'CODEX_CLI_MISSING') {
        [void][System.Windows.Forms.MessageBox]::Show('未自动找到 Codex。请在下一窗口选择 Codex 安装目录 bin 文件夹中的 codex.exe；无需另装 Node.js。', $maidTitle, 'OK', 'Information')
        $maidPicker = New-Object System.Windows.Forms.OpenFileDialog
        $maidPicker.Title = '选择 Codex 自带的 codex.exe'
        $maidPicker.Filter = 'Codex CLI (codex.exe)|codex.exe'
        $maidPicker.CheckFileExists = $true
        if ($maidPicker.ShowDialog() -eq 'OK') {
            $maidResult = Invoke-MaidConnection -Arguments ($maidArgs + @('--codex-cli', ('"' + $maidPicker.FileName + '"')))
        }
        $maidPicker.Dispose()
    }
    if (!$maidResult -or !$maidResult.message) { throw '插件工具未返回结果。' }
    if (!$Quiet -or !$maidResult.ok) {
        $maidIcon = if ($maidResult.ok) { 'Information' } else { 'Warning' }
        [void][System.Windows.Forms.MessageBox]::Show([string]$maidResult.message, $maidTitle, 'OK', $maidIcon)
    }
    exit $maidProcess.ExitCode
} catch {
    [void][System.Windows.Forms.MessageBox]::Show('插件操作未完成。请检查挂件安装文件及 Codex 版本后重试。', $maidTitle, 'OK', 'Warning')
    exit 1
} finally {
    if (Test-Path -LiteralPath $maidResultFile) { Remove-Item -LiteralPath $maidResultFile -Force }
}
