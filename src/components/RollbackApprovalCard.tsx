import { useCallback, useEffect, useState } from 'react';

/**
 * E5 M3 — minimal operator authorization affordance for rollback challenges.
 *
 * The model can REQUEST a rollback plan but has no path to approve one: this
 * card is the only approval surface. It polls the server for pending,
 * operator-bound challenges (each bound to an operation id + plan hash +
 * exact journal state + stop generation, expiring after 10 minutes) and lets
 * the operator approve or decline. This excludes the model under the current
 * architecture; it does not authenticate against a determined same-user
 * local process (accepted, disclosed boundary).
 */
interface PendingChallenge {
  challengeId: string;
  opId: string;
  planHash: string;
  expiresAt: number;
  state: string;
  plan: {
    opKind: string;
    affectedPaths: Array<{ path: string; role: string }>;
    inverse: { kind: string; targetPath: string };
  };
}

export function RollbackApprovalCard({ isLightMode }: { isLightMode: boolean }) {
  const [pending, setPending] = useState<PendingChallenge | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/rollback/pending');
      const json = await res.json();
      const list = json?.success && Array.isArray(json?.result) ? json.result as PendingChallenge[] : [];
      setPending(list.length > 0 ? list[0] : null);
    } catch {
      setPending(null); // server unreachable — nothing to authorize
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => { void poll(); }, 5000);
    return () => clearInterval(timer);
  }, [poll]);

  const act = useCallback(async (action: 'approve' | 'decline') => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await fetch(`/api/rollback/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: pending.challengeId }),
      });
    } catch { /* the next poll refreshes state */ }
    setBusy(false);
    void poll();
  }, [pending, busy, poll]);

  if (!pending) return null;
  const bg = isLightMode ? 'rgba(255,255,255,0.97)' : 'rgba(18,20,26,0.97)';
  const fg = isLightMode ? '#1c1e26' : '#f2f3f7';
  const sub = isLightMode ? '#5a5e6d' : '#a8adbf';

  return (
    <div style={{
      position: 'fixed', right: 20, bottom: 20, zIndex: 60, maxWidth: 360,
      background: bg, color: fg, borderRadius: 14, padding: '14px 16px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.25)', border: `1px solid ${isLightMode ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)'}`,
      fontFamily: 'inherit',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        Rollback approval required
      </div>
      <div style={{ fontSize: 12, color: sub, marginBottom: 8 }}>
        Operation <code style={{ fontSize: 11 }}>{pending.opId.slice(0, 8)}…</code> · {pending.plan.opKind} → {pending.plan.inverse.kind.replace('-', ' ')}
        {pending.plan.affectedPaths.slice(0, 3).map((p, i) => (
          <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.role}: {p.path}
          </div>
        ))}
        <div style={{ marginTop: 4 }}>Expires in {Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000))}s · plan {pending.planHash.slice(0, 10)}…</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => { void act('approve'); }}
          disabled={busy}
          style={{ flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', cursor: busy ? 'wait' : 'pointer', fontWeight: 700, fontSize: 12, background: '#e5484d', color: '#fff' }}
        >
          Approve rollback
        </button>
        <button
          onClick={() => { void act('decline'); }}
          disabled={busy}
          style={{ flex: 1, padding: '8px 0', borderRadius: 9, cursor: busy ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'transparent', color: fg, border: `1px solid ${isLightMode ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.25)'}` }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
