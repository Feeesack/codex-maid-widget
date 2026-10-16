[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$maidInstallDir = [IO.Path]::GetFullPath($InstallDir)
$maidExecutable = Join-Path $maidInstallDir 'Codex-Maid-Widget.exe'
if ([IO.Path]::GetPathRoot($maidInstallDir).TrimEnd('\') -eq $maidInstallDir.TrimEnd('\')) { throw 'Refusing a drive root as the installation directory.' }

# Identify our executable by its complete installed path. Never use a wildcard
# process name, terminate Codex, or stop a portable widget in another directory.
$maidProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Codex-Maid-Widget.exe'" | Where-Object {
    $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $maidExecutable, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($maidItem in $maidProcesses) {
    $maidProcess = Get-Process -Id $maidItem.ProcessId -ErrorAction SilentlyContinue
    if ($maidProcess) {
        # Closing the main process can also exit renderer/GPU children while
        # this snapshot is being walked. An already exited child is harmless.
        try { [void]$maidProcess.CloseMainWindow() } catch {
            if (Get-Process -Id $maidItem.ProcessId -ErrorAction SilentlyContinue) { Write-Verbose $_.Exception.Message }
        }
    }
}
if ($maidProcesses.Count) { Start-Sleep -Milliseconds 700 }
foreach ($maidItem in $maidProcesses) {
    # Check identity again to avoid a recycled PID between the queries.
    $maidCurrent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($maidItem.ProcessId)" -ErrorAction SilentlyContinue
    if ($maidCurrent -and $maidCurrent.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($maidCurrent.ExecutablePath), $maidExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $maidItem.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    $maidRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (Test-Path -LiteralPath $maidRunKey) {
        $maidValues = Get-ItemProperty -LiteralPath $maidRunKey
        foreach ($maidValue in $maidValues.PSObject.Properties) {
            if ($maidValue.Name -like 'PS*' -or $maidValue.Value -isnot [string]) { continue }
            $maidCommand = $maidValue.Value.Trim()
            $maidQuoted = '"' + $maidExecutable + '"'
            $maidMatches = $maidCommand.Equals($maidQuoted, [StringComparison]::OrdinalIgnoreCase) -or
                $maidCommand.StartsWith($maidQuoted + ' ', [StringComparison]::OrdinalIgnoreCase) -or
                $maidCommand.Equals($maidExecutable, [StringComparison]::OrdinalIgnoreCase) -or
                $maidCommand.StartsWith($maidExecutable + ' ', [StringComparison]::OrdinalIgnoreCase)
            if ($maidMatches) { Remove-ItemProperty -LiteralPath $maidRunKey -Name $maidValue.Name }
        }
    }
}
# User settings, imported characters, Codex data and credentials are retained.
