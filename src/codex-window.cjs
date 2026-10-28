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
using System.Threading.Tasks;
public static class MaidCodexWindow {
    static HashSet<uint> cachedRoots;
    static readonly List<IntPtr> cachedProcesses = new List<IntPtr>();
    static readonly Stopwatch cacheAge = Stopwatch.StartNew();
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Position;
        public uint Private;
    }
    delegate bool EnumCallback(IntPtr hwnd, IntPtr data);
    delegate void WinEventCallback(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime);
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
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint firstEvent, uint lastEvent, IntPtr module,
        WinEventCallback callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint flags);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
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
    static bool BelongsToWindow(IntPtr window, IntPtr host) {
        if (window == IntPtr.Zero || host == IntPtr.Zero) return false;
        if (window == host) return true;
        var seen = new HashSet<long>();
        var pending = new Queue<IntPtr>(); pending.Enqueue(window);
        for (int depth = 0; depth < 16 && pending.Count > 0; depth++) {
            var current = pending.Dequeue();
            if (current == IntPtr.Zero || !seen.Add(current.ToInt64())) continue;
            if (current == host) return true;
            var parent = GetParent(current); if (parent != IntPtr.Zero) pending.Enqueue(parent);
            var owner = GetWindow(current, 4); if (owner != IntPtr.Zero) pending.Enqueue(owner);
            var root = GetAncestor(current, 2); if (root != IntPtr.Zero) pending.Enqueue(root);
            var rootOwner = GetAncestor(current, 3); if (rootOwner != IntPtr.Zero) pending.Enqueue(rootOwner);
        }
        return false;
    }
    static bool TopLevelAbove(IntPtr widget, IntPtr host) {
        if (widget == IntPtr.Zero || host == IntPtr.Zero || widget == host ||
            GetAncestor(widget, 2) != widget || GetAncestor(host, 2) != host) return false;
        var seen = new HashSet<long>();
        var current = GetWindow(host, 3); // GW_HWNDPREV, not the host's child list.
        for (int count = 0; count < 4096 && current != IntPtr.Zero; count++) {
            if (!seen.Add(current.ToInt64())) return false;
            if (current == widget) return true;
            current = GetWindow(current, 3);
        }
        return false;
    }
    static IntPtr layerHook, layerWidget, layerHost;
    static uint layerWidgetPid, layerHostPid;
    static bool handlingLayerEvent, inputQuit;
    static readonly WinEventCallback layerCallback = LayerForegroundChanged;
    static GCHandle layerCallbackHandle;
    static bool LayerTracking(long widgetValue, uint widgetPid) {
        return layerHook != IntPtr.Zero && layerWidget.ToInt64() == widgetValue && layerWidgetPid == widgetPid &&
            OwnWidget(layerWidget, widgetPid) && IsWindow(layerHost) && Pid(layerHost) == layerHostPid && MainWindow(layerHost) &&
            GetAncestor(layerWidget, 2) == layerWidget && (GetLong(layerWidget, -16).ToInt64() & 0x40000000L) == 0;
    }
    static void LayerForegroundChanged(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime) {
        if (hook != layerHook || eventId != 3 || handlingLayerEvent || layerHost == IntPtr.Zero) return;
        try {
            if (!LayerTracking(layerWidget.ToInt64(), layerWidgetPid) || !BelongsToWindow(hwnd, layerHost)) return;
            handlingLayerEvent = true;
            // The callback and protocol commands use the same message-pumping
            // worker thread, so native caches never cross concurrent threads.
            StackAbove(layerWidget.ToInt64(), layerHost.ToInt64(), layerWidgetPid);
        } catch { }
        finally { handlingLayerEvent = false; }
    }
    public static void ReleaseLayerTracking() {
        var hook = layerHook;
        layerHook = IntPtr.Zero; layerWidget = IntPtr.Zero; layerHost = IntPtr.Zero;
        layerWidgetPid = 0; layerHostPid = 0;
        if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        if (layerCallbackHandle.IsAllocated) layerCallbackHandle.Free();
    }
    public static object TrackLayer(long widgetValue, long hostValue, uint widgetPid) {
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            if (host == IntPtr.Zero) {
                if (layerWidget != IntPtr.Zero && layerWidget != widget) return Unknown();
                ReleaseLayerTracking();
                return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", true } };
            }
            if (!OwnWidget(widget, widgetPid) || widget == host || GetAncestor(widget, 2) != widget ||
                (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0 || !TrustedHost(host, ValidatedRoots(false))) return Unknown();
            if (LayerTracking(widgetValue, widgetPid) && layerHost == host)
                return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", true } };
            ReleaseLayerTracking();
            layerWidget = widget; layerHost = host; layerWidgetPid = widgetPid; layerHostPid = Pid(host);
            layerCallbackHandle = GCHandle.Alloc(layerCallback);
            // OUTOFCONTEXT (0) keeps this worker independent of both GUI input
            // queues. Only foreground events are observed, never input text.
            layerHook = SetWinEventHook(3, 3, IntPtr.Zero, layerCallback, 0, 0, 2);
            bool ok = LayerTracking(widgetValue, widgetPid);
            if (!ok) ReleaseLayerTracking();
            return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", ok } };
        } catch { ReleaseLayerTracking(); return Unknown(); }
    }
    static void PumpEvents() {
        Message message;
        for (int count = 0; count < 128 && PeekMessage(out message, IntPtr.Zero, 0, 0, 1); count++) {
            if (message.Id == 0x0012) { inputQuit = true; ReleaseLayerTracking(); return; }
            TranslateMessage(ref message); DispatchMessage(ref message);
        }
    }
    public static string ReadRequest() {
        if (inputQuit) return null;
        if (layerHook == IntPtr.Zero) return Console.ReadLine();
        // Only the pipe read runs on the pool. All native work and WinEvent
        // callbacks stay on the original PowerShell worker thread.
        Task<string> input = Task.Factory.StartNew<string>(() => Console.ReadLine(), System.Threading.CancellationToken.None,
            TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
        while (!input.Wait(5)) { PumpEvents(); if (inputQuit) return null; }
        PumpEvents();
        return inputQuit ? null : input.Result;
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
            var owner = ownWidget && !childStyle && GetAncestor(widget, 2) == widget ? GetWindow(widget, 4) : IntPtr.Zero;
            bool trustedOwner = TrustedHost(owner, roots);
            if (!ownWidget) ownerBindings.Remove(widgetValue);
            var foreground = GetForegroundWindow();
            var gui = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
            bool focusKnown = GetGUIThreadInfo(0, ref gui);
            IntPtr foregroundCodexHost = IntPtr.Zero;
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
                if (foregroundCodexHost == IntPtr.Zero && BelongsToWindow(foreground, hwnd)) foregroundCodexHost = hwnd;
                windows.Add(new Dictionary<string, object> {
                    { "id", Id(hwnd) }, { "pid", (int)pid },
                    { "bounds", new Dictionary<string, object> { { "x", origin.X }, { "y", origin.Y },
                        { "width", client.Right - client.Left }, { "height", client.Bottom - client.Top } } },
                    { "visible", IsWindowVisible(hwnd) }, { "minimized", IsIconic(hwnd) },
                    { "cloaked", cloaked != 0 }, { "foreground", hwnd == foreground },
                    { "modal", !IsWindowEnabled(hwnd) }, { "mainWindow", true }, { "dpi", (int)GetDpiForWindow(hwnd) },
                    { "widgetParented", trustedParent && parent == hwnd },
                    { "widgetOwnedByHost", trustedOwner && owner == hwnd },
                    { "widgetAboveHost", childStyle
                        ? trustedParent && parent == hwnd && GetWindow(hwnd, 5) == widget
                        : ownWidget && TopLevelAbove(widget, hwnd) }
                });
                return true;
            }, IntPtr.Zero);
            if (!enumerated) return Unknown();
            var answer = new Dictionary<string, object> {
                { "known", true }, { "supported", true }, { "coordinateSpace", "physical-pixels" },
                { "windows", windows }, { "foregroundWindow", Id(foreground) },
                { "foregroundRoot", foregroundCodexHost != IntPtr.Zero ? Id(foregroundCodexHost) : Id(GetAncestor(foreground, 3)) },
                { "foregroundPid", (int)Pid(foreground) }
            };
            answer["keyboardFocusRoot"] = focusKnown ? Id(GetAncestor(gui.Focus, 2)) : "0";
            if (widgetValue != 0) {
                answer["widgetVisible"] = ownWidget && IsWindowVisible(widget);
                answer["widgetTopmost"] = ownWidget && (GetLong(widget, -20).ToInt64() & 0x00000008L) != 0;
                answer["widgetParented"] = trustedParent;
                answer["widgetParentId"] = Id(parent);
                answer["widgetDpi"] = ownWidget ? (int)GetDpiForWindow(widget) : 0;
                answer["widgetStyleCached"] = ownWidget && childBindings.ContainsKey(widgetValue);
                answer["layerTracking"] = LayerTracking(widgetValue, widgetPid);
                answer["widgetOwnedByHost"] = trustedOwner;
                answer["ownerBindingCached"] = ownWidget && ownerBindings.ContainsKey(widgetValue);
                answer["ownedHostId"] = trustedOwner ? Id(owner) : "0";
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
    sealed class OwnerBinding {
        public IntPtr OriginalOwner, Host;
        public uint OriginalOwnerPid;
    }
    static readonly Dictionary<long, OwnerBinding> ownerBindings = new Dictionary<long, OwnerBinding>();
    static bool OwnTopLevel(IntPtr widget, uint widgetPid) {
        return OwnWidget(widget, widgetPid) && GetAncestor(widget, 2) == widget &&
            (GetLong(widget, -16).ToInt64() & 0x40000000L) == 0;
    }
    static bool NonTopmost(IntPtr hwnd) { return (GetLong(hwnd, -20).ToInt64() & 8L) == 0; }
    static IntPtr RestorableOwner(IntPtr owner, uint ownerPid) {
        return owner != IntPtr.Zero && IsWindow(owner) && Pid(owner) == ownerPid ? owner : IntPtr.Zero;
    }
    static Dictionary<string, object> OwnerAnswer(IntPtr widget, uint widgetPid, HashSet<uint> roots, bool ok, string reason = null) {
        bool ownWidget = OwnTopLevel(widget, widgetPid);
        var owner = ownWidget ? GetWindow(widget, 4) : IntPtr.Zero;
        bool trustedOwner = ownWidget && TrustedHost(owner, roots);
        var answer = new Dictionary<string, object> {
            { "known", true }, { "supported", true }, { "ok", ok },
            { "widgetOwnedByHost", trustedOwner },
            { "ownerBindingCached", ownWidget && ownerBindings.ContainsKey(widget.ToInt64()) },
            { "ownedHostId", trustedOwner ? Id(owner) : "0" }
        };
        if (reason != null) answer["reason"] = reason;
        return answer;
    }
    static bool WriteTopLevelOwner(IntPtr widget, IntPtr owner, uint widgetPid) {
        if (!OwnTopLevel(widget, widgetPid)) return false;
        SetLong(widget, -8, owner); // GWLP_HWNDPARENT changes the owner of this top-level window only.
        // Commit cached window metadata without activating, moving, resizing,
        // remapping or explicitly reordering either window.
        bool committed = SetWindowPos(widget, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0200);
        return committed && OwnTopLevel(widget, widgetPid) && GetWindow(widget, 4) == owner;
    }
    static bool PlaceOwnedLayer(IntPtr widget, IntPtr host, uint widgetPid) {
        if (!OwnTopLevel(widget, widgetPid) || GetWindow(widget, 4) != host || !NonTopmost(host) || !NonTopmost(widget)) return false;
        if (TopLevelAbove(widget, host)) return true;
        // This runs once while binding, before the surface is shown. Later
        // focus changes use the OS owner invariant and never repair z-order.
        var after = GetWindow(host, 3);
        if (after != IntPtr.Zero && !NonTopmost(after)) after = IntPtr.Zero;
        bool moved = SetWindowPos(widget, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);
        if (OwnTopLevel(widget, widgetPid) && !NonTopmost(widget)) {
            SetWindowPos(widget, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);
            return false;
        }
        return moved && OwnTopLevel(widget, widgetPid) && GetWindow(widget, 4) == host && TopLevelAbove(widget, host);
    }
    public static object BindLayer(long widgetValue, long expectedWidgetValue, long hostValue, uint widgetPid) {
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            // The provider is bound to one exact widget HWND and process. A
            // child window must never enter this owner-only path.
            if (widgetValue <= 0 || widgetValue != expectedWidgetValue || !OwnTopLevel(widget, widgetPid) || widget == host)
                return Unknown();
            ReleaseLayerTracking();
            var roots = ValidatedRoots(true);
            OwnerBinding binding;
            bool cached = ownerBindings.TryGetValue(widgetValue, out binding);
            var previousOwner = GetWindow(widget, 4);
            uint previousOwnerPid = previousOwner == IntPtr.Zero ? 0 : Pid(previousOwner);
            if (!cached && TrustedHost(previousOwner, roots)) {
                // A restarted worker has lost the exact original owner. The
                // caller must recreate its own widget; clearing to zero would
                // guess away a possible Electron-owned hidden window.
                return OwnerAnswer(widget, widgetPid, roots, false, "owner-cache-lost");
            }
            if (host == IntPtr.Zero) {
                if (!cached) return OwnerAnswer(widget, widgetPid, roots, true);
                var original = RestorableOwner(binding.OriginalOwner, binding.OriginalOwnerPid);
                bool restored = WriteTopLevelOwner(widget, original, widgetPid);
                if (restored) ownerBindings.Remove(widgetValue);
                return OwnerAnswer(widget, widgetPid, roots, restored, restored ? null : "owner-restore-failed");
            }
            if (!TrustedHost(host, roots)) return OwnerAnswer(widget, widgetPid, roots, false, "host-unavailable");
            if (!NonTopmost(widget) || !NonTopmost(host)) return OwnerAnswer(widget, widgetPid, roots, false, "owner-topmost-unavailable");
            if (cached && previousOwner == host && binding.Host == host && TopLevelAbove(widget, host))
                return OwnerAnswer(widget, widgetPid, roots, true);
            if (!cached) {
                binding = new OwnerBinding { OriginalOwner = previousOwner, OriginalOwnerPid = previousOwnerPid, Host = IntPtr.Zero };
                ownerBindings.Add(widgetValue, binding);
            }
            bool bound = false;
            try {
                // Ownership gives Windows a persistent z-order invariant.
                // Keep both HWNDs top-level so each can activate normally.
                bound = WriteTopLevelOwner(widget, host, widgetPid) && TrustedHost(host, roots) &&
                    PlaceOwnedLayer(widget, host, widgetPid);
            } finally {
                if (!bound) {
                    var rollbackOwner = RestorableOwner(previousOwner, previousOwnerPid);
                    bool rolledBack = WriteTopLevelOwner(widget, rollbackOwner, widgetPid);
                    // Preserve the exact original owner if rollback failed;
                    // never replace it with the most recently selected host.
                    if (!cached && rolledBack) ownerBindings.Remove(widgetValue);
                }
            }
            if (bound) binding.Host = host;
            return OwnerAnswer(widget, widgetPid, roots, bound, bound ? null : "owner-bind-failed");
        } catch { return Unknown(); }
    }
    public static object StackAbove(long widgetValue, long hostValue, uint widgetPid) {
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            if (!OwnWidget(widget, widgetPid) || widget == host || GetAncestor(widget, 2) != widget ||
                (GetLong(widget, -16).ToInt64() & 0x40000000L) != 0 ||
                !TrustedHost(host, ValidatedRoots(false))) return Unknown();
            bool ok = false;
            var foreground = GetForegroundWindow();
            int cloaked;
            // Recheck foreground at the native write, rather than trusting a
            // poll taken before Alt+Tab. No parent, owner or focus is changed.
            if (IsWindowVisible(host) && !IsIconic(host) && IsWindowEnabled(host) && IsWindowVisible(widget) &&
                DwmGetWindowAttribute(host, 14, out cloaked, 4) == 0 && cloaked == 0 &&
                BelongsToWindow(foreground, host) && (GetLong(host, -20).ToInt64() & 8L) == 0 &&
                (GetLong(widget, -20).ToInt64() & 8L) == 0) {
                ok = TopLevelAbove(widget, host);
                if (!ok) {
                    var after = GetWindow(host, 3);
                    // Inserting after a topmost HWND can promote our window.
                    // HWND_TOP keeps it in the ordinary non-topmost group.
                    if (after != IntPtr.Zero && (GetLong(after, -20).ToInt64() & 8L) != 0) after = IntPtr.Zero;
                    bool moved = SetWindowPos(widget, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);
                    // Another program can promote the insert-after window between our read
                    // and the write. Never leave our surface globally topmost
                    // even when that race makes this stacking attempt fail.
                    if (OwnWidget(widget, widgetPid) && (GetLong(widget, -20).ToInt64() & 8L) != 0) {
                        SetWindowPos(widget, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);
                        moved = false;
                    }
                    ok = moved && OwnWidget(widget, widgetPid) && TopLevelAbove(widget, host) &&
                        (GetLong(widget, -20).ToInt64() & 8L) == 0;
                }
            }
            return new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", ok } };
        } catch { return Unknown(); }
    }
    sealed class ChildBinding {
        public IntPtr Host, Style, ExStyle, Owner;
    }
    static readonly Dictionary<long, ChildBinding> childBindings = new Dictionary<long, ChildBinding>();
    sealed class FocusBinding {
        public IntPtr Host;
        public uint HostThread, WidgetThread, CurrentThread;
        public bool AttachedHost, AttachedWidget;
    }
    static readonly Dictionary<long, FocusBinding> focusBindings = new Dictionary<long, FocusBinding>();
    static Dictionary<string, object> ChildAnswer(bool ok, bool parented, string reason = null) {
        var answer = new Dictionary<string, object> { { "known", true }, { "supported", true }, { "ok", ok }, { "parented", parented } };
        if (reason != null) answer["reason"] = reason;
        return answer;
    }
    static bool OwnWidget(IntPtr widget, uint widgetPid) {
        return widget != IntPtr.Zero && IsWindow(widget) && Pid(widget) == widgetPid;
    }
    static void ReleaseFocusBinding(long widgetValue) {
        FocusBinding binding;
        if (!focusBindings.TryGetValue(widgetValue, out binding)) return;
        focusBindings.Remove(widgetValue);
        try {
            if (binding.AttachedWidget && binding.CurrentThread != binding.WidgetThread)
                AttachThreadInput(binding.CurrentThread, binding.WidgetThread, false);
        } catch { }
        try {
            if (binding.AttachedHost && binding.CurrentThread != binding.HostThread)
                AttachThreadInput(binding.CurrentThread, binding.HostThread, false);
        } catch { }
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
        ReleaseFocusBinding(widget.ToInt64());
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
    public static object FocusChild(long widgetValue, long hostValue, uint widgetPid) {
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            ChildBinding binding;
            if (!OwnWidget(widget, widgetPid) || !childBindings.TryGetValue(widgetValue, out binding) ||
                binding.Host != host || GetParent(widget) != host ||
                (GetLong(widget, -16).ToInt64() & 0xC0000000L) != 0x40000000L)
                return ChildAnswer(false, false, "child-not-attached");
            // Keep the Codex host and child HWND in one input queue for the
            // entire editing lease. A short AttachThreadInput/SetFocus call
            // can be undone by Chromium as soon as the native worker returns.
            uint hostPid, widgetOwnerPid; uint hostThread = GetWindowThreadProcessId(host, out hostPid),
                widgetThread = GetWindowThreadProcessId(widget, out widgetOwnerPid), currentThread = GetCurrentThreadId();
            if (hostThread == 0 || widgetThread == 0) return Unknown();
            FocusBinding existing;
            if (focusBindings.TryGetValue(widgetValue, out existing) &&
                (existing.Host != host || existing.HostThread != hostThread || existing.WidgetThread != widgetThread ||
                 existing.CurrentThread != currentThread)) ReleaseFocusBinding(widgetValue);
            if (focusBindings.TryGetValue(widgetValue, out existing)) {
                SetActiveWindow(host);
                SetFocus(widget);
                bool focusedExisting = GetFocus() == widget && GetParent(widget) == host;
                return ChildAnswer(focusedExisting, true, focusedExisting ? null : "child-focus-failed");
            }
            bool attachedHost = currentThread == hostThread || AttachThreadInput(currentThread, hostThread, true);
            bool attachedWidget = currentThread == widgetThread || AttachThreadInput(currentThread, widgetThread, true);
            if (!attachedHost || !attachedWidget) {
                if (attachedWidget && currentThread != widgetThread) AttachThreadInput(currentThread, widgetThread, false);
                if (attachedHost && currentThread != hostThread) AttachThreadInput(currentThread, hostThread, false);
                return ChildAnswer(false, true, "child-focus-failed");
            }
            focusBindings[widgetValue] = new FocusBinding { Host = host, HostThread = hostThread, WidgetThread = widgetThread,
                CurrentThread = currentThread, AttachedHost = currentThread != hostThread, AttachedWidget = currentThread != widgetThread };
            try {
                // WS_CHILD is not an active top-level window. Activate the
                // verified Codex host, then place keyboard focus on the child.
                SetActiveWindow(host);
                SetFocus(widget);
                bool focused = GetFocus() == widget && GetParent(widget) == host;
                if (!focused) {
                    SetFocus(widget);
                    focused = GetFocus() == widget && GetParent(widget) == host;
                }
                if (!focused) {
                    ReleaseFocusBinding(widgetValue);
                    return ChildAnswer(false, true, "child-focus-failed");
                }
                return ChildAnswer(true, true);
            } catch {
                ReleaseFocusBinding(widgetValue);
                return Unknown();
            }
        } catch { ReleaseFocusBinding(widgetValue); return Unknown(); }
    }
    public static object ReleaseChildFocus(long widgetValue, long hostValue, uint widgetPid) {
        var widget = new IntPtr(widgetValue); var host = new IntPtr(hostValue);
        try {
            if (!OwnWidget(widget, widgetPid)) return Unknown();
            FocusBinding binding;
            if (focusBindings.TryGetValue(widgetValue, out binding) && binding.Host != host)
                return ChildAnswer(false, GetParent(widget) == host, "child-focus-failed");
            ReleaseFocusBinding(widgetValue);
            return ChildAnswer(true, GetParent(widget) == host);
        } catch { ReleaseFocusBinding(widgetValue); return Unknown(); }
    }
}
}
'@
try {
while ($null -ne ($request = [MaidWindowNative.MaidCodexWindow]::ReadRequest())) {
    if ($request -eq 'query') { $answer = [MaidWindowNative.MaidCodexWindow]::Query(__WIDGET_HWND__, __WIDGET_PID__) }
    elseif ($request -match '^topmost ([1-9][0-9]*) ([01])$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::SetTopmost([long]$Matches[1], __WIDGET_HWND__, __WIDGET_PID__, $Matches[2] -eq '1')
    }
    elseif ($request -match '^owner ([1-9][0-9]*) (0|[1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::SetOwner([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^bind-layer ([1-9][0-9]*) (0|[1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::BindLayer([long]$Matches[1], __WIDGET_HWND__, [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^stack ([1-9][0-9]*) ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::StackAbove([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^layer ([1-9][0-9]*) (0|[1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::TrackLayer([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^attach ([1-9][0-9]*) ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::AttachChild([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^position ([1-9][0-9]*) ([1-9][0-9]*) (-?[0-9]{1,9}) (-?[0-9]{1,9}) ([1-9][0-9]{0,8}) ([1-9][0-9]{0,8})$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::PositionChild([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__, [int]$Matches[3], [int]$Matches[4], [int]$Matches[5], [int]$Matches[6])
    } elseif ($request -match '^detach ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::DetachChild([long]$Matches[1], __WIDGET_PID__)
    } elseif ($request -match '^focus ([1-9][0-9]*) ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::FocusChild([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } elseif ($request -match '^release-focus ([1-9][0-9]*) ([1-9][0-9]*)$') {
        $answer = [MaidWindowNative.MaidCodexWindow]::ReleaseChildFocus([long]$Matches[1], [long]$Matches[2], __WIDGET_PID__)
    } else { exit 1 }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $answer -Depth 6 -Compress))
    [Console]::Out.Flush()
}
} finally { [MaidWindowNative.MaidCodexWindow]::ReleaseLayerTracking() }
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
  'host-unavailable', 'child-attach-failed', 'child-position-failed', 'child-detach-failed', 'child-too-large',
  'child-focus-failed']);
