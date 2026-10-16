$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This check requires the Windows interactive desktop.' }
$projectDir = Split-Path -Parent $PSScriptRoot
$nodePath = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$probePath = Join-Path $PSScriptRoot 'launch-job-probe.cjs'
$testMarker = [Guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testDir = Join-Path $tempRoot ("codex-maid-launch-job-" + $testMarker + " spaces ' " + [char]0x4e2d + [char]0x6587)
$null = New-Item -ItemType Directory -Path $testDir
$startedAt = [DateTime]::UtcNow

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MaidLaunchJobCheckNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public uint cb; public string reserved, desktop, title;
    public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
    public ushort show, reserved2; public IntPtr reservedPointer, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {
    public IntPtr process, thread; public uint processId, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorking, maxWorking; public uint active;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr data, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint rights, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
  public static IntPtr NewJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if(job == IntPtr.Zero) throw new Win32Exception();
    EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE
    int size = Marshal.SizeOf(limits); IntPtr data = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, data, false);
      if(!SetInformationJobObject(job, 9, data, (uint)size)) { int error=Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error); }
    } finally { Marshal.FreeHGlobal(data); }
    return job;
  }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach(char ch in value) {
      if(ch == '\\') { slashes++; continue; }
      if(ch == '"') result.Append('\\', slashes * 2 + 1); else result.Append('\\', slashes);
      result.Append(ch); slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  public static PROCESS_INFORMATION Launch(IntPtr job, string executable, string[] args, string cwd) {
    StringBuilder command = new StringBuilder(Quote(executable));
    foreach(string arg in args) command.Append(' ').Append(Quote(arg));
    STARTUPINFO startup = new STARTUPINFO(); startup.cb=(uint)Marshal.SizeOf(startup); startup.flags=1; startup.show=0;
    PROCESS_INFORMATION child;
    if(!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
    try {
      if(!AssignProcessToJobObject(job, child.process)) throw new Win32Exception();
      if(ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception();
    } catch { TerminateProcess(child.process, 1); CloseHandle(child.process); throw; }
    finally { CloseHandle(child.thread); }
    return child;
  }
}
'@

function Read-ProbeRecord([string]$name) {
  $file = Join-Path $testDir ($name + '.json')
  if (!(Test-Path -LiteralPath $file)) { return $null }
  try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
function Wait-Check([scriptblock]$check, [string]$description, [int]$timeout = 15000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
  while ([DateTime]::UtcNow -lt $deadline) {
    $errorRecord = Read-ProbeRecord 'launcher-error'
    if ($errorRecord) { throw ('Launcher failed: ' + $errorRecord.message) }
    if (& $check) { return }
    Start-Sleep -Milliseconds 80
  }
  throw ('Timed out: ' + $description)
}
function Open-OwnedProbe([string]$role) {
  $record = Read-ProbeRecord $role
  if (!$record -or $record.marker -ne $testMarker -or $record.role -ne $role -or $record.executable -ne $nodePath) {
    throw ('Invalid private probe record: ' + $role)
  }
  $native = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [uint32]$record.pid)
  if (!$native -or $native.ExecutablePath -ne $nodePath -or !$native.CommandLine.Contains($testMarker) -or !$native.CommandLine.Contains($probePath) -or $native.CreationDate.ToUniversalTime() -lt $startedAt.AddSeconds(-1)) {
    throw ('Refusing to access a process without this test executable and token: ' + $role)
  }
  # Keep handles, so a later PID reuse can never cause cleanup to target another process.
  $handle = [MaidLaunchJobCheckNative]::OpenProcess(0x101001, $false, [uint32]$record.pid)
  if ($handle -eq [IntPtr]::Zero) { throw ('Cannot open private probe: ' + $role) }
  $image = New-Object Text.StringBuilder 32768
  $length = [uint32]$image.Capacity
  if (![MaidLaunchJobCheckNative]::QueryFullProcessImageName($handle, 0, $image, [ref]$length) -or $image.ToString() -ne $nodePath) {
    $null = [MaidLaunchJobCheckNative]::CloseHandle($handle)
    throw ('Unexpected image for private probe: ' + $role)
  }
  return $handle
}
function Is-Member([IntPtr]$processHandle, [IntPtr]$jobHandle) {
  $member = $false
  if (![MaidLaunchJobCheckNative]::IsProcessInJob($processHandle, $jobHandle, [ref]$member)) { throw 'Cannot query test job membership.' }
  return $member
}

$testJob = [IntPtr]::Zero
$launcher = $null
$directHandle = [IntPtr]::Zero
$explorerHandle = [IntPtr]::Zero
try {
  $testJob = [MaidLaunchJobCheckNative]::NewJob()
  $launcher = [MaidLaunchJobCheckNative]::Launch($testJob, $nodePath, @($probePath, 'launcher', $testDir, $testMarker), $projectDir)
  Wait-Check { (Read-ProbeRecord 'launch-ready') -and (Read-ProbeRecord 'direct') -and (Read-ProbeRecord 'explorer') } 'both private probes ready'
  $direct = Read-ProbeRecord 'direct'
  $explorer = Read-ProbeRecord 'explorer'
  $directHandle = Open-OwnedProbe 'direct'
  $explorerHandle = Open-OwnedProbe 'explorer'
  if (!(Is-Member $launcher.process $testJob)) { throw 'Launcher was not assigned to the private test job.' }
  if (!(Is-Member $directHandle $testJob)) { throw 'Control child did not inherit the private test job.' }
  if (Is-Member $explorerHandle $testJob) { throw 'Explorer launched child inherited the private test job.' }
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  if ($direct.sessionId -ne $session -or $explorer.sessionId -ne $session) { throw 'Probe left the current interactive desktop session.' }
  Wait-Check { (Read-ProbeRecord 'explorer-heartbeat') } 'Explorer probe heartbeat'
  $before = (Read-ProbeRecord 'explorer-heartbeat').heartbeat
  if (![MaidLaunchJobCheckNative]::TerminateJobObject($testJob, 99)) { throw 'Cannot terminate the private test job.' }
  if ([MaidLaunchJobCheckNative]::WaitForSingleObject($launcher.process, 5000) -ne 0) { throw 'Private launcher survived its job termination.' }
  if ([MaidLaunchJobCheckNative]::WaitForSingleObject($directHandle, 5000) -ne 0) { throw 'Direct control child survived its job termination.' }
  if ([MaidLaunchJobCheckNative]::WaitForSingleObject($explorerHandle, 0) -ne 258) { throw 'Explorer launched child died with the private test job.' }
  Wait-Check { (Read-ProbeRecord 'explorer-heartbeat').heartbeat -gt $before + 1 } 'Explorer probe continues heartbeat after caller job termination' 5000
  Write-Output ("PASS: real Windows job isolation; launcher=" + $launcher.processId + ", direct=" + $direct.pid + " terminated; Explorer child=" + $explorer.pid + " survived and kept writing heartbeat; session=" + $session + ". No real Codex, widget or startup entry was changed.")
} finally {
  if ($testJob -ne [IntPtr]::Zero) {
    $null = [MaidLaunchJobCheckNative]::TerminateJobObject($testJob, 99)
    $null = [MaidLaunchJobCheckNative]::CloseHandle($testJob)
  }
  if ($explorerHandle -eq [IntPtr]::Zero -and (Read-ProbeRecord 'explorer')) {
    try { $explorerHandle = Open-OwnedProbe 'explorer' } catch { Write-Warning $_.Exception.Message }
  }
  foreach ($handle in @($explorerHandle, $directHandle)) {
    if ($handle -ne [IntPtr]::Zero) {
      if ([MaidLaunchJobCheckNative]::WaitForSingleObject($handle, 0) -eq 258) {
        $null = [MaidLaunchJobCheckNative]::TerminateProcess($handle, 99)
        $null = [MaidLaunchJobCheckNative]::WaitForSingleObject($handle, 5000)
      }
      $null = [MaidLaunchJobCheckNative]::CloseHandle($handle)
    }
  }
  if ($launcher) { $null = [MaidLaunchJobCheckNative]::CloseHandle($launcher.process) }
  # Resolve and boundary-check the only recursive cleanup target before deleting it.
  $resolvedTestDir = [IO.Path]::GetFullPath($testDir)
  if ($resolvedTestDir.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestDir).StartsWith('codex-maid-launch-job-' + $testMarker)) {
    Remove-Item -LiteralPath $resolvedTestDir -Recurse -Force
  } else { throw 'Refusing to remove an unexpected temporary directory.' }
}
