/**
 * Krisha E5 — Recovery CLI (M1c).
 *
 * The operator-controlled recovery channel. Runs as a separate console
 * process and speaks EXACTLY one protocol to the trusted Krisha server over
 * a local named pipe:
 *
 *   node krisha-recovery.ts --status
 *   node krisha-recovery.ts --arm            (INACTIVE → ACTIVE with an operator-chosen credential)
 *   node krisha-recovery.ts --set-credential (ACTIVE_NO_CREDENTIAL → ACTIVE_CREDENTIALED)
 *   node krisha-recovery.ts --recover        (ACTIVE_CREDENTIALED → INACTIVE; requires the credential)
 *   node krisha-recovery.ts --rotate         (rotate the credential; requires the current credential)
 *
 * Security properties:
 *   - The credential is typed with HIDDEN input (raw-mode TTY, no echo) and
 *     is NEVER placed in command-line arguments, environment variables,
 *     HTTP traffic, or written to disk by this process.
 *   - This process holds no permissions, no state, and no general-purpose
 *     command capability — the pipe exposes exactly the operations above.
 *   - A same-user process can connect to the pipe; the credential (knowledge)
 *     is what such a process cannot obtain. This is the documented boundary.
 */
import net from 'net';
import crypto from 'crypto';
import readline from 'readline';

const PIPE_PATH = '\\\\.\\pipe\\krisha-e5-recovery';
const FRAME_LIMIT = 4096;
const TIMEOUT_MS = 10_000;

const op = process.argv[2]?.replace(/^--/, '') ?? '';

const VALID_OPS = new Set(['status', 'arm', 'set-credential', 'recover', 'rotate', 'help']);
if (!VALID_OPS.has(op)) {
  console.log('Krisha recovery CLI — operator-controlled emergency-stop recovery.');
  console.log('');
  console.log('Usage: node krisha-recovery.ts --status | --arm | --set-credential | --recover | --rotate');
  console.log('');
  console.log('  --arm             Activate the emergency stop with a credential YOU choose.');
  console.log('                    The credential is never displayed or stored in plaintext.');
  console.log('  --set-credential   Set a credential on a stop that was activated without one');
  console.log('                    (model/UI activation). Required before in-band recovery.');
  console.log('  --recover          Deactivate an active stop. Requires the credential.');
  console.log('  --rotate           Replace the credential. Requires the current credential.');
  console.log('  --status           Show the server-side stop state (no credential needed).');
  process.exit(op === 'help' ? 0 : 1);
}

/** Hidden console input: raw-mode TTY, no echo, '*' masking, backspace works. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('credential entry requires an interactive terminal (TTY)'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    let value = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\x03') { // Ctrl-C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('cancelled by operator'));
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ' && value.length < 128) {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    function cleanup(): void {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      rl.close();
    }
    process.stdin.on('data', onData);
  });
}

function sendRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(32).toString('hex');
    const frame = JSON.stringify({ ...message, nonce }) + '\n';
    if (frame.length > FRAME_LIMIT) {
      reject(new Error('request too large'));
      return;
    }
    const socket = net.connect(PIPE_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('recovery pipe timed out — is the Krisha server running?'));
    }, TIMEOUT_MS);
    let buffer = '';
    socket.on('connect', () => socket.write(frame));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      const raw = buffer.slice(0, nl);
      socket.end();
      try {
        if (raw.length > FRAME_LIMIT) throw new Error('oversized response');
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`recovery pipe unavailable (${err.message}) — is the Krisha server running?`));
    });
  });
}

async function main(): Promise<void> {
  if (op === 'status') {
    const response = await sendRequest({ op: 'status' });
    if (response.ok) {
      const s = response.result as Record<string, unknown>;
      console.log('Emergency-stop state (server-authoritative):');
      console.log(`  kind:              ${s.kind}`);
      console.log(`  generation:        ${s.generation}`);
      console.log(`  reason:            ${s.reason ?? '—'}`);
      console.log(`  storage protection: ${s.storageProtection}`);
      console.log(`  audit degraded:    ${s.auditDegraded ? 'YES (evidence may be incomplete)' : 'no'}`);
      console.log(`  recovery pipe:     ${s.recoveryAvailable ? 'available' : 'UNAVAILABLE'}`);
      if (s.kind === 'ACTIVE_UNCERTAIN') {
        console.log('');
        console.log('  UNCERTAIN state — out-of-band recovery required:');
        console.log('    1. Stop the Krisha server process.');
        console.log('    2. Delete stop-state.json AND install.marker from the E5 store.');
        console.log('    3. Restart Krisha (boots INACTIVE as a fresh installation).');
      }
    } else {
      console.error(`status failed: ${response.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === 'arm') {
    const code = await askHidden('Choose a recovery credential (min 10 chars, 3 of: upper/lower/digit/symbol): ');
    const response = await sendRequest({ op: 'arm', code });
    if (response.ok) {
      console.log(`Emergency stop ARMED (generation ${(response.result as any)?.generation}).`);
      console.log('Remember this credential — it is required to deactivate the stop and is never displayed again.');
    } else {
      console.error(`arm failed: ${response.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === 'set-credential') {
    const code = await askHidden('Choose a recovery credential for the active stop (min 10 chars): ');
    const response = await sendRequest({ op: 'set-credential', code });
    if (response.ok) {
      console.log(`Credential set (generation ${(response.result as any)?.generation}). In-band recovery is now available.`);
    } else {
      console.error(`set-credential failed: ${response.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === 'recover') {
    const code = await askHidden('Recovery credential: ');
    const response = await sendRequest({ op: 'recover', code });
    if (response.ok) {
      console.log(`Emergency stop DEACTIVATED (generation ${(response.result as any)?.generation}). Normal permission-checked operation resumed.`);
    } else {
      console.error(`recover failed: ${response.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === 'rotate') {
    const current = await askHidden('Current credential: ');
    const fresh = await askHidden('New credential: ');
    const response = await sendRequest({ op: 'rotate', currentCode: current, newCode: fresh });
    if (response.ok) {
      console.log(`Credential rotated (generation ${(response.result as any)?.generation}). The previous credential no longer works.`);
    } else {
      console.error(`rotate failed: ${response.error}`);
      process.exitCode = 1;
    }
    return;
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
