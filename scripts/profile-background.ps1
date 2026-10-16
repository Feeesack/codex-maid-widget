param(
  [ValidateRange(5, 600)][int]$DurationSeconds = 30,
  [ValidateRange(100, 200)][int]$IntervalMilliseconds = 150,
  [string]$RootExecutable = '',
  [string]$DataDirectory = '',
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This profiler requires Windows.' }
$projectDirectory = Split-Path -Parent $PSScriptRoot
if (-not $RootExecutable) { $RootExecutable = Join-Path $projectDirectory 'release/Codex-Maid-Widget-win32-x64/Codex-Maid-Widget.exe' }
$RootExecutable = (Resolve-Path -LiteralPath $RootExecutable).Path
if (-not $DataDirectory) {
  $DataDirectory = if ($env:CODEX_MAID_HOME) { $env:CODEX_MAID_HOME } else { Join-Path $env:USERPROFILE '.codex-maid-widget' }
}
if (-not $OutputPath) { $OutputPath = Join-Path $projectDirectory 'tmp/resource-profile.json' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
# Only these numeric PIDs are retained; the control token is never emitted.
$helperPid = 0
$widgetPid = 0
try { $helperPid = [int]((Get-Content -LiteralPath (Join-Path $DataDirectory 'watcher.json') -Raw | ConvertFrom-Json).pid) } catch {}
try { $widgetPid = [int]((Get-Content -LiteralPath (Join-Path $DataDirectory 'control.json') -Raw | ConvertFrom-Json).pid) } catch {}

if (-not ('MaidBackgroundProfiler' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MaidBackgroundProfiler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ENTRY {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)] struct MEMORY {
    public uint size, faults; public UIntPtr peakWorking, working, peakPaged, paged, peakNonpaged, nonpaged, pagefile, peakPagefile, privateBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint low, high; public long Value { get { return ((long)high << 32) | low; } } }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ENTRY entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ENTRY entry);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out FT creation, out FT exit, out FT kernel, out FT user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr handle, ref MEMORY counters, uint size);
  sealed class Tracked {
    public IntPtr handle; public uint pid, parent; public long created; public string name, image, group; public bool root, initial, exited;
    public double first, last, baselineCpu, cpu, workingSum, privateSum, peakWorking, peakPrivate; public int memorySamples;
  }
  public sealed class ProcessResult {
    public uint pid, parentPid; public string name, executable, group; public bool targetExecutable, existedAtStart, exitedDuringSample;
    public double firstSeenSeconds, lastSeenSeconds, cpuSeconds, averagePrivateMiB, peakPrivateMiB, averageWorkingSetMiB, peakWorkingSetMiB;
  }
  public sealed class GroupResult {
    public string name; public int observedProcesses, observedNewProcesses; public double cpuSeconds, cpuPercentOfOneLogicalCore, cpuPercentOfMachine, averagePrivateMiB, peakPrivateMiB, averageWorkingSetMiB, peakWorkingSetMiB;
  }
  public sealed class SampleResult { public double seconds, privateMiB, workingSetMiB; public int activeProcesses; }
  public sealed class Result {
    public string startedAtUtc, rootExecutable, method; public int logicalProcessors, intervalMilliseconds, samples, helperPid, widgetPid, memoryReadFailures;
    public double elapsedSeconds, observerCpuSeconds; public GroupResult[] groups; public ProcessResult[] processes; public SampleResult[] timeline; public string[] limitations;
  }
  static Dictionary<uint,ENTRY> Snapshot() {
    Dictionary<uint,ENTRY> result = new Dictionary<uint,ENTRY>(); IntPtr snapshot = CreateToolhelp32Snapshot(2,0);
    if(snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try { ENTRY entry = new ENTRY(); entry.size=(uint)Marshal.SizeOf(typeof(ENTRY));
      if(Process32FirstW(snapshot,ref entry)) do { result[entry.pid]=entry; } while(Process32NextW(snapshot,ref entry));
    } finally { CloseHandle(snapshot); } return result;
  }
  static string Image(IntPtr handle) { StringBuilder value = new StringBuilder(32768); uint length=(uint)value.Capacity; return QueryFullProcessImageNameW(handle,0,value,ref length) ? value.ToString() : ""; }
  static bool Times(IntPtr handle, out long created, out bool exited, out double cpu) {
    FT start,end,kernel,user; bool ok=GetProcessTimes(handle,out start,out end,out kernel,out user); created=start.Value; exited=end.Value!=0; cpu=(kernel.Value+user.Value)/10000000.0; return ok;
  }
  static string Role(uint pid, Dictionary<uint,ENTRY> entries, Dictionary<uint,Tracked> active, int helper, int widget) {
    HashSet<uint> seen = new HashSet<uint>(); uint current=pid;
    while(current != 0 && seen.Add(current)) {
      if(current == helper) return "helper-tree"; if(current == widget) return "widget-tree";
      Tracked known; if(active.TryGetValue(current,out known)) return known.group;
      ENTRY entry; if(!entries.TryGetValue(current,out entry)) break; current=entry.parent;
    } return "other-widget-root";
  }
  public static Result Run(string root, int helper, int widget, int duration, int interval) {
    string rootName=Path.GetFileName(root); DateTime started=DateTime.UtcNow; long startFileTime=started.ToFileTimeUtc();
    Process observer=Process.GetCurrentProcess(); double observerStart=observer.TotalProcessorTime.TotalSeconds;
    Stopwatch timer=Stopwatch.StartNew(); List<Tracked> tracked=new List<Tracked>(); Dictionary<uint,Tracked> active=new Dictionary<uint,Tracked>();
    List<SampleResult> timeline=new List<SampleResult>(); string[] groupNames={"all","helper-tree","widget-tree","other-widget-root","child-processes"};
    Dictionary<string,double[]> memory=new Dictionary<string,double[]>(); foreach(string group in groupNames) memory[group]=new double[4];
    int memoryFailures=0;
    try {
      do {
        double now=timer.Elapsed.TotalSeconds; Dictionary<uint,ENTRY> entries=Snapshot();
        foreach(Tracked existing in active.Values.ToArray()) {
          long created; bool exited; double cpu; if(Times(existing.handle,out created,out exited,out cpu)) { existing.cpu=cpu; existing.exited=exited; }
          if(existing.exited || !entries.ContainsKey(existing.pid)) active.Remove(existing.pid);
        }
        bool added;
        do {
          added=false;
          foreach(ENTRY entry in entries.Values) {
            if(active.ContainsKey(entry.pid)) continue;
            Tracked parent; bool descendant=active.TryGetValue(entry.parent,out parent); bool candidate=String.Equals(entry.name,rootName,StringComparison.OrdinalIgnoreCase);
            if(!candidate && !descendant) continue;
            IntPtr handle=OpenProcess(0x1010,false,entry.pid); if(handle==IntPtr.Zero) handle=OpenProcess(0x1000,false,entry.pid); if(handle==IntPtr.Zero) continue;
            string image=Image(handle); bool exact=String.Equals(image,root,StringComparison.OrdinalIgnoreCase);
            if(!descendant && !exact) { CloseHandle(handle); continue; }
            long creation; bool exited; double cpu; if(!Times(handle,out creation,out exited,out cpu)) { CloseHandle(handle); continue; }
            // The retained handle identifies this lifetime even if Windows reuses the PID.
            bool seen=tracked.Any(p=>p.pid==entry.pid && p.created==creation);
            if(seen) { CloseHandle(handle); continue; }
            Tracked item=new Tracked {handle=handle,pid=entry.pid,parent=entry.parent,created=creation,name=entry.name,image=image,root=exact,
              group=Role(entry.pid,entries,active,helper,widget),initial=creation<startFileTime,first=now,last=now,baselineCpu=creation<startFileTime?cpu:0,cpu=cpu,exited=exited};
            tracked.Add(item); active[entry.pid]=item; added=true;
          }
        } while(added);
        Dictionary<string,double[]> current=new Dictionary<string,double[]>(); foreach(string group in groupNames) current[group]=new double[2];
        foreach(Tracked item in active.Values) {
          item.last=now; long creation; bool exited; double cpu; if(Times(item.handle,out creation,out exited,out cpu)) { item.cpu=cpu; item.exited=exited; }
          MEMORY counters=new MEMORY(); counters.size=(uint)Marshal.SizeOf(typeof(MEMORY));
          if(GetProcessMemoryInfo(item.handle,ref counters,counters.size)) {
            double privateBytes=counters.privateBytes.ToUInt64(),working=counters.working.ToUInt64();
            item.privateSum+=privateBytes; item.workingSum+=working; item.peakPrivate=Math.Max(item.peakPrivate,privateBytes); item.peakWorking=Math.Max(item.peakWorking,working); item.memorySamples++;
            foreach(string group in new string[]{"all",item.group,item.root?"":"child-processes"}) { if(group=="") continue; current[group][0]+=privateBytes; current[group][1]+=working; }
          } else if(!item.exited) memoryFailures++;
        }
        foreach(string group in groupNames) { double[] accumulated=memory[group],value=current[group]; accumulated[0]+=value[0]; accumulated[1]=Math.Max(accumulated[1],value[0]); accumulated[2]+=value[1]; accumulated[3]=Math.Max(accumulated[3],value[1]); }
        timeline.Add(new SampleResult {seconds=now,privateMiB=current["all"][0]/1048576,workingSetMiB=current["all"][1]/1048576,activeProcesses=active.Count});
        int wait=(int)(timeline.Count*interval-timer.Elapsed.TotalMilliseconds); if(wait>0) Thread.Sleep(Math.Min(wait,interval));
      } while(timer.Elapsed.TotalSeconds<duration);
      foreach(Tracked item in tracked) { long creation; bool exited; double cpu; if(Times(item.handle,out creation,out exited,out cpu)) {item.cpu=cpu; item.exited=exited;} }
      double elapsed=timer.Elapsed.TotalSeconds; int count=timeline.Count,cores=Environment.ProcessorCount; List<GroupResult> groups=new List<GroupResult>();
      foreach(string group in groupNames) {
        List<Tracked> members=tracked.Where(p=>group=="all" || (group=="child-processes" ? !p.root : p.group==group)).ToList(); double cpu=members.Sum(p=>Math.Max(0,p.cpu-p.baselineCpu)); double[] values=memory[group];
        groups.Add(new GroupResult {name=group,observedProcesses=members.Count,observedNewProcesses=members.Count(p=>!p.initial),cpuSeconds=cpu,cpuPercentOfOneLogicalCore=cpu/elapsed*100,cpuPercentOfMachine=cpu/elapsed/cores*100,averagePrivateMiB=values[0]/count/1048576,peakPrivateMiB=values[1]/1048576,averageWorkingSetMiB=values[2]/count/1048576,peakWorkingSetMiB=values[3]/1048576});
      }
      return new Result {startedAtUtc=started.ToString("o"),rootExecutable=root,method="Toolhelp snapshot + retained process handles + GetProcessTimes/GetProcessMemoryInfo; exact executable roots and discovered descendants",logicalProcessors=cores,intervalMilliseconds=interval,samples=count,helperPid=helper,widgetPid=widget,memoryReadFailures=memoryFailures,elapsedSeconds=elapsed,observerCpuSeconds=observer.TotalProcessorTime.TotalSeconds-observerStart,groups=groups.ToArray(),timeline=timeline.ToArray(),
        processes=tracked.Select(p=>new ProcessResult {pid=p.pid,parentPid=p.parent,name=p.name,executable=p.image,group=p.group,targetExecutable=p.root,existedAtStart=p.initial,exitedDuringSample=p.exited,firstSeenSeconds=p.first,lastSeenSeconds=p.last,cpuSeconds=Math.Max(0,p.cpu-p.baselineCpu),averagePrivateMiB=p.privateSum/count/1048576,peakPrivateMiB=p.peakPrivate/1048576,averageWorkingSetMiB=p.workingSum/count/1048576,peakWorkingSetMiB=p.peakWorking/1048576}).ToArray(),
        limitations=new string[]{"Processes born and exited entirely between snapshots may be missed; CPU is a lower bound for such children.","Working sets are summed per process and can double count shared pages; private bytes measure private committed memory, not resident RAM.","Memory averages include zero while a tracked process is absent; sampled peaks can miss sub-interval spikes.","CPU percentages use measured wall time; 100% of one logical core equals 1/logicalProcessors of the machine.","Observer CPU is reported separately and excluded from target totals; compiler/startup overhead precedes sampling.","Role PIDs are read once at startup; avoid restarting the widget during a comparison."}};
    } finally { foreach(Tracked item in tracked) CloseHandle(item.handle); observer.Dispose(); }
  }
}
'@
}
$result = [MaidBackgroundProfiler]::Run($RootExecutable, $helperPid, $widgetPid, $DurationSeconds, $IntervalMilliseconds)
$directory = Split-Path -Parent $OutputPath
$null = New-Item -ItemType Directory -Force -Path $directory
$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$result.groups | Select-Object name, observedProcesses, @{Name='CPU(machine%)';Expression={[math]::Round($_.cpuPercentOfMachine,3)}}, @{Name='Private avg MiB';Expression={[math]::Round($_.averagePrivateMiB,1)}}, @{Name='WS avg MiB';Expression={[math]::Round($_.averageWorkingSetMiB,1)}}, @{Name='WS peak MiB';Expression={[math]::Round($_.peakWorkingSetMiB,1)}} | Format-Table -AutoSize
Write-Output ("Profile: {0}; {1} samples, {2:N2}s, {3} logical processors; observer CPU {4:N3}s" -f $OutputPath, $result.samples, $result.elapsedSeconds, $result.logicalProcessors, $result.observerCpuSeconds)
