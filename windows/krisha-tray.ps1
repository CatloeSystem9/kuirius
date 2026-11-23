#requires -version 5.1
<#
  Krisha native Windows shell (tray-resident layer).

  Built to the locked spec from the planning conversation:
    - Krisha lives in the system tray, resident in the background
    - Global hotkey Ctrl+Alt+K  -> summon / hide the Krisha window from anywhere
    - Global hotkey Ctrl+Alt+X  -> safety stop (server-side activateStop,
                                   cancels tasks, revokes temporary permissions,
                                   blocks new side-effecting actions)
    - Autostart with Windows (optional, via Start Menu shortcut)
    - Optional corner failsafe (OFF by default — see README for why)

  The agent brain, computer use, exec gates, containment and rollback all
  already live in the TypeScript runtime (server.ts + src/agent). This script
  is ONLY the Windows body around it: tray presence, hotkeys, server lifecycle
  and the app-mode browser window. It makes no TypeScript changes.

  Modes:
    (no flags)        Tray host: registers hotkeys, ensures the server is
                      up, opens the Krisha window, then idles in the tray.
    -SummonOnly       Headless helper: ensure server is healthy, open the
                      Krisha window, then exit. Used by the tray hotkey when
                      the window does not exist yet (keeps the tray thread
                      responsive).

  Safety notes:
    - The safety stop has deliberately NO HTTP deactivation (deactivation runs
      exclusively through the recovery CLI: npm run recovery). Ctrl+Alt+X is
      therefore wired straight to the server endpoint and nothing else — no
      accidental activations are built into this layer.
    - Server exit: "Stop Krisha Server" (menu) or taskkill are abrupt; the
      runtime's child processes self-exit via the parent-PID probe
      (src/server/runtimeShutdown.ts documents the full contract).
#>

param(
    [switch]$SummonOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logPath  = Join-Path $PSScriptRoot 'tray.log'

# ------------------------------------------------------------------ config

$cfg = @{
    port               = 3000
    summonHotkey       = 'ctrl+alt+k'
    stopHotkey         = 'ctrl+alt+x'
    cornerFailsafe     = $false      # opt-in: false positives lock the runtime until recovery CLI
    cornerDwellSeconds = 2
}
$cfgPath = Join-Path $PSScriptRoot 'tray-config.json'
if (Test-Path $cfgPath) {
    try {
        $json = Get-Content $cfgPath -Raw | ConvertFrom-Json
        foreach ($p in $json.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    } catch {
        Write-Output "tray-config.json is invalid — using defaults ($_ )"
    }
}
$base = "http://127.0.0.1:$($cfg['port'])"

function Write-TrayLog {
    param([string]$Message)
    try {
        if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 512KB)) {
            Set-Content -Path $logPath -Value "[$(Get-Date -Format s)] log rotated"
        }
        Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $Message"
    } catch { }
}

