[CmdletBinding()]
param([string]$Destination)

$ErrorActionPreference = 'Stop'
# A Windows PowerShell child can inherit a PowerShell 7-only PSModulePath on
# hosted runners. Restore this process's built-in module locations before the
# download and signature checks; never change the user or machine environment.
$maidBuiltinModules = [IO.Path]::Combine($PSHOME, 'Modules')
$maidWindowsModules = [IO.Path]::Combine([Environment]::GetFolderPath('System'), 'WindowsPowerShell', 'v1.0', 'Modules')
$env:PSModulePath = $maidBuiltinModules + [IO.Path]::PathSeparator + $maidWindowsModules + [IO.Path]::PathSeparator + $env:PSModulePath
foreach ($maidModuleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    $maidModuleManifest = [IO.Path]::Combine($maidBuiltinModules, $maidModuleName, ($maidModuleName + '.psd1'))
    Import-Module -Name $maidModuleManifest -ErrorAction Stop
}
if (!$Destination) { $Destination = Join-Path $PSScriptRoot '..\..\tmp\installer-tools\inno-6.7.3' }
$maidDestination = [IO.Path]::GetFullPath($Destination)
$maidInstaller = Join-Path (Split-Path $maidDestination -Parent) 'innosetup-6.7.3.exe'
$maidExpected = '9C73C3BAE7ED48D44112A0F48E66742C00090BDB5BEF71D9D3C056C66E97B732'
New-Item -ItemType Directory -Path (Split-Path $maidInstaller -Parent) -Force | Out-Null
if (!(Test-Path -LiteralPath $maidInstaller)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe' -OutFile $maidInstaller
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $maidInstaller).Hash -ne $maidExpected) {
    throw 'Inno Setup download checksum differs from the official 6.7.3 GitHub release.'
}
$maidSignature = Get-AuthenticodeSignature -LiteralPath $maidInstaller
if ($maidSignature.Status -ne 'Valid' -or $maidSignature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Pyrsys B\.V\.') {
    throw 'Inno Setup download publisher signature verification failed.'
}
# Official /PORTABLE mode creates no system compiler registration or shortcuts.
$maidProcess = Start-Process -FilePath $maidInstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/PORTABLE=1', '/CURRENTUSER', ('/DIR="' + $maidDestination + '"')) -WindowStyle Hidden -PassThru -Wait
if ($maidProcess.ExitCode -ne 0) { throw "Inno Setup bootstrap failed: $($maidProcess.ExitCode)" }
if (!(Test-Path -LiteralPath (Join-Path $maidDestination 'ISCC.exe') -PathType Leaf)) { throw 'ISCC.exe is missing after bootstrap.' }
Write-Output (Join-Path $maidDestination 'ISCC.exe')
