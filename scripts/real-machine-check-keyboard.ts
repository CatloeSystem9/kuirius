/**
 * Real-machine keyboard check (Phase 6) — harmless Notepad workflow.
 * 1. launch Notepad + focus it
 * 2. type a harmless phrase through Krisha's keyboard endpoint
 * 3. press Enter
 * 4. Ctrl+A (select all) through Krisha's endpoint
 * 5. verify by copying the selection and comparing the clipboard
 * Cleanup: force-close Notepad (unsaved test content is discarded).
 */
import { exec as _exec, execFile as _execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(_exec);
const execFile = promisify(_execFile);

const BASE = 'http://localhost:3000';
const PHRASE = 'Krisha keyboard check 2026';

async function post(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/api/computer/keyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy');
}

/** Run a PowerShell snippet via execFile argv (no cmd quoting issues, no focus stealing). */
async function ps(script: string): Promise<string> {
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, windowsHide: true });
  return stdout.trim();
}

async function main() {
  await waitForHealth();
  console.log('server healthy');

  // E5 M1b enforcement reads server-side permission state — mirror this
  // script's keyboard-control grant (the explicit run IS the operator action).
  await fetch(`${BASE}/api/permissions/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: ['keyboard.control'] }),
  });

  // 1. Launch + focus Notepad (with active-window safety: never type into an
  //    unrelated foreground application).
  await exec('start notepad.exe', { shell: 'cmd.exe' });
  // Cold WinUI launches can take several seconds — poll for the process.
  let pid = NaN;
  for (let i = 0; i < 20 && !Number.isFinite(pid); i++) {
    await new Promise((r) => setTimeout(r, 700));
    const pidOut = await ps('(Get-Process notepad | Select-Object -First 1).Id');
    pid = parseInt(pidOut.trim(), 10);
  }
  if (!Number.isFinite(pid)) throw new Error('Notepad did not start');

  const fgTitle = () =>
    ps(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);' -Name FG -Namespace W;
$h=[W.FG]::GetForegroundWindow();
$sb=New-Object System.Text.StringBuilder 256;
[void][W.FG]::GetWindowText($h,$sb,256);
$sb.ToString()`
    );

  let focused = false;
  for (let attempt = 0; attempt < 5 && !focused; attempt++) {
    await ps(`(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null; Start-Sleep -Milliseconds 500`);
    if ((await fgTitle()).includes('Notepad')) { focused = true; break; }
    await ps(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);' -Name SFW -Namespace W2;
$h=(Get-Process -Id ${pid}).MainWindowHandle;
[void][W2.SFW]::SetForegroundWindow($h);
Start-Sleep -Milliseconds 500`
    );
    if ((await fgTitle()).includes('Notepad')) focused = true;
  }

  if (!focused) {
    await exec('taskkill /IM notepad.exe /F', { shell: 'cmd.exe', windowsHide: true }).catch(() => undefined);
    throw new Error('Active-window safety: Notepad could not be focused; aborting before typing');
  }
  console.log('foreground window: Notepad (focused)');

  // 2-5. Type → Enter → Ctrl+A → copy selection → verify via clipboard.
  // Retried up to 3 times (focus can be contested on a live desktop).
  let pass = false;
  for (let attempt = 1; attempt <= 3 && !pass; attempt++) {
    console.log(`attempt ${attempt}: focusing Notepad...`);
    await ps(`(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null; Start-Sleep -Milliseconds 500`);
    if (!(await fgTitle()).includes('Notepad')) {
      console.log('  focus lost before typing — refocusing');
      continue;
    }

    const typed = await post({ action: 'type', text: PHRASE + '\n' });
    if (!typed.success) throw new Error('type failed: ' + JSON.stringify(typed));
    await new Promise((r) => setTimeout(r, 500));

    const enter = await post({ action: 'key', key: 'enter' });
    if (!enter.success) throw new Error('enter failed');
    await new Promise((r) => setTimeout(r, 300));

    const selAll = await post({ action: 'hotkey', modifiers: ['ctrl'], key: 'a' });
    if (!selAll.success) throw new Error('ctrl+a failed');
    await new Promise((r) => setTimeout(r, 300));

    await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')");
    await new Promise((r) => setTimeout(r, 400));
    const clipboard = await ps('Get-Clipboard');
    pass = clipboard.includes(PHRASE);
    console.log(pass ? `attempt ${attempt}: verification PASS` : `attempt ${attempt}: verification FAIL`);
  }

  // Cleanup: discard the unsaved test document.
  await exec('taskkill /IM notepad.exe /F', { shell: 'cmd.exe', windowsHide: true }).catch(() => undefined);

  if (!pass) throw new Error('Verification failed after 3 attempts');
  console.log('REAL-MACHINE KEYBOARD CHECK: PASS (focus, type, enter, ctrl+a, verified)');
}

main()
  .catch((err) => {
    console.error('REAL-MACHINE KEYBOARD CHECK: FAIL —', err.message);
    exec('taskkill /IM notepad.exe /F', { shell: 'cmd.exe' }).catch(() => undefined);
    process.exit(1);
  });