# ------------------------------------------------------------- win32 bridge

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace KrishaTray
{
    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("kernel32.dll")] public static extern bool CreateMutexW(IntPtr attr, bool initial, string name);
        [DllImport("kernel32.dll")] public static extern int GetLastError();

        public delegate bool EnumProc(IntPtr h, IntPtr lp);
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // x64 native layout: DWORD type, keyboard/mouse union at offset 8,
        // total size 40. SendInput rejects any other cbSize — a flat
        // ushort-type struct silently injects nothing.
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(8)] public KEYBDINPUT ki;
            [FieldOffset(32)] public long padTo40;
        }

        public static INPUT KeyInput(ushort vk, uint flags)
        {
            var i = new INPUT { type = INPUT_KEYBOARD };
            i.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
            return i;
        }

        public const int SW_HIDE = 0;
        public const int SW_SHOWNORMAL = 1;
        public const int SW_RESTORE = 9;
        public const uint MOD_ALT = 0x1;
        public const uint MOD_CONTROL = 0x2;
        public const uint MOD_SHIFT = 0x4;
        public const uint MOD_WIN = 0x8;
        public const ushort KEYUP = 0x0002;
        public const ushort INPUT_KEYBOARD = 1;

        public static bool MutexHeld(string name)
        {
            CreateMutexW(IntPtr.Zero, true, name);
            return GetLastError() == 183; // ERROR_ALREADY_EXISTS
        }

        // Top-level window whose caption matches exactly (the Krisha app-mode
        // browser window carries the page title "Krisha"). visibleOnly=false
        // also finds hidden windows — the summon toggle must see a window it
        // hid itself, otherwise every summon after a hide spawns duplicates.
        public static IntPtr FindByExactTitle(string title, bool visibleOnly)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr lp)
            {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString() == title && (!visibleOnly || IsWindowVisible(h)))
                {
                    found = h;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // Synthetic keystroke — also fires hotkeys registered via
        // RegisterHotKey, which is how the self-test verifies the wiring.
        public static void SendChord(ushort vk, uint mods)
        {
            if ((mods & MOD_CONTROL) != 0) Tap(0x11);
            if ((mods & MOD_ALT) != 0)     Tap(0x12);
            SendOne(KeyInput(vk, 0));
            SendOne(KeyInput(vk, KEYUP));
            if ((mods & MOD_ALT) != 0)     TapUp(0x12);
            if ((mods & MOD_CONTROL) != 0) TapUp(0x11);
        }
        public static void SendOne(INPUT i)
        {
            SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
        }
        private static void Tap(ushort vk) { SendOne(KeyInput(vk, 0)); }
        private static void TapUp(ushort vk) { SendOne(KeyInput(vk, KEYUP)); }
    }

    // Hidden message window: WM_HOTKEY lands here on the UI thread.
    public class HotkeyForm : Form
    {
        public event Action<int> Hotkey;

        public HotkeyForm()
        {
            Text = "KrishaTrayHost";
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_HOTKEY = 0x0312;
            if (m.Msg == WM_HOTKEY && Hotkey != null) { Hotkey(m.WParam.ToInt32()); }
            base.WndProc(ref m);
        }
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing -Language CSharp

# ----------------------------------------------------------------- helpers

function Test-ServerHealthy {
    try {
        $r = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 2
        return ($null -ne $r)
    } catch { return $false }
}

function Get-DevCommand {
    # Prefer npm (package.json "dev": "tsx server.ts"); fall back to bun.
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) { return @{ exe = $npm.Source; args = @('run', 'dev') } }
    $bun = Get-Command bun.exe -ErrorAction SilentlyContinue
    if ($bun) { return @{ exe = $bun.Source; args = @('run', 'dev') } }
    return $null
}

function Start-KrishaServer {
    $cmd = Get-DevCommand
    if ($null -eq $cmd) {
        Write-TrayLog 'no npm.cmd/bun.exe found on PATH — cannot start server'
        return $null
    }
    try {
        $proc = Start-Process -FilePath $cmd.exe -ArgumentList $cmd.args `
            -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
        Write-TrayLog "server process started (pid $($proc.Id))"
        return $proc
    } catch {
        Write-TrayLog "failed to start server process: $_"
        return $null
    }
}

function Stop-KrishaServerProcess {
    param([int]$ProcessId)
    try {
        Start-Process -FilePath 'taskkill.exe' `
            -ArgumentList "/PID $ProcessId", '/T', '/F' -WindowStyle Hidden -Wait
        Write-TrayLog "server tree killed (pid $ProcessId)"
        return $true
    } catch {
        Write-TrayLog "failed to stop server (pid $ProcessId): $_"
        return $false
    }
}

