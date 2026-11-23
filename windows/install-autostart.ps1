# One-click Krisha autostart installer (mirrors the tray menu checkbox).
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove: powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
param([switch]$Remove)

$repoRoot = Split-Path -Parent $PSScriptRoot
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Krisha.lnk'

if ($Remove) {
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force
        Write-Output "Removed: $lnk"
    } else {
        Write-Output 'Autostart shortcut not present — nothing to remove.'
    }
    exit 0
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\krisha-tray.ps1`""
$sc.WorkingDirectory = $repoRoot
$sc.WindowStyle = 7
$sc.Save()
Write-Output "Installed: $lnk"
Write-Output 'Krisha will start resident in the tray when Windows boots (Ctrl+Alt+K to summon).'
