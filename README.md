# Krisha

A local AI companion — persistent memory, voice with wake word, screen vision,
computer use (mouse/keyboard), browser automation, file operations behind a
sandbox, and a layered security system (execution gate → containment →
quarantine → rollback). Brain: Gemini via `@google/genai`. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full integration map.

## Quick start

```bat
npm install
Krisha.bat
```

`Krisha.bat` starts the native layer: it launches the Krisha server
(`npm run dev`, port 3000, loopback only), opens the Krisha window in an
app-mode browser window, and sits resident in the system tray. From then on,
Krisha is always one hotkey away.

Manual equivalent: `npm run dev`, then open http://127.0.0.1:3000.

## Native Windows layer (`windows/`)

| Piece | What it does |
|---|---|
| `krisha-tray.ps1` | Tray-resident host: hotkeys, server lifecycle, window management |
| `Krisha.bat` | One-click start (double-click) |
| `install-autostart.ps1` | Install/remove the "start with Windows" shortcut |
| `tray-config.json` | Port + hotkey + failsafe configuration |
| `selftest-hotkey.ps1` | End-to-end hotkey test (sends a synthetic Ctrl+Alt+K, expects the window to toggle twice) |
| `tray.log` | Tray event log |

### Hotkeys (global, work in any app)

| Keys | Action |
|---|---|
| `Ctrl+Alt+K` | Summon / hide the Krisha window (toggle) |
| `Ctrl+Alt+X` | **Safety stop** — cancels active tasks, revokes temporary permissions, blocks new side-effecting actions |

The safety stop is the server's own endpoint (`POST /api/safety/stop/activate`,
`src/agent/safety/emergencyStop.ts`). It deliberately has **no HTTP
deactivation**: resuming is an explicit recovery step (`npm run recovery`).
That is why the corner failsafe below is opt-in and off by default — a false
trigger would lock the runtime until you run recovery.

Tray menu: Open Krisha · Safety stop · Stop Krisha Server (only when the tray
started the server) · Start with Windows · Exit tray (server keeps running —
it is a background runtime by design).

### Corner failsafe (opt-in)

The classic "slam the mouse into a screen corner to abort" kill switch is
implemented in the tray (`cornerFailsafe: true` in `tray-config.json`, with a
2-second dwell in any screen corner so window-snapping never trips it).
Default: **off** — use `Ctrl+Alt+X` instead.

### Autostart

Either toggle **Start with Windows** in the tray menu, or:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install-autostart.ps1
```

Removes with `-Remove`. The shortcut launches the tray host hidden at boot.

### Configuration

`windows/tray-config.json`:

```json
{
  "port": 3000,
  "summonHotkey": "ctrl+alt+k",
  "stopHotkey": "ctrl+alt+x",
  "cornerFailsafe": false,
  "cornerDwellSeconds": 2
}
```

Hotkeys are parsed as `modifier+modifier+key` (`ctrl`, `alt`, `shift`, `win`).
If a hotkey is already taken by another app, the tray logs it and continues
without that hotkey (check `windows/tray.log`).

### Notes & limitations

- The server binds `127.0.0.1` only (no LAN exposure unless `KRISHA_BIND` is
  explicitly overridden).
- Global hotkeys registered by a non-elevated process do not fire while an
  **elevated** (Run-as-Administrator) window has focus — standard Windows
  integrity-level behavior.
- "Stop Krisha Server" is abrupt (taskkill /T); the runtime's children
  self-exit via the parent-PID probe documented in
  `src/server/runtimeShutdown.ts`. Restarting is always safe — the port bind
  is the single-instance lock.
- The `.env` file must contain `GEMINI_API_KEY` for the brain to work.

## Repo map

- `server.ts` — Express server: Gemini waterfall, TTS, vision, computer
  mouse/keyboard endpoints, browser control, fs agent, safety/security stack
- `src/agent/` — agent core: planner, tool registry, computer use, vision,
  containment, exec gate, identity, recovery
- `src/` — React SPA (avatar, chat, modals, utilities)
- `scripts/` — phase tests (`test-*.ts`) and real-machine checks
- `windows/` — native Windows layer (this document's subject)
