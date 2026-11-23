# Self-test for the Krisha native layer's global hotkey wiring.
#
# Sends a synthetic Ctrl+Alt+K (the same keystroke a physical press produces,
# including for RegisterHotKey chords) and reports whether the Krisha window
# toggled. The tray host must be running. Closes with exit code 0 on pass.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File selftest-hotkey.ps1
#
# Read-only for Krisha's runtime: touches no server endpoint, changes no state
# except the summon window's visibility (presses the chord twice to restore it).

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace KrishaSelfTest
{
    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        public delegate bool EnumProc(IntPtr h, IntPtr lp);

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        // x64 native layout: type at 0, keyboard union at 8, size 40.
        // SendInput rejects any other cbSize — a flat ushort-type struct
        // silently injects nothing.
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(8)] public KEYBDINPUT ki;
            [FieldOffset(32)] public long padTo40;
        }

        private static INPUT KeyInput(ushort vk, uint flags)
        {
            var i = new INPUT { type = 1 };
            i.ki = new KEYBDINPUT { wVk = vk, dwFlags = flags };
            return i;
        }
        private static void SendOne(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
        private static void Tap(ushort vk) { SendOne(KeyInput(vk, 0)); }
        private static void TapUp(ushort vk) { SendOne(KeyInput(vk, 0x0002)); }

        public static IntPtr FindByExactTitle(string title)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr lp)
            {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString() == title) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static void SendCtrlAltK()
        {
            Tap(0x11); Tap(0x12);
            SendOne(KeyInput(0x4B, 0));
            SendOne(KeyInput(0x4B, 0x0002));
            TapUp(0x12); TapUp(0x11);
        }
    }
}
"@

function Get-State {
    $h = [KrishaSelfTest.Native]::FindByExactTitle('Krisha')
    if ($h -eq [IntPtr]::Zero) { return 'NOT FOUND' }
    if ([KrishaSelfTest.Native]::IsWindowVisible($h)) { return 'VISIBLE' }
    return 'HIDDEN'
}

$before = Get-State
[KrishaSelfTest.Native]::SendCtrlAltK()
Start-Sleep -Milliseconds 500
$mid = Get-State
[KrishaSelfTest.Native]::SendCtrlAltK()
Start-Sleep -Milliseconds 500
$after = Get-State

Write-Output "start: $before -> after 1st chord: $mid -> after 2nd chord: $after"
if ($before -ne 'NOT FOUND' -and $mid -ne $before -and $after -eq $before) {
    Write-Output 'SELF-TEST PASS: global hotkey toggles the Krisha window.'
    exit 0
}
Write-Output 'SELF-TEST FAIL: window did not toggle twice. Is the tray host running? (check windows/tray.log)'
exit 1