function Get-AppBrowserPath {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

function Open-KrishaWindow {
    # Assumes server healthy. Reuses an existing (possibly hidden) window
    # before launching a new one — keeps double-summons idempotent.
    $existing = [KrishaTray.Native]::FindByExactTitle('Krisha', $false)
    if ($existing -ne [IntPtr]::Zero) {
        [KrishaTray.Native]::ShowWindow($existing, [KrishaTray.Native]::SW_RESTORE)
        [KrishaTray.Native]::SetForegroundWindow($existing) | Out-Null
        Write-TrayLog 'Krisha window reused (was already open)'
        return $true
    }
    $browser = Get-AppBrowserPath
    if ($browser) {
        Start-Process -FilePath $browser -ArgumentList "--app=$base"
    } else {
        Start-Process -FilePath $base   # default browser, normal tab
    }
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $h = [KrishaTray.Native]::FindByExactTitle('Krisha', $false)
        if ($h -ne [IntPtr]::Zero) {
            [KrishaTray.Native]::ShowWindow($h, [KrishaTray.Native]::SW_RESTORE)
            [KrishaTray.Native]::SetForegroundWindow($h) | Out-Null
            Write-TrayLog 'Krisha window opened'
            return $true
        }
    }
    Write-TrayLog 'Krisha window did not appear within 20 s'
    return $false
}

function Ensure-KrishaRunning {
    param([switch]$NoWindow)
    if (Test-ServerHealthy) {
        Write-TrayLog "server already healthy at $base"
    } else {
        $proc = Start-KrishaServer
        $script:serverProc = $proc
        $script:serverOwnedByTray = $true
        $ready = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 1
            if ($proc -and $proc.HasExited) {
                Write-TrayLog "server process exited early (code $($proc.ExitCode)) — dev deps missing? (npm install)"
                break
            }
            if (Test-ServerHealthy) { $ready = $true; break }
        }
        if (-not $ready) { Write-TrayLog 'server did not become healthy within 90 s'; return $false }
    }
    if (-not $NoWindow) { return (Open-KrishaWindow) }
    return $true
}

function Invoke-KrishaSafetyStop {
    param([string]$Reason)
    try {
        $body = @{ reason = $Reason } | ConvertTo-Json
        $r = Invoke-RestMethod -Method Post -Uri "$base/api/safety/stop/activate" `
            -ContentType 'application/json' -Body $body -TimeoutSec 5
        Write-TrayLog "safety stop activated: $($r.result.reason)"
        return $true
    } catch {
        Write-TrayLog "safety stop failed: $_"
        return $false
    }
}

function Set-KrishaAutostart {
    param([bool]$Enable)
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Krisha.lnk'
    try {
        if ($Enable) {
            $ws = New-Object -ComObject WScript.Shell
            $sc = $ws.CreateShortcut($lnk)
            $sc.TargetPath = 'powershell.exe'
            $sc.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\krisha-tray.ps1`""
            $sc.WorkingDirectory = $repoRoot
            $sc.WindowStyle = 7
            $sc.Save()
            Write-TrayLog 'autostart enabled (Startup shortcut)'
        } elseif (Test-Path $lnk) {
            Remove-Item $lnk -Force
            Write-TrayLog 'autostart disabled'
        }
        return $true
    } catch {
        Write-TrayLog "autostart toggle failed: $_"
        return $false
    }
}

