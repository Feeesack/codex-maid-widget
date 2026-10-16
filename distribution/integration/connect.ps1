[CmdletBinding()]
param([switch]$Quiet, [string]$CodexCli)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$maidTitle = '连接 Codex 女仆挂件'
if (!$Quiet) {
    $maidConsent = [System.Windows.Forms.MessageBox]::Show('将通过 Codex 自带的命令行注册并安装本地挂件插件。无需 Node.js 或项目源码；请先安装并登录 Codex。是否继续？', $maidTitle, 'YesNo', 'Question')
    if ($maidConsent -ne 'Yes') { exit 0 }
}
$maidResultFile = [IO.Path]::GetTempFileName()
try {
    $maidRuntime = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtime.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $maidExe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $maidRuntime.executableRelative))
    $maidScript = Join-Path $PSScriptRoot 'connect.cjs'
    $maidArgs = @(('"' + $maidScript + '"'), '--install', '--result-file', ('"' + $maidResultFile + '"'))
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
    if (!$maidResult -or !$maidResult.message) { throw '连接工具未返回结果，请重新安装挂件后重试。' }
    if (!$Quiet -or !$maidResult.ok) {
        $maidIcon = if ($maidResult.ok) { 'Information' } else { 'Warning' }
        [void][System.Windows.Forms.MessageBox]::Show([string]$maidResult.message, $maidTitle, 'OK', $maidIcon)
    }
    exit $maidProcess.ExitCode
} catch {
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, $maidTitle, 'OK', 'Warning')
    exit 1
} finally {
    if (Test-Path -LiteralPath $maidResultFile) { Remove-Item -LiteralPath $maidResultFile -Force }
}
