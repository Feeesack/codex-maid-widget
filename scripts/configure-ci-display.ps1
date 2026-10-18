[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
# Never change a developer's desktop or a self-hosted runner's display.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:CI -cne 'true' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Display configuration is allowed only on a GitHub-hosted Windows Actions runner.'
}

# EnumDisplaySettings supplies each DEVMODE. Test the selected mode before
# applying it with flags 0, without persisting changes to the display registry.
# https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-changedisplaysettingsexw
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexMaidCiDisplay {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Mode {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public uint dmFields;
        public int dmPositionX, dmPositionY;
        public uint dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType;
        public uint dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    public static Mode EmptyMode() {
        var mode = new Mode();
        mode.dmSize = (ushort)Marshal.SizeOf(typeof(Mode));
        return mode;
    }
    // PowerShell binds $null to an empty string for a string parameter.
    // Keep the native null device name inside C# for every display call.
    public static Mode ReadCurrent() {
        var mode = EmptyMode();
        if (!EnumDisplaySettings(null, -1, ref mode)) throw new InvalidOperationException("Could not read the current display mode.");
        return mode;
    }
    public static bool EnumMode(int number, ref Mode mode) {
        return EnumDisplaySettings(null, number, ref mode);
    }
    public static int TestMode(ref Mode mode) {
        return ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 2, IntPtr.Zero); // CDS_TEST
    }
    public static int ApplyMode(ref Mode mode) {
        return ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 0, IntPtr.Zero); // No registry persistence
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "EnumDisplaySettingsW", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettings(string deviceName, int modeNumber, ref Mode mode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW", ExactSpelling = true)]
    private static extern int ChangeDisplaySettingsEx(string deviceName, ref Mode mode, IntPtr window, uint flags, IntPtr parameter);
}
'@

function Mode-Geometry($mode) {
    return [ordered]@{ width = $mode.dmPelsWidth; height = $mode.dmPelsHeight;
        bitsPerPixel = $mode.dmBitsPerPel; frequency = $mode.dmDisplayFrequency }
}

$current = [CodexMaidCiDisplay]::ReadCurrent()
Write-Output ('Current CI display: ' + ((Mode-Geometry $current) | ConvertTo-Json -Compress))
if ($current.dmPelsWidth -ge 1920 -and $current.dmPelsHeight -ge 1080) {
    Write-Output 'CI display already meets the 1920x1080 minimum; no change needed.'
    return
}

$modes = @()
for ($index = 0; ; $index++) {
    $mode = [CodexMaidCiDisplay]::EmptyMode()
    if (-not [CodexMaidCiDisplay]::EnumMode($index, [ref]$mode)) { break }
    $modes += $mode
}
Write-Output ('Supported CI display modes: ' + (@($modes | ForEach-Object { Mode-Geometry $_ }) | ConvertTo-Json -Compress))
$candidates = @($modes | Where-Object {
    $_.dmPelsWidth -ge 1920 -and $_.dmPelsHeight -ge 1080 -and $_.dmBitsPerPel -ge 24
} | Sort-Object @{ Expression = { [long]$_.dmPelsWidth * $_.dmPelsHeight } }, dmPelsWidth, dmPelsHeight,
    @{ Expression = { $_.dmBitsPerPel }; Descending = $true }, @{ Expression = { $_.dmDisplayFrequency }; Descending = $true })
if (-not $candidates.Count) { throw 'The CI display has no supported mode at least 1920x1080.' }

$selected = $null
foreach ($candidate in $candidates) {
    $mode = $candidate
    $testResult = [CodexMaidCiDisplay]::TestMode([ref]$mode)
    Write-Output ('CI display mode test: ' + (([ordered]@{ mode = (Mode-Geometry $mode); result = $testResult }) | ConvertTo-Json -Compress))
    if ($testResult -eq 0) { $selected = $mode; break }
}
if ($null -eq $selected) { throw 'No sufficiently large supported CI display mode passed CDS_TEST.' }
$mode = $selected
$applyResult = [CodexMaidCiDisplay]::ApplyMode([ref]$mode)
if ($applyResult -ne 0) { throw "Could not apply the tested CI display mode (result $applyResult)." }
$actual = [CodexMaidCiDisplay]::ReadCurrent()
foreach ($field in @('dmPelsWidth', 'dmPelsHeight', 'dmBitsPerPel', 'dmDisplayFrequency')) {
    if ($actual.$field -ne $selected.$field) { throw "CI display readback differs from the selected mode: $field." }
}
Write-Output ('Configured CI display: ' + ((Mode-Geometry $actual) | ConvertTo-Json -Compress))