function Test-KrishaAutostart {
    return (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Krisha.lnk'))
}

function Convert-HotkeySpec {
    param([string]$Spec)
    # "ctrl+alt+k" -> @{ mods; vk }
    $mods = 0
    $vk = 0
    foreach ($part in ($Spec -split '\+')) {
        switch ($part.ToLower()) {
            'ctrl'   { $mods = $mods -bor [KrishaTray.Native]::MOD_CONTROL }
            'alt'    { $mods = $mods -bor [KrishaTray.Native]::MOD_ALT }
            'shift'  { $mods = $mods -bor [KrishaTray.Native]::MOD_SHIFT }
            'win'    { $mods = $mods -bor [KrishaTray.Native]::MOD_WIN }
            default  { $vk = [int][char]$part.ToUpper()[0] }
        }
    }
    return @{ mods = [uint32]$mods; vk = [uint32]$vk }
}

# ------------------------------------------------------------ summon-only mode

if ($SummonOnly) {
    $ok = Ensure-KrishaRunning
    if ($ok) { exit 0 } else { exit 1 }
}

# ----------------------------------------------------------------- tray host

Write-TrayLog 'tray host starting'

if ([KrishaTray.Native]::MutexHeld('KrishaTrayHostMutex')) {
    Write-TrayLog 'another tray host instance already holds the mutex — exiting'
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# -- tray icon (generated, no asset dependency): dark disc, blue "K"
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 2, 4, 10))), 1, 1, 30, 30)
$g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 59, 130, 246)), 2), 2, 2, 28, 28)
$font = New-Object System.Drawing.Font 'Segoe UI', 14, ([System.Drawing.FontStyle]::Bold)
$g.DrawString('K', $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 147, 197, 253))), 8, 4)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$font.Dispose()

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = 'Krisha — Ctrl+Alt+K summon | Ctrl+Alt+X stop'
$notify.Visible = $true

$form = New-Object KrishaTray.HotkeyForm

$script:serverProc = $null
$script:serverOwnedByTray = $false

function Show-Balloon {
    param([string]$Title, [string]$Text, [string]$Type = 'Info')
    try { $notify.BalloonTipTitle = $Title; $notify.BalloonTipText = $Text; $notify.ShowBalloonTip(2000) } catch { }
}

# -- hotkeys
$summon = Convert-HotkeySpec $cfg['summonHotkey']
$stop   = Convert-HotkeySpec $cfg['stopHotkey']

# handle creation happens on first .Handle access
$null = $form.Handle
$summonOk = [KrishaTray.Native]::RegisterHotKey($form.Handle, 1, $summon.mods, $summon.vk)
$stopOk   = [KrishaTray.Native]::RegisterHotKey($form.Handle, 2, $stop.mods, $stop.vk)
if (-not $summonOk) { Write-TrayLog "summon hotkey '$($cfg['summonHotkey'])' is taken by another app" }
if (-not $stopOk)   { Write-TrayLog "stop hotkey '$($cfg['stopHotkey'])' is taken by another app" }

function Invoke-Summon {
    $h = [KrishaTray.Native]::FindByExactTitle('Krisha', $false)
    if ($h -eq [IntPtr]::Zero) {
        Show-Balloon 'Krisha' 'Waking Krisha…' 'Info'
        Write-TrayLog 'summon: no window — starting helper'
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\krisha-tray.ps1`"", '-SummonOnly' `
            -WindowStyle Hidden | Out-Null
        return
    }
    if ([KrishaTray.Native]::IsWindowVisible($h)) {
        [KrishaTray.Native]::ShowWindow($h, [KrishaTray.Native]::SW_HIDE)
        Write-TrayLog 'summon: window hidden'
    } else {
        [KrishaTray.Native]::ShowWindow($h, [KrishaTray.Native]::SW_RESTORE)
        [KrishaTray.Native]::SetForegroundWindow($h) | Out-Null
        Write-TrayLog 'summon: window shown + focused'
    }
}

$hotkeyHandler = [Action[int]] {
    param($id)
    if ($id -eq 1) { Invoke-Summon }
    elseif ($id -eq 2) {
        Write-TrayLog 'stop hotkey pressed — activating safety stop'
        $ok = Invoke-KrishaSafetyStop -Reason 'Krisha tray: Ctrl+Alt+X emergency stop (operator hotkey)'
        if ($ok) { Show-Balloon 'Krisha stopped' 'Safety stop active. Resume via: npm run recovery' 'Warning' }
        else     { Show-Balloon 'Krisha' 'Safety stop failed — is the server running?' 'Error' }
    }
}
$form.add_Hotkey($hotkeyHandler)

