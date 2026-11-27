import { useCallback, useEffect, useState } from 'react';

/**
 * Approval Surface — the browser half of the unified operator surface.
 *
 * One card for every kind of decision Krisha needs: an execution-gate
 * launch, a rollback, a vault retrieval, a quarantine release. The Windows
 * toast is the other half of the same surface — both read the SAME pending
 * listing and both carry the SAME decision back, so a decision made in
 * either place is honoured identically.
 *
 * The card polls `/api/approvals/pending`, which is the ONLY place the
 * decision capability is released. A decision must present it, so a blind
 * approve() that never surfaced anything to a human is refused server-side
 * (the same doctrine the LPV vault enforces with its decision token).
 *
 * The card also reports PRESENCE. Presence is what separates "online — ask"
 * from "offline — Krisha may act alone on a proven-safe action type".
 */

interface PendingApproval {
  id: string;
  actionType: string;
  title: string;
  detail: string;
  risk: string;
  state: string;
  createdAt: number;
  expiresAt: number;
  surfaced: { at?: number; via?: string };
  autoApprovable: boolean;
  capability: string;
}

const ACTION_LABEL: Record<string, string> = {
  exec_launch: 'Launch',
  rollback: 'Rollback',
  quarantine_release: 'Quarantine release',
  vault_retrieval: 'Vault access',
  containment: 'Containment',
};

const RISK_COLOR: Record<string, string> = {
  low: '#3b82f6',
  medium: '#f59e0b',
  high: '#e5484d',
  critical: '#e5484d',
};

export function ApprovalSurfaceCard({ isLightMode }: { isLightMode: boolean }) {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals/pending');
      const json = await res.json();
      const list = Array.isArray(json?.requests) ? (json.requests as PendingApproval[]) : [];
      const next = list.length > 0 ? list[0] : null;
      setPending(next);
      if (next) {
        // Tell the server this request was genuinely shown to a human.
        // The server refuses a decision for anything never surfaced.
        try {
          await fetch('/api/approvals/surfaced', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: next.id, via: 'browser' }),
          });
        } catch { /* the next poll retries */ }
      }
    } catch {
      setPending(null); // server unreachable — nothing to authorize
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => { void poll(); }, 5000);
    return () => clearInterval(timer);
  }, [poll]);

  // Presence: report in while this window is open. The server treats an
  // absent heartbeat as "the operator is away" — which is what lets a
  // proven-safe action proceed without interrupting anyone.
  useEffect(() => {
    let alive = true;
    const beat = async () => {
      if (!alive) return;
      try {
        await fetch('/api/approvals/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ present: true }),
        });
      } catch { /* the server will time the presence out on its own */ }
    };
    void beat();
    const timer = setInterval(() => { void beat(); }, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
      try {
        void fetch('/api/approvals/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ present: false }),
        });
      } catch { /* best effort */ }
    };
  }, []);

  const act = useCallback(async (decision: 'approve' | 'deny') => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await fetch('/api/approvals/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: pending.id,
          decision,
          capability: pending.capability,
          via: 'browser',
        }),
      });
    } catch { /* the next poll refreshes state */ }
    setBusy(false);
    void poll();
  }, [pending, busy, poll]);

  if (!pending) return null;

  const bg = isLightMode ? 'rgba(255,255,255,0.97)' : 'rgba(18,20,26,0.97)';
  const fg = isLightMode ? '#1c1e26' : '#f2f3f7';
  const sub = isLightMode ? '#5a5e6d' : '#a8adbf';
  const border = isLightMode ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)';
  const risk = RISK_COLOR[pending.risk] ?? '#f59e0b';
  const expiresIn = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));

  return (
    <div style={{
      position: 'fixed', right: 20, bottom: 20, zIndex: 60, maxWidth: 380,
      background: bg, color: fg, borderRadius: 14, padding: '14px 16px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.25)', border: `1px solid ${border}`,
      fontFamily: 'inherit',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: risk, border: `1px solid ${risk}`, borderRadius: 6, padding: '2px 6px',
        }}>
          {ACTION_LABEL[pending.actionType] ?? pending.actionType}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{pending.title}</span>
      </div>
      <div style={{ fontSize: 12, color: sub, marginBottom: 8, lineHeight: 1.45 }}>
        {pending.detail}
        <div style={{ marginTop: 4 }}>
          Expires in {expiresIn}s
          {pending.autoApprovable
            ? ' · may run unattended once proven safe'
            : ' · always needs you'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => { void act('approve'); }}
          disabled={busy}
          style={{ flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', cursor: busy ? 'wait' : 'pointer', fontWeight: 700, fontSize: 12, background: '#e5484d', color: '#fff' }}
        >
          Approve
        </button>
        <button
          onClick={() => { void act('deny'); }}
          disabled={busy}
          style={{ flex: 1, padding: '8px 0', borderRadius: 9, cursor: busy ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'transparent', color: fg, border: `1px solid ${isLightMode ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.25)'}` }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
