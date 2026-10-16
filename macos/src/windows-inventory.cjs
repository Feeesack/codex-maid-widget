'use strict';
const { spawn: nativeSpawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// One PowerShell host compiles this once and answers read-only inventory
// requests. No process command lines, environment blocks or account files are
// requested. A failed snapshot or inaccessible matching process stays unknown.
const INVENTORY_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class MaidWindowsInventory {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint Size, Usage, Id;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static Dictionary<string, object> Result(bool known, List<Dictionary<string, object>> items) {
        return new Dictionary<string, object> { { "known", known }, { "processes", items } };
    }
    public static object Query() {
        var items = new List<Dictionary<string, object>>();
        IntPtr snapshot = IntPtr.Zero;
        try {
            uint ownSession;
            if (!ProcessIdToSessionId(GetCurrentProcessId(), out ownSession)) throw new Win32Exception();
            string ownSid;
            using (var identity = WindowsIdentity.GetCurrent()) { ownSid = identity.User.Value; }
            snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1) || snapshot == IntPtr.Zero) throw new Win32Exception();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
            do {
                if (!string.Equals(entry.Name, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(entry.Name, "Codex.exe", StringComparison.OrdinalIgnoreCase)) continue;
                uint session;
                if (!ProcessIdToSessionId(entry.Id, out session)) throw new Win32Exception();
                if (session != ownSession) continue;
                var process = OpenProcess(0x1000, false, entry.Id);
                if (process == IntPtr.Zero) throw new Win32Exception();
                IntPtr token = IntPtr.Zero;
                try {
                    if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception();
                    string sid;
                    using (var owner = new WindowsIdentity(token)) { sid = owner.User.Value; }
                    if (!string.Equals(sid, ownSid, StringComparison.Ordinal)) continue;
                    uint length = 32768;
                    var path = new StringBuilder((int)length);
                    if (!QueryFullProcessImageNameW(process, 0, path, ref length) || length == 0) throw new Win32Exception();
                    items.Add(new Dictionary<string, object> {
                        { "pid", (int)entry.Id }, { "parentPid", (int)entry.Parent },
                        { "name", entry.Name }, { "path", path.ToString() }, { "sessionId", (int)session }
                    });
                } finally {
                    if (token != IntPtr.Zero) CloseHandle(token);
                    CloseHandle(process);
                }
            } while (Process32NextW(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
            return Result(true, items);
        } catch { return Result(false, new List<Dictionary<string, object>>()); }
        finally { if (snapshot != IntPtr.Zero && snapshot != new IntPtr(-1)) CloseHandle(snapshot); }
    }
}
'@
while ($null -ne ($request = [Console]::In.ReadLine())) {
    if ($request -ne 'query') { exit 1 }
    $answer = [MaidWindowsInventory]::Query()
    $line = ConvertTo-Json -InputObject $answer -Depth 5 -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}
`;

const MAX_OUTPUT_BYTES = 1024 * 1024;
function unavailable(reason = 'inventory-unavailable') { return { known: false, processes: [], reason }; }
function validProcess(item) {
  return item && Number.isInteger(item.pid) && item.pid > 0 &&
    Number.isInteger(item.parentPid) && item.parentPid >= 0 &&
    Number.isInteger(item.sessionId) && item.sessionId >= 0 &&
    typeof item.name === 'string' && /^(chatgpt|codex)\.exe$/i.test(item.name) &&
    typeof item.path === 'string' && item.path.length > 0 && !item.path.includes('\0');
}

class WindowsInventoryWorker {
  constructor({ spawn = nativeSpawn, platform = process.platform, timeout = 7000 } = {}) {
    this.spawn = spawn;
    this.platform = platform;
    this.timeout = timeout;
    this.worker = null;
    this.pending = null;
    this.closed = false;
  }
  query() {
    if (this.pending) return this.pending.promise;
    if (this.closed) return Promise.resolve(unavailable());
    if (this.platform !== 'win32') return Promise.resolve(unavailable('unsupported-platform'));
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.pending = { promise, resolve, timer: setTimeout(() => this.fail(), this.timeout) };
    try {
      if (!this.worker) this.start();
      const worker = this.worker;
      worker.child.stdin.write('query\n', error => { if (error && this.worker === worker) this.fail(); });
    } catch { this.fail(); }
    return promise;
  }
  start() {
    const command = Buffer.from(INVENTORY_WORKER_SCRIPT, 'utf16le').toString('base64');
    const child = this.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const worker = { child, decoder: new StringDecoder('utf8'), output: '', bytes: 0 };
    this.worker = worker;
    const failed = () => { if (this.worker === worker) this.fail(); };
    child.on('error', failed);
    child.on('exit', failed);
    child.stdin.on('error', failed);
    child.stdout.on('error', failed);
    child.stdout.on('end', failed);
    child.stdout.on('data', chunk => this.receive(worker, chunk));
  }
  receive(worker, chunk) {
    if (this.worker !== worker) return;
    worker.bytes += Buffer.byteLength(chunk);
    if (worker.bytes > MAX_OUTPUT_BYTES) { this.fail(); return; }
    worker.output += worker.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = worker.output.indexOf('\n')) >= 0) {
      const line = worker.output.slice(0, newline).replace(/^\uFEFF/, '').trim();
      worker.output = worker.output.slice(newline + 1);
      worker.bytes = Buffer.byteLength(worker.output, 'utf8');
      if (!this.pending || !line) { this.fail(); return; }
      let answer;
      try { answer = JSON.parse(line); } catch { this.fail(); return; }
      if (!answer || typeof answer.known !== 'boolean' || !Array.isArray(answer.processes) ||
          (answer.known && !answer.processes.every(validProcess))) { this.fail(); return; }
      this.settle(answer.known ? { known: true, processes: answer.processes } : unavailable());
    }
  }
  settle(value) {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(value); }
  }
  disposeWorker() {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try { worker.child.stdin.end(); } catch {}
    try { worker.child.kill(); } catch {}
  }
  fail() { this.disposeWorker(); this.settle(unavailable()); }
  close() { this.closed = true; this.fail(); }
}

module.exports = { WindowsInventoryWorker, INVENTORY_WORKER_SCRIPT, MAX_OUTPUT_BYTES };