# -- optional corner failsafe (OFF by default)
if ($cfg['cornerFailsafe']) {
    $script:dwellTicks = 0
    $script:needTicks = [Math]::Max(1, [int]([double]$cfg['cornerDwellSeconds'] * 2))  # 500 ms timer
    $cornerTimer = New-Object System.Windows.Forms.Timer
    $cornerTimer.Interval = 500
    $cornerTimer.add_Tick({
        try {
            $p = New-Object KrishaTray.Native+POINT
            [KrishaTray.Native]::GetCursorPos([ref]$p) | Out-Null
            $inCorner = $false
            foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
                $b = $screen.Bounds; $t = 8
                if (($p.X -le $b.Left + $t -or $p.X -ge $b.Right - $t) -and
                    ($p.Y -le $b.Top + $t -or $p.Y -ge $b.Bottom - $t)) { $inCorner = $true; break }
            }
            if ($inCorner) {
                $script:dwellTicks++
                if ($script:dwellTicks -ge $script:needTicks) {
                    $script:dwellTicks = 0
                    Write-TrayLog 'corner failsafe tripped'
                    $ok = Invoke-KrishaSafetyStop -Reason 'Krisha tray: corner failsafe dwell'
                    if ($ok) { Show-Balloon 'Krisha stopped' 'Corner failsafe. Resume via: npm run recovery' 'Warning' }
                }
            } else { $script:dwellTicks = 0 }
        } catch { }
    })
    $cornerTimer.Start()
}

# -- tray menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Krisha'
$miOpen.add_Click({ Invoke-Summon })
$menu.Items.Add($miOpen) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Safety stop (Ctrl+Alt+X)'
$miStop.add_Click({
    $ok = Invoke-KrishaSafetyStop -Reason 'Krisha tray: safety stop from tray menu'
    if ($ok) { Show-Balloon 'Krisha stopped' 'Safety stop active. Resume via: npm run recovery' 'Warning' }
    else     { Show-Balloon 'Krisha' 'Safety stop failed — is the server running?' 'Error' }
})
$menu.Items.Add($miStop) | Out-Null

$miServer = New-Object System.Windows.Forms.ToolStripMenuItem 'Stop Krisha Server'
$miServer.add_Click({
    if ($script:serverOwnedByTray -and $script:serverProc -and -not $script:serverProc.HasExited) {
        [void](Stop-KrishaServerProcess -ProcessId $script:serverProc.Id)
        Show-Balloon 'Krisha' 'Server stopped.' 'Info'
        $miServer.Enabled = $false
    }
})
$menu.Items.Add($miServer) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$miAuto.Checked = Test-KrishaAutostart
$miAuto.add_Click({
    $enable = -not $miAuto.Checked
    [void](Set-KrishaAutostart -Enable $enable)
    $miAuto.Checked = $enable
})
$menu.Items.Add($miAuto) | Out-Null

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit tray (server keeps running)'
$miExit.add_Click({
    Write-TrayLog 'tray exit requested'
    [void][KrishaTray.Native]::UnregisterHotKey($form.Handle, 1)
    [void][KrishaTray.Native]::UnregisterHotKey($form.Handle, 2)
    $notify.Visible = $false
    $notify.Dispose()
    $form.Close()
})
$menu.Items.Add($miExit) | Out-Null

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Invoke-Summon })

# -- boot: ensure server + window, then idle in the tray
Show-Balloon 'Krisha' 'Tray resident. Ctrl+Alt+K to summon.' 'Info'
$bootOk = Ensure-KrishaRunning
if ($bootOk) {
    Write-TrayLog 'boot complete (server + window)'
} else {
    Show-Balloon 'Krisha' 'Server did not start — check windows/tray.log (npm install first?)' 'Error'
}

[System.Windows.Forms.Application]::Run($form)
Write-TrayLog 'tray host exited'
