import { useCallback, useEffect, useState } from 'react';

/**
 * LPV — the only approval surface for Local Private Vault challenges.
 *
 * Mirrors the RollbackApprovalCard contract: local automation (or a future
 * agent integration) may REQUEST a vault operation (save a credential, fill
 * a login) by creating a challenge, but approval happens ONLY here — through
 * an explicit operator click. This excludes the model under the current
 * architecture; it does not authenticate against a determined same-user
 * local process (accepted, disclosed boundary, same as E5).
 *
 * Displayed data is metadata only: purpose, entry title/draft, destination
 * origin, requester, expiry. NEVER the secret itself.
 */
interface PendingVaultChallenge {
  challengeId: string;
  purpose: 'save' | 'fill';
  entryId?: string;
  origin?: string;
  entryDraft?: { categoryKey: string; title: string; url?: string };
  entryTitle?: string;
  category?: 'A' | 'B';
  requester: string;
  expiresAt: number;
  /** One-time decision capability delivered ONLY through this pending
   *  listing — approve/decline must present it, so a blind call that never
   *  surfaced the operator card is refused server-side. */
  decisionToken: string;
}

export function LpvApprovalCard({ isLightMode }: { isLightMode: boolean }) {
  const [pending, setPending] = useState<PendingVaultChallenge | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/vault/approvals/pending');
      const json = await res.json();
      const list = json?.success && Array.isArray(json?.result) ? (json.result as PendingVaultChallenge[]) : [];
      setPending(list.length > 0 ? list[0] : null);
    } catch {
      setPending(null); // server unreachable — nothing to authorize
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 5000);
    return () => clearInterval(timer);
  }, [poll]);

  const act = useCallback(
    async (action: 'approve' | 'decline') => {
      if (!pending || busy) return;
      setBusy(true);
      try {
        await fetch(`/api/vault/approvals/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: pending.challengeId, decisionToken: pending.decisionToken }),
        });
      } catch {
        /* the next poll refreshes state */
      }
      setBusy(false);
      void poll();
    },
    [pending, busy, poll]
  );

  if (!pending) return null;
  const bg = isLightMode ? 'rgba(255,255,255,0.97)' : 'rgba(18,20,26,0.97)';
  const fg = isLightMode ? '#1c1e26' : '#f2f3f7';
  const sub = isLightMode ? '#5a5e6d' : '#a8adbf';
  const accent = isLightMode ? '#92400e' : '#fbbf24';

  const title = pending.entryTitle ?? pending.entryDraft?.title ?? 'a vault entry';
  const origin = pending.origin ?? pending.entryDraft?.url ?? '—';

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 60,
        maxWidth: 360,
        background: bg,
        color: fg,
        borderRadius: 14,
        padding: '14px 16px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
        border: `1px solid ${isLightMode ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)'}`,
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        {pending.purpose === 'save' ? 'Credential save requested' : 'Credential fill requested'}
      </div>
      <div style={{ fontSize: 12, color: sub, marginBottom: 8 }}>
        {pending.purpose === 'save'
          ? `Automation wants to SAVE ${pending.entryDraft?.categoryKey ? `(${pending.entryDraft.categoryKey}, Category ${pending.category ?? 'A'})` : 'a new credential'} — “${pending.entryDraft?.title ?? title}”.`
          : `Automation wants to USE the credential of “${title}”${pending.category ? ` (Category ${pending.category})` : ''} to sign in at ${origin}.`}
        <div style={{ marginTop: 4, fontSize: 11 }}>
          Destination: <code style={{ fontSize: 11 }}>{origin}</code> · requested by{' '}
          <code style={{ fontSize: 11 }}>{pending.requester}</code>
        </div>
        <div style={{ marginTop: 4, color: accent }}>
          Expires in {Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000))}s —
          {pending.purpose === 'fill'
            ? ' approving EXECUTES the fill server-side on the approved origin (no credential is ever displayed or handed to the requester).'
            : ' approving authorizes saving exactly this draft (single-use, expires with this card).'}
          The secret itself is never displayed.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => {
            void act('approve');
          }}
          disabled={busy}
          style={{
            flex: 1,
            padding: '8px 0',
            borderRadius: 9,
            border: 'none',
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 700,
            fontSize: 12,
            background: '#2563eb',
            color: '#fff',
          }}
        >
          Approve
        </button>
        <button
          onClick={() => {
            void act('decline');
          }}
          disabled={busy}
          style={{
            flex: 1,
            padding: '8px 0',
            borderRadius: 9,
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 600,
            fontSize: 12,
            background: 'transparent',
            color: fg,
            border: `1px solid ${isLightMode ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.25)'}`,
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
