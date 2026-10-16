$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$projectVersion = (Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json).version
$packagedExe = Join-Path $projectDir "release\$projectVersion\Codex-Maid-Widget-win32-x64\Codex-Maid-Widget.exe"
$legacyPackagedExe = Join-Path $projectDir 'release\Codex-Maid-Widget-win32-x64\Codex-Maid-Widget.exe'
if (!(Test-Path -LiteralPath $packagedExe) -and (Test-Path -LiteralPath $legacyPackagedExe)) {
    $legacyVersion = (Get-Item -LiteralPath $legacyPackagedExe).VersionInfo.ProductVersion
    if ($legacyVersion -eq $projectVersion) { $packagedExe = $legacyPackagedExe }
}
if (Test-Path -LiteralPath $packagedExe) {
    Start-Process -FilePath $packagedExe -WorkingDirectory (Split-Path -Parent $packagedExe) -WindowStyle Hidden
    exit
}
$electronExe = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
$electronInstaller = Join-Path $projectDir 'node_modules\electron\install.js'
if (-not (Test-Path -LiteralPath $electronInstaller)) {
    Write-Host 'Installing pinned dependencies...'
    Push-Location -LiteralPath $projectDir
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $electronExe)) {
    Write-Host 'Downloading the pinned Electron runtime...'
    & node $electronInstaller
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime installation failed.' }
}
Start-Process -FilePath $electronExe -ArgumentList @('"' + $projectDir + '"') -WorkingDirectory $projectDir -WindowStyle Hidden
