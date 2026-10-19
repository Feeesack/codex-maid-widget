'use strict';
const { spawn: nativeSpawn } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { WindowsInventoryWorker, INVENTORY_WORKER_SCRIPT, MAX_OUTPUT_BYTES } = require('./windows-inventory.cjs');

// Extend the existing persistent native inventory host. Both types are compiled
// once per host; polling never starts a PowerShell process per mouse movement.
// No window captions, account files, command lines or environment blocks are read.
const WINDOW_WORKER_SCRIPT = INVENTORY_WORKER_SCRIPT.slice(0, INVENTORY_WORKER_SCRIPT.indexOf('while ($null -ne ($request')).replace(/'@\r?\n$/, '') + String.raw`
namespace MaidWindowNative {
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class MaidCodexWindow {
    static HashSet<uint> cachedRoots;
    static readonly List<IntPtr> cachedProcesses = new List<IntPtr>();
    static readonly Stopwatch cacheAge = Stopwatch.StartNew();
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    delegate bool EnumCallback(IntPtr hwnd, IntPtr data);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)] static extern int SetWindowLong32(IntPtr hwnd, int index, int value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    static string Id(IntPtr hwnd) { return hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture); }
    static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
    static IntPtr GetLong(IntPtr hwnd, int index) { return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, index) : new IntPtr(GetWindowLong32(hwnd, index)); }
    static void SetLong(IntPtr hwnd, int index, IntPtr value) {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, index, value);
        else SetWindowLong32(hwnd, index, value.ToInt32());
    }
    static bool MainWindow(IntPtr hwnd) {
        // Match Codex-Whale's Capture filter: an owned dialog or tool window
        // must never replace the remembered main window. #32770 also excludes
        // an unowned native picker; no caption or UI content is inspected.
        long style = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
        var name = new System.Text.StringBuilder(256);
        return GetAncestor(hwnd, 2) == hwnd && (GetLong(hwnd, -16).ToInt64() & 0x40000000L) == 0 &&
            GetWindow(hwnd, 4) == IntPtr.Zero && (style & 0x80) == 0 &&
            GetClassName(hwnd, name, name.Capacity) > 0 && name.ToString() != "#32770";
    }
    static Dictionary<string, object> Unknown() {
        InvalidateRoots();
        return new Dictionary<string, object> { { "known", false }, { "supported", true } };
    }
    static void InvalidateRoots() {
        cachedRoots = null;
        foreach (var process in cachedProcesses) CloseHandle(process);
        cachedProcesses.Clear();
    }
    static HashSet<uint> ValidatedRoots(bool fresh) {
        if (!fresh && cachedRoots != null && cacheAge.ElapsedMilliseconds < 1000) {
            bool alive = true;
            foreach (var process in cachedProcesses) if (WaitForSingleObject(process, 0) != 258) { alive = false; break; }
            if (alive) return cachedRoots;
        }
        InvalidateRoots();
        // Inventory has already restricted every entry to our user and session.
        var inventory = (Dictionary<string, object>)MaidWindowsInventory.Query();
        if (!(bool)inventory["known"]) throw new InvalidOperationException();
        var processes = (List<Dictionary<string, object>>)inventory["processes"];
        var candidates = new HashSet<uint>();
        foreach (var item in processes) if (item.ContainsKey("officialDesktop") && item["officialDesktop"] is bool && (bool)item["officialDesktop"]) candidates.Add((uint)(int)item["pid"]);
        var roots = new HashSet<uint>();
        foreach (var item in processes) {
            var pid = (uint)(int)item["pid"];
            if (candidates.Contains(pid) && !candidates.Contains((uint)(int)item["parentPid"])) roots.Add(pid);
        }
        try {
            foreach (var pid in roots) {
                // Retain a SYNCHRONIZE handle: PID reuse cannot turn a cached
                // Codex root into an unrelated application's window.
                var process = OpenProcess(0x00100000, false, pid);
                if (process == IntPtr.Zero) throw new InvalidOperationException();
                if (WaitForSingleObject(process, 0) != 258) { CloseHandle(process); throw new InvalidOperationException(); }
                cachedProcesses.Add(process);
            }
            cachedRoots = roots;
            cacheAge.Restart();
            return roots;
        } catch { InvalidateRoots(); throw; }
    }
    public static object Query(long widgetValue, uint widgetPid) {
        IntPtr previous = IntPtr.Zero;
        try {
            // PMv2 disables DPI virtualization for client rects and ClientToScreen.
            // The caller must convert physical pixels with Electron screen APIs.
            previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (previous == IntPtr.Zero) return Unknown();
            var roots = ValidatedRoots(false);
            var widget = new IntPtr(widgetValue);
            bool ownWidget = widget != IntPtr.Zero && IsWindow(widget) && Pid(widget) == widgetPid;
            ChildBinding binding;
            if (childBindings.TryGetValue(widgetValue, out binding) &&
                (!ownWidget || !IsWindow(binding.Host) || !roots.Contains(Pid(binding.Host)) || !MainWindow(binding.Host))) {
                if (ownWidget) DetachSaved(widget, binding, widgetPid);
                else childBindings.Remove(widgetValue);
            }
            var parent = ownWidget ? GetParent(widget) : IntPtr.Zero;
            bool childStyle = ownWidget && (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0;
            bool trustedParent = childStyle && parent != IntPtr.Zero && roots.Contains(Pid(parent)) && MainWindow(parent);
            var foreground = GetForegroundWindow();
            var windows = new List<Dictionary<string, object>>();
            bool enumerated = EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
                uint pid = Pid(hwnd);
                // Only root top-level windows, excluding Codex owned dialogs.
                if (!roots.Contains(pid) || !MainWindow(hwnd)) return true;
                Rect client;
                var origin = new Point();
                if (!GetClientRect(hwnd, out client) || !ClientToScreen(hwnd, ref origin)) return true;
                int cloaked;
                // An unqueryable desktop state is unsafe to display over.
                if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) != 0) return true;
                windows.Add(new Dictionary<string, object> {
                    { "id", Id(hwnd) }, { "pid", (int)pid },
                    { "bounds", new Dictionary<string, object> { { "x", origin.X }, { "y", origin.Y },
                        { "width", client.Right - client.Left }, { "height", client.Bottom - client.Top } } },
                    { "visible", IsWindowVisible(hwnd) }, { "minimized", IsIconic(hwnd) },
                    { "cloaked", cloaked != 0 }, { "foreground", hwnd == foreground },
                    { "modal", !IsWindowEnabled(hwnd) }, { "mainWindow", true }, { "dpi", (int)GetDpiForWindow(hwnd) },
                    { "widgetParented", trustedParent && parent == hwnd },
                    { "widgetAboveHost", trustedParent && parent == hwnd && GetWindow(hwnd, 5) == widget }
                });
                return true;
            }, IntPtr.Zero);
            if (!enumerated) return Unknown();
            var answer = new Dictionary<string, object> {
                { "known", true }, { "supported", true }, { "coordinateSpace", "physical-pixels" },
                { "windows", windows }, { "foregroundWindow", Id(foreground) },
                { "foregroundRoot", Id(GetAncestor(foreground, 3)) }, { "foregroundPid", (int)Pid(foreground) }
            };
            if (widgetValue != 0) {
                answer["widgetVisible"] = ownWidget && IsWindowVisible(widget);
                answer["widgetTopmost"] = ownWidget && (GetLong(widget, -20).ToInt64() & 0x00000008L) != 0;
                answer["widgetParented"] = trustedParent;
                answer["widgetParentId"] = Id(parent);
                answer["widgetDpi"] = ownWidget ? (int)GetDpiForWindow(widget) : 0;
                answer["widgetStyleCached"] = ownWidget && childBindings.ContainsKey(widgetValue);
            }
            return answer;
        } catch { InvalidateRoots(); return Unknown(); }
        finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static object SetOwner(long widgetValue, long ownerValue, uint widgetPid) {
        try {
            var widget = new IntPtr(widgetValue);
            var owner = new IntPtr(ownerValue);
            // Only the widget process may be changed, never a Codex window.
            if (widget == IntPtr.Zero || !IsWindow(widget) || Pid(widget) != widgetPid) return Unknown();
            if (owner != IntPtr.Zero) {
                var roots = ValidatedRoots(true);
                if (!IsWindow(owner) || !roots.Contains(Pid(owner)) || !MainWindow(owner)) return Unknown();
            }
            // Legacy owner API remains for compatibility. True child attachment
            // below has a separate, strict HWND DPI-awareness guard.
            if (IntPtr.Size == 8) SetWindowLongPtr64(widget, -8, owner);
            else SetWindowLong32(widget, -8, owner.ToInt32());
            var actual = IntPtr.Size == 8 ? GetWindowLongPtr64(widget, -8) : new IntPtr(GetWindowLong32(widget, -8));
            return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", actual == owner } };
        } catch { InvalidateRoots(); return Unknown(); }
    }
    sealed class ChildBinding {
        public IntPtr Host, Style, ExStyle, Owner;
    }
    static readonly Dictionary<long, ChildBinding> childBindings = new Dictionary<long, ChildBinding>();
    static Dictionary<string, object> ChildAnswer(bool ok, bool parented, string reason = null) {
        var answer = new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", ok }, { "parented", parented } };
        if (reason != null) answer["reason"] = reason;
        return answer;
    }
    static bool OwnWidget(IntPtr widget, uint widgetPid) {
        return widget != IntPtr.Zero && IsWindow(widget) && Pid(widget) == widgetPid;
    }
    public static object SetTopmost(long widgetValue, long expectedWidgetValue, uint widgetPid, bool enabled) {
        var widget = new IntPtr(widgetValue);
        try {
            // Bind every write to this worker's current surface, never another
            // window of the same process, and never globally promote a child.
            if (widgetValue != expectedWidgetValue || !OwnWidget(widget, widgetPid) ||
                (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0 || GetAncestor(widget, 2) != widget) return Unknown();
            bool moved = SetWindowPos(widget, new IntPtr(enabled ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            bool topmost = (GetLong(widget, -20).ToInt64() & 0x00000008L) != 0;
            bool ok = moved && OwnWidget(widget, widgetPid) && topmost == enabled;
            return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", ok }, { "topmost", topmost } };
        } catch { return Unknown(); }
    }
    static bool TrustedHost(IntPtr host, HashSet<uint> roots) {
        return host != IntPtr.Zero && IsWindow(host) && roots.Contains(Pid(host)) && MainWindow(host);
    }
    static bool DetachSaved(IntPtr widget, ChildBinding binding, uint widgetPid) {
        if (!OwnWidget(widget, widgetPid)) { childBindings.Remove(widget.ToInt64()); return false; }
        Rect before;
        if (!GetWindowRect(widget, out before)) return false;
        SetParent(widget, IntPtr.Zero);
        // While WS_CHILD is still set GetParent returns the desktop HWND,
        // rather than null. Complete the documented style restoration before
        // checking the final top-level relationship.
        SetLong(widget, -16, binding.Style);
        SetLong(widget, -20, binding.ExStyle);
        var owner = binding.Owner != IntPtr.Zero && IsWindow(binding.Owner) ? binding.Owner : IntPtr.Zero;
        SetLong(widget, -8, owner);
        // SetParent changes the coordinate origin. Restore the existing screen
        // rectangle as well as exact saved styles; never reposition the host.
        bool moved = SetWindowPos(widget, IntPtr.Zero, before.Left, before.Top, before.Right - before.Left,
            before.Bottom - before.Top, 0x0004 | 0x0010 | 0x0020 | 0x4000);
        bool restored = GetLong(widget, -16) == binding.Style && GetLong(widget, -20) == binding.ExStyle &&
            GetAncestor(widget, 2) == widget && GetWindow(widget, 4) == owner;
        if (restored) childBindings.Remove(widget.ToInt64());
        return moved && restored;
    }
    public static object AttachChild(long widgetValue, long hostValue, uint widgetPid) {
        IntPtr previous = IntPtr.Zero;
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            if (!OwnWidget(widget, widgetPid) || widget == host) return Unknown();
            var roots = ValidatedRoots(true);
            if (!TrustedHost(host, roots)) return Unknown();
            var widgetContext = GetWindowDpiAwarenessContext(widget);
            var hostContext = GetWindowDpiAwarenessContext(host);
            // Different contexts can reset the entire child process's DPI mode.
            // Changing this worker thread's context cannot repair an HWND's mode.
            if (widgetContext == IntPtr.Zero || hostContext == IntPtr.Zero ||
                !AreDpiAwarenessContextsEqual(widgetContext, hostContext)) return ChildAnswer(false, false, "dpi-context-mismatch");
            previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (previous == IntPtr.Zero) return Unknown();
            ChildBinding binding;
            if (childBindings.TryGetValue(widgetValue, out binding)) {
                if (binding.Host == host && GetParent(widget) == host && (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0)
                    return ChildAnswer(true, true);
                if (!DetachSaved(widget, binding, widgetPid)) return ChildAnswer(false, false, "child-detach-failed");
            }
            // An unexpected existing child relationship is outside our scope.
            if ((GetLong(widget, -16).ToInt64() & 0x40000000L) != 0) return ChildAnswer(false, true, "child-style-unavailable");
            binding = new ChildBinding { Host = host, Style = GetLong(widget, -16), ExStyle = GetLong(widget, -20), Owner = GetWindow(widget, 4) };
            childBindings[widgetValue] = binding;
            SetLong(widget, -16, new IntPtr((binding.Style.ToInt64() & ~0x80000000L) | 0x40000000L));
            SetParent(widget, host);
            bool attached = GetParent(widget) == host && (GetLong(widget, -16).ToInt64() & 0xC0000000L) == 0x40000000L;
            if (!attached) { DetachSaved(widget, binding, widgetPid); return ChildAnswer(false, false, "child-attach-failed"); }
            // Child HWND_TOP is confined to the host's own child stack. Preserve
            // visibility; renderer/manual hiding remains under the app's control.
            bool stacked = SetWindowPos(widget, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0020 | 0x4000);
            bool parented = OwnWidget(widget, widgetPid) && GetParent(widget) == host &&
                (GetLong(widget, -16).ToInt64() & 0xC0000000L) == 0x40000000L;
            if (!stacked || !parented) { DetachSaved(widget, binding, widgetPid); return ChildAnswer(false, false, "child-attach-failed"); }
            return ChildAnswer(true, true);
        } catch {
            ChildBinding binding;
            if (childBindings.TryGetValue(widgetValue, out binding)) DetachSaved(widget, binding, widgetPid);
            return Unknown();
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static object PositionChild(long widgetValue, long hostValue, uint widgetPid, int x, int y, int width, int height) {
        IntPtr previous = IntPtr.Zero;
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            if (!OwnWidget(widget, widgetPid)) return Unknown();
            previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (previous == IntPtr.Zero) return Unknown();
            ChildBinding binding;
            if (!childBindings.TryGetValue(widgetValue, out binding))
                return ChildAnswer(false, GetParent(widget) != IntPtr.Zero,
                    (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0 ? "child-style-unavailable" : "child-not-attached");
            if (binding.Host != host) return ChildAnswer(false, true, "child-not-attached");
            var roots = ValidatedRoots(false);
            if (!TrustedHost(host, roots) || GetParent(widget) != host) {
                DetachSaved(widget, binding, widgetPid); return ChildAnswer(false, false, "host-unavailable");
            }
            if (width < 1 || height < 1 || width > 100000000 || height > 100000000 ||
                Math.Abs((long)x) > 100000000 || Math.Abs((long)y) > 100000000) return ChildAnswer(false, true);
            Rect client; var origin = new Point();
            if (!GetClientRect(host, out client) || !ClientToScreen(host, ref origin)) return Unknown();
            int availableWidth = client.Right - client.Left, availableHeight = client.Bottom - client.Top;
            if (availableWidth < width || availableHeight < height) return ChildAnswer(false, true, "child-too-large");
            int relativeX = (int)Math.Max(0L, Math.Min((long)availableWidth - width, (long)x - origin.X));
            int relativeY = (int)Math.Max(0L, Math.Min((long)availableHeight - height, (long)y - origin.Y));
            bool moved = SetWindowPos(widget, IntPtr.Zero, relativeX, relativeY, width, height, 0x0010 | 0x4000);
            // A parent can close while SetWindowPos is crossing processes. Its
            // return value alone cannot certify the old child's HWND/PID.
            bool parented = OwnWidget(widget, widgetPid) && GetParent(widget) == host &&
                (GetLong(widget, -16).ToInt64() & 0xC0000000L) == 0x40000000L;
            bool ok = moved && parented;
            return ChildAnswer(ok, parented, ok ? null : "child-position-failed");
        } catch { return Unknown(); }
        finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static object DetachChild(long widgetValue, uint widgetPid) {
        IntPtr previous = IntPtr.Zero;
        var widget = new IntPtr(widgetValue);
        try {
            ChildBinding binding;
            if (!childBindings.TryGetValue(widgetValue, out binding)) {
                if (!OwnWidget(widget, widgetPid)) return Unknown();
                bool child = (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0;
                return ChildAnswer(!child, child, child ? "child-style-unavailable" : null);
            }
            previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (previous == IntPtr.Zero) return Unknown();
            bool ok = DetachSaved(widget, binding, widgetPid);
            return ChildAnswer(ok, OwnWidget(widget, widgetPid) && GetParent(widget) == binding.Host, ok ? null : "child-detach-failed");
        } catch { return Unknown(); }
        finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
}
}
'@
while ($null -ne ($request = [Console]::In.ReadLine())) {
    if ($request -eq 'query') { $answer = [MaidWindowNative.MaidCodexWindow]::Query(__WIDGET_HWND__, __WIDGET_PID__) }
    elseif ($request -match '^topmost ([1-9][0-9]*) ([01])$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::SetTopmost([long]$Matches[1], __WIDGET_HWND__, __WIDGET_PID__, $Matches[2] -eq '1')
    }
    elseif ($request -match '^owner ([1-9][0-9]*) (0|[1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::SetOwner([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^attach ([1-9][0-9]*) ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::AttachChild([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^position ([1-9][0-9]*) ([1-9][0-9]*) (-?[0-9]{1,9}) (-?[0-9]{1,9}) ([1-9][0-9]{0,8}) ([1-9][0-9]{0,8})$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::PositionChild([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__, [int]$Matches[3], [int]$Matches[4], [int]$Matches[5], [int]$Matches[6])
    } elseif ($request -match '^detach ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::DetachChild([long]$Matches[1], __WIDGET_PID__)
    } else { exit 1 }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $answer -Depth 6 -Compress))
    [Console]::Out.Flush()
}
`;

function nativeHandleId(value) {
  try {
    let id;
    if (Buffer.isBuffer(value)) {
      if (value.length === 8) id = value.readBigUInt64LE();
      else if (value.length === 4) id = BigInt(value.readUInt32LE());
      else return '';
    } else if (typeof value === 'bigint') id = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) id = BigInt(value);
    else if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) id = BigInt(value);
    else return '';
    return id > 0n && id <= 0x7fffffffffffffffn ? id.toString() : '';
  } catch { return ''; }
}
function validId(value, zero = false) { return (zero && value === '0') || (typeof value === 'string' && nativeHandleId(value) === value); }
const CHILD_FAILURE_REASONS = new Set(['dpi-context-mismatch', 'child-style-unavailable', 'child-not-attached',
  'host-unavailable', 'child-attach-failed', 'child-position-failed', 'child-detach-failed', 'child-too-large']);
function validWindow(item) {
  return item && validId(item.id) && Number.isInteger(item.pid) && item.pid > 0 && item.bounds &&
    ['x', 'y', 'width', 'height'].every(key => Number.isInteger(item.bounds[key]) && Math.abs(item.bounds[key]) <= 100000000) &&
    item.bounds.width >= 0 && item.bounds.height >= 0 &&
    ['modal', 'mainWindow', 'widgetParented', 'widgetAboveHost'].every(key => item[key] === undefined || typeof item[key] === 'boolean') &&
    (item.dpi === undefined || Number.isInteger(item.dpi) && item.dpi >= 0 && item.dpi <= 10000) &&
    ['visible', 'minimized', 'cloaked', 'foreground'].every(key => typeof item[key] === 'boolean');
}

class CodexWindowProvider extends WindowsInventoryWorker {
  constructor({ spawn = nativeSpawn, platform = process.platform, timeout = 7000, widgetPid = process.pid, widgetHandle, env = process.env } = {}) {
    if (!Number.isInteger(widgetPid) || widgetPid <= 0) throw new TypeError('Invalid widget process');
    const widgetId = widgetHandle === undefined ? '0' : nativeHandleId(widgetHandle);
    if (!widgetId) throw new TypeError('Invalid widget handle');
    const script = WINDOW_WORKER_SCRIPT.replaceAll('__WIDGET_PID__', String(widgetPid)).replaceAll('__WIDGET_HWND__', widgetId);
    // EncodedCommand is UTF-16/base64 and would exceed CreateProcess's 32K
    // command-line limit if the two C# types were embedded without compression.
    const compressed = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
    const bootstrap = `$bytes=[Convert]::FromBase64String('${compressed}'); ` +
      '$memory=New-Object IO.MemoryStream(,$bytes); ' +
      '$gzip=New-Object IO.Compression.GzipStream($memory,[IO.Compression.CompressionMode]::Decompress); ' +
      '$reader=New-Object IO.StreamReader($gzip); Invoke-Expression ($reader.ReadToEnd())';
    super({ platform, timeout, env, spawn: (file, args, options) => {
      const next = [...args];
      next[next.indexOf('-EncodedCommand') + 1] = Buffer.from(bootstrap, 'utf16le').toString('base64');
      return spawn(file, next, options);
    } });
    this.tail = Promise.resolve();
    this.queryPending = null;
    this.queuedPosition = null;
    this.widgetId = widgetId;
  }
  unavailable(reason = 'window-unavailable') {
    return { known: false, supported: this.platform === 'win32', coordinateSpace: 'physical-pixels', windows: [], reason };
  }
  request(command, kind, expectedParented) {
    const task = this.tail.then(() => {
      if (this.closed) return this.unavailable();
      if (this.platform !== 'win32') return this.unavailable('unsupported-platform');
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      this.pending = { promise, resolve, kind, expectedParented, timer: setTimeout(() => this.fail(), this.timeout) };
      try {
        if (!this.worker) this.start();
        const worker = this.worker;
        const value = typeof command === 'function' ? command() : command;
        worker.child.stdin.write(value + '\n', error => { if (error && this.worker === worker) this.fail(); });
      } catch { this.fail(); }
      return promise;
    });
    this.tail = task.catch(() => this.unavailable());
    return task;
  }
  query() {
    this.queuedPosition = null;
    if (!this.queryPending) this.queryPending = this.request('query', 'query').finally(() => { this.queryPending = null; });
    return this.queryPending;
  }
  setTopmost(widgetHandle, enabled) {
    const widget = nativeHandleId(widgetHandle);
    if (!widget || widget !== this.widgetId || typeof enabled !== 'boolean') return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`topmost ${widget} ${enabled ? 1 : 0}`, 'topmost');
  }
  setOwner(widgetHandle, hostId) {
    this.queuedPosition = null;
    const widget = nativeHandleId(widgetHandle), owner = nativeHandleId(hostId);
    if (!widget || !owner || widget === owner) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`owner ${widget} ${owner}`, 'owner');
  }
  clearOwner(widgetHandle) {
    this.queuedPosition = null;
    const widget = nativeHandleId(widgetHandle);
    if (!widget) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`owner ${widget} 0`, 'owner');
  }
  attachChild(widgetHandle, hostId) {
    this.queuedPosition = null;
    const widget = nativeHandleId(widgetHandle), host = nativeHandleId(hostId);
    if (!widget || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`attach ${widget} ${host}`, 'child', true);
  }
  positionChild(widgetHandle, hostId, bounds) {
    const widget = nativeHandleId(widgetHandle), host = nativeHandleId(hostId);
    if (!widget || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]) && Math.abs(bounds[key]) <= 100000000) ||
        bounds.width < 1 || bounds.height < 1) return Promise.resolve(this.unavailable('invalid-window-bounds'));
    const command = `position ${widget} ${host} ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`;
    const key = `${widget}:${host}`;
    // At most one in-flight and one queued projection are needed. Keep the
    // newest pointer position while an earlier native command is settling.
    if (this.queuedPosition?.key === key) {
      this.queuedPosition.command = command;
      return this.queuedPosition.promise;
    }
    const slot = { key, command, promise: null };
    slot.promise = this.request(() => {
      if (this.queuedPosition === slot) this.queuedPosition = null;
      return slot.command;
    }, 'child', true).finally(() => { if (this.queuedPosition === slot) this.queuedPosition = null; });
    this.queuedPosition = slot;
    return slot.promise;
  }
  detachChild(widgetHandle) {
    this.queuedPosition = null;
    const widget = nativeHandleId(widgetHandle);
    if (!widget) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`detach ${widget}`, 'child', false);
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
      if (!answer || typeof answer.known !== 'boolean' || answer.supported !== true) { this.fail(); return; }
      if (!answer.known) { this.settle(this.unavailable()); continue; }
      if (this.pending.kind === 'topmost') {
        if (typeof answer.ok !== 'boolean' || typeof answer.topmost !== 'boolean') { this.fail(); return; }
        this.settle({ known: true, supported: true, ok: answer.ok, topmost: answer.topmost });
      } else if (this.pending.kind === 'owner' || this.pending.kind === 'child') {
        if (typeof answer.ok !== 'boolean') { this.fail(); return; }
        if (this.pending.kind === 'child' && typeof answer.parented !== 'boolean') { this.fail(); return; }
        if (this.pending.kind === 'child' && answer.ok && answer.parented !== this.pending.expectedParented) { this.fail(); return; }
        if (this.pending.kind === 'child' && answer.reason !== undefined && !CHILD_FAILURE_REASONS.has(answer.reason)) { this.fail(); return; }
        this.settle({ known: true, supported: true, ok: answer.ok,
          ...(this.pending.kind === 'child' ? { parented: answer.parented,
            ...(answer.reason !== undefined ? { reason: answer.reason } : {}) } : {}) });
      } else {
        if (answer.coordinateSpace !== 'physical-pixels' || !Array.isArray(answer.windows) || answer.windows.length > 512 ||
            !answer.windows.every(validWindow) || !validId(answer.foregroundWindow, true) || !validId(answer.foregroundRoot, true) ||
            !Number.isInteger(answer.foregroundPid) || answer.foregroundPid < 0 ||
            ['widgetVisible', 'widgetParented', 'widgetStyleCached', 'widgetTopmost'].some(key => answer[key] !== undefined && typeof answer[key] !== 'boolean') ||
            answer.widgetParentId !== undefined && !validId(answer.widgetParentId, true) ||
            answer.widgetDpi !== undefined && !(Number.isInteger(answer.widgetDpi) && answer.widgetDpi >= 0 && answer.widgetDpi <= 10000)) { this.fail(); return; }
        const windows = answer.windows.map(({ id, pid, bounds, visible, minimized, cloaked, foreground, modal, mainWindow, dpi, widgetParented, widgetAboveHost }) => ({
          id, pid, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          visible, minimized, cloaked, foreground, ...(typeof modal === 'boolean' ? { modal } : {}),
          ...(typeof mainWindow === 'boolean' ? { mainWindow } : {}),
          ...(dpi !== undefined ? { dpi } : {}), ...(widgetParented !== undefined ? { widgetParented } : {}),
          ...(widgetAboveHost !== undefined ? { widgetAboveHost } : {}),
        }));
        this.settle({ known: true, supported: true, coordinateSpace: 'physical-pixels', windows,
          foregroundWindow: answer.foregroundWindow, foregroundRoot: answer.foregroundRoot, foregroundPid: answer.foregroundPid,
          ...Object.fromEntries(['widgetVisible', 'widgetParented', 'widgetParentId', 'widgetDpi', 'widgetStyleCached', 'widgetTopmost']
            .filter(key => answer[key] !== undefined).map(key => [key, answer[key]])) });
      }
    }
  }
  fail() { this.disposeWorker(); this.settle(this.unavailable()); }
}

module.exports = { CodexWindowProvider, WINDOW_WORKER_SCRIPT, nativeHandleId };