const OWNER_FAILURE_REASONS = new Set(['owner-cache-lost', 'host-unavailable', 'owner-topmost-unavailable',
  'owner-bind-failed', 'owner-restore-failed']);
function validWindow(item) {
  return item && validId(item.id) && Number.isInteger(item.pid) && item.pid > 0 && item.bounds &&
    ['x', 'y', 'width', 'height'].every(key => Number.isInteger(item.bounds[key]) && Math.abs(item.bounds[key]) <= 100000000) &&
    item.bounds.width >= 0 && item.bounds.height >= 0 &&
    ['modal', 'mainWindow', 'widgetParented', 'widgetAboveHost', 'widgetOwnedByHost'].every(key => item[key] === undefined || typeof item[key] === 'boolean') &&
    (item.dpi === undefined || Number.isInteger(item.dpi) && item.dpi >= 0 && item.dpi <= 10000) &&
    ['visible', 'minimized', 'cloaked', 'foreground'].every(key => typeof item[key] === 'boolean');
}

class CodexWindowProvider extends WindowsInventoryWorker {
  constructor({ spawn = nativeSpawn, platform = process.platform, timeout = 7000, widgetPid = process.pid, widgetHandle, env = process.env } = {}) {
    if (!Number.isInteger(widgetPid) || widgetPid <= 0) throw new TypeError('Invalid widget process');
    const widgetId = widgetHandle === undefined ? '0' : nativeHandleId(widgetHandle);
    if (!widgetId) throw new TypeError('Invalid widget handle');
    const script = WINDOW_WORKER_SCRIPT.replaceAll('__WIDGET_PID__', String(widgetPid)).replaceAll('__WIDGET_HWND__', widgetId);
    // Carry the native source through the existing control pipe. Embedding
    // compressed/base64 source inside UTF-16 EncodedCommand can still exceed
    // Windows' command-line limit as the module grows.
    const compressed = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
    const bootstrap = '$ErrorActionPreference = \'Stop\'; $bytes=[Convert]::FromBase64String([Console]::In.ReadLine()); ' +
      '$memory=New-Object IO.MemoryStream(,$bytes); ' +
      '$gzip=New-Object IO.Compression.GzipStream($memory,[IO.Compression.CompressionMode]::Decompress); ' +
      '$reader=New-Object IO.StreamReader($gzip); Invoke-Expression ($reader.ReadToEnd())';
    super({ platform, timeout, env, spawn: (file, args, options) => {
      const next = [...args];
      next[next.indexOf('-EncodedCommand') + 1] = Buffer.from(bootstrap, 'utf16le').toString('base64');
      const child = spawn(file, next, options);
      // This first line is consumed by the short bootstrap; subsequent lines
      // retain the ordinary query/stack/layer command protocol.
      try { child.stdin.write(compressed + '\n'); }
      catch (error) { try { child.kill(); } catch {} throw error; }
      return child;
    } });
    this.tail = Promise.resolve();
    this.queryPending = null;
    this.queuedPosition = null;
    this.widgetId = widgetId;
    this.ownedLayerSupported = true;
  }
  unavailable(reason = 'window-unavailable') {
    return { known: false, supported: this.platform === 'win32', coordinateSpace: 'physical-pixels', windows: [], reason };
  }
  request(command, kind, expectedParented, expectedOwner) {
    const task = this.tail.then(() => {
      if (this.closed) return this.unavailable();
      if (this.platform !== 'win32') return this.unavailable('unsupported-platform');
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      this.pending = { promise, resolve, kind, expectedParented, expectedOwner, timer: setTimeout(() => this.fail(), this.timeout) };
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
  stackAbove(widgetHandle, hostId) {
    const widget = nativeHandleId(widgetHandle), host = nativeHandleId(hostId);
    if (!widget || widget !== this.widgetId || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`stack ${widget} ${host}`, 'stack');
  }
  trackLayer(widgetHandle, hostId) {
    const widget = nativeHandleId(widgetHandle), host = hostId === null || hostId === undefined || hostId === '0' ? '0' : nativeHandleId(hostId);
    if (!widget || widget !== this.widgetId || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`layer ${widget} ${host}`, 'layer');
  }
  bindLayer(widgetHandle, hostId) {
    this.queuedPosition = null;
    const widget = nativeHandleId(widgetHandle), host = hostId === null || hostId === undefined || hostId === '0' ? '0' : nativeHandleId(hostId);
    if (!widget || widget !== this.widgetId || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`bind-layer ${widget} ${host}`, 'owned-layer', undefined, host);
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
  focusChild(widgetHandle, hostId) {
    const widget = nativeHandleId(widgetHandle), host = nativeHandleId(hostId);
    if (!widget || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`focus ${widget} ${host}`, 'child', true);
  }
  releaseChildFocus(widgetHandle, hostId) {
    const widget = nativeHandleId(widgetHandle), host = nativeHandleId(hostId);
    if (!widget || !host || widget === host) return Promise.resolve(this.unavailable('invalid-window-handle'));
    return this.request(`release-focus ${widget} ${host}`, 'child', true);
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
      } else if (this.pending.kind === 'owned-layer') {
        if (typeof answer.ok !== 'boolean' || typeof answer.widgetOwnedByHost !== 'boolean' ||
            typeof answer.ownerBindingCached !== 'boolean' || !validId(answer.ownedHostId, true) ||
            answer.widgetOwnedByHost !== (answer.ownedHostId !== '0') ||
            answer.ok && (this.pending.expectedOwner === '0'
              ? answer.ownerBindingCached || answer.widgetOwnedByHost
              : !answer.ownerBindingCached || answer.ownedHostId !== this.pending.expectedOwner) ||
            answer.reason !== undefined && !OWNER_FAILURE_REASONS.has(answer.reason)) { this.fail(); return; }
        this.settle({ known: true, supported: true, ok: answer.ok, widgetOwnedByHost: answer.widgetOwnedByHost,
          ownerBindingCached: answer.ownerBindingCached, ownedHostId: answer.ownedHostId,
          ...(answer.reason !== undefined ? { reason: answer.reason } : {}) });
      } else if (this.pending.kind === 'owner' || this.pending.kind === 'child' || this.pending.kind === 'stack' || this.pending.kind === 'layer') {
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
            ['widgetVisible', 'widgetParented', 'widgetStyleCached', 'widgetTopmost', 'layerTracking', 'widgetOwnedByHost', 'ownerBindingCached'].some(key => answer[key] !== undefined && typeof answer[key] !== 'boolean') ||
            answer.widgetParentId !== undefined && !validId(answer.widgetParentId, true) ||
            answer.ownedHostId !== undefined && !validId(answer.ownedHostId, true) ||
            answer.keyboardFocusRoot !== undefined && !validId(answer.keyboardFocusRoot, true) ||
            answer.ownedHostId !== undefined && answer.widgetOwnedByHost !== undefined && answer.widgetOwnedByHost !== (answer.ownedHostId !== '0') ||
            answer.widgetDpi !== undefined && !(Number.isInteger(answer.widgetDpi) && answer.widgetDpi >= 0 && answer.widgetDpi <= 10000)) { this.fail(); return; }
        const windows = answer.windows.map(({ id, pid, bounds, visible, minimized, cloaked, foreground, modal, mainWindow, dpi, widgetParented, widgetAboveHost, widgetOwnedByHost }) => ({
          id, pid, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          visible, minimized, cloaked, foreground, ...(typeof modal === 'boolean' ? { modal } : {}),
          ...(typeof mainWindow === 'boolean' ? { mainWindow } : {}),
          ...(dpi !== undefined ? { dpi } : {}), ...(widgetParented !== undefined ? { widgetParented } : {}),
          ...(widgetAboveHost !== undefined ? { widgetAboveHost } : {}),
          ...(widgetOwnedByHost !== undefined ? { widgetOwnedByHost } : {}),
        }));
        this.settle({ known: true, supported: true, coordinateSpace: 'physical-pixels', windows,
          foregroundWindow: answer.foregroundWindow, foregroundRoot: answer.foregroundRoot, foregroundPid: answer.foregroundPid,
          ...Object.fromEntries(['widgetVisible', 'widgetParented', 'widgetParentId', 'widgetDpi', 'widgetStyleCached', 'widgetTopmost', 'layerTracking', 'widgetOwnedByHost', 'ownerBindingCached', 'ownedHostId', 'keyboardFocusRoot']
            .filter(key => answer[key] !== undefined).map(key => [key, answer[key]])) });
      }
    }
  }
  fail() { this.disposeWorker(); this.settle(this.unavailable()); }
}

module.exports = { CodexWindowProvider, WINDOW_WORKER_SCRIPT, nativeHandleId };
