import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Trash2, Edit3, Check, Lock, LockOpen, ShieldAlert, History, MousePointerClick, RefreshCw } from 'lucide-react';

/**
 * LPV — Local Private Vault management panel (post-roadmap capability).
 *
 * Self-contained: fetches its own server state through /api/vault/*. The UI
 * follows the vault's disclosure rules:
 *   - Entries are shown as METADATA ONLY (title, category, destination,
 *     timestamps). There is no "reveal secret" affordance anywhere.
 *   - Adding/editing takes the secret as masked input and sends it once;
 *     the response never contains it.
 *   - Category A (high sensitivity) saves require an explicit two-step
 *     confirmation that states exactly what will be stored and why.
 *   - Category C (OTP / CVV / temporary codes) is refused by the server
 *     (fail-closed) and the refusal is surfaced verbatim (reason kinds only).
 *   - Degraded storage / TAMPERED vault states are shown loudly; in degraded
 *     mode every write/unlock/fill is disabled until protection is restored.
 */

// --- server-facing types (metadata only — mirrors lpvCore.ts shapes) ---

interface VaultStatus {
  state: 'UNINITIALIZED' | 'LOCKED' | 'UNLOCKED' | 'TAMPERED' | 'UNAVAILABLE';
  initialized: boolean;
  locked: boolean;
  protection: string;
  storageRoot: string | null;
  entryCount: number;
  generation: number | null;
  verified: boolean;
  autoLockMs: number;
  lastActivityAt: number | null;
  fillsInFlight: number;
}

interface VaultEntryMeta {
  id: string;
  categoryKey: string;
  category: 'A' | 'B';
  title: string;
  hasUsername: boolean;
  hasNotes: boolean;
  url: string | null;
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt: number | null;
  retrieveCount: number;
}

interface VaultPolicy {
  autoSaveEnabled: boolean;
  autoSaveCategories: Record<string, boolean>;
  autoLockMs: number;
}

interface VaultHistoryEvent {
  seq?: number;
  at?: number;
  kind?: string;
  entryId?: string;
  categoryKey?: string;
  category?: string;
  approval?: string;
  requester?: string;
  result?: string;
  reason?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  result?: T;
  error?: string;
  errorKind?: string;
}

async function postJson<T>(path: string, body?: unknown): Promise<ApiEnvelope<T>> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return (await res.json()) as ApiEnvelope<T>;
  } catch (err) {
    return { success: false, error: String((err as Error)?.message || err) };
  }
}

async function getJson<T>(path: string): Promise<ApiEnvelope<T>> {
  try {
    const res = await fetch(path);
    return (await res.json()) as ApiEnvelope<T>;
  } catch (err) {
    return { success: false, error: String((err as Error)?.message || err) };
  }
}

const CATEGORY_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'google', label: 'Google account — high sensitivity' },
  { key: 'email_primary', label: 'Primary email — high sensitivity' },
  { key: 'banking', label: 'Banking — high sensitivity' },
  { key: 'payment', label: 'Payment account — high sensitivity' },
];

const CATEGORY_A_KEYS = new Set(['google', 'email_primary', 'banking', 'payment']);

function friendlyError(env: ApiEnvelope<unknown>): string {
  if (env.errorKind === 'temporary_secret_refused') {
    return 'Refused: this looks like a short-lived secret (OTP / verification code / CVV). Temporary codes are never stored in the vault.';
  }
  if (env.errorKind === 'degraded_mode') return 'Protected storage is degraded — vault writes, unlock and filling are disabled until protection is restored.';
  if (env.errorKind === 'vault_tampered') return `Vault integrity failure: ${env.error ?? 'the vault refuses all operations'}`;
  if (env.errorKind === 'vault_locked') return 'The vault is locked. Unlock it first.';
  if (env.errorKind === 'approval_required') return 'Saving this entry requires explicit approval.';
  return env.error || 'Operation failed';
}

interface LocalVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  isLightMode?: boolean;
}

export const LocalVaultModal: React.FC<LocalVaultModalProps> = ({ isOpen, onClose }) => {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [entriesVerified, setEntriesVerified] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [tamperReason, setTamperReason] = useState<string | null>(null);
  const [policy, setPolicy] = useState<VaultPolicy | null>(null);
  const [history, setHistory] = useState<VaultHistoryEvent[]>([]);
  const [historyUntrusted, setHistoryUntrusted] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [catKey, setCatKey] = useState('google');
  const [customCat, setCustomCat] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fUrl, setFUrl] = useState('');
  const [fUsername, setFUsername] = useState('');
  const [fPassword, setFPassword] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);

  // Edit form
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eTitle, setETitle] = useState('');
  const [eUrl, setEUrl] = useState('');
  const [eUsername, setEUsername] = useState('');
  const [ePassword, setEPassword] = useState('');
  const [eNotes, setENotes] = useState('');
  const [confirmEdit, setConfirmEdit] = useState(false);

  // Delete + fill
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [fillingId, setFillingId] = useState<string | null>(null);

  // Policy inputs
  const [newAutoCat, setNewAutoCat] = useState('');

  const effectiveCat = catKey === '__custom__' ? customCat.trim().toLowerCase() : catKey;
  const isCategoryA = CATEGORY_A_KEYS.has(effectiveCat) || (!CATEGORY_A_KEYS.has(effectiveCat) && effectiveCat.length > 0);

  const refreshStatus = useCallback(async (): Promise<VaultStatus | null> => {
    const env = await getJson<VaultStatus>('/api/vault/status');
    if (env.success && env.result) {
      setStatus(env.result);
      return env.result;
    }
    return null;
  }, []);

  const refreshEntries = useCallback(async () => {
    const env = await getJson<{ verified: boolean; tampered: boolean; tamperReason: string | null; entries: VaultEntryMeta[] }>('/api/vault/entries');
    if (env.success && env.result) {
      setEntries(env.result.entries);
      setEntriesVerified(env.result.verified);
      setTampered(env.result.tampered);
      setTamperReason(env.result.tamperReason);
    }
  }, []);

  const refreshPolicy = useCallback(async () => {
    const env = await getJson<{ verified: boolean; policy: VaultPolicy | null }>('/api/vault/policy');
    if (env.success && env.result) setPolicy(env.result.policy);
  }, []);

  const refreshHistory = useCallback(async () => {
    const env = await getJson<{ untrusted: boolean; reason: string | null; events: VaultHistoryEvent[] }>('/api/vault/history?limit=15');
    if (env.success && env.result) {
      setHistory(env.result.events);
      setHistoryUntrusted(env.result.untrusted);
    }
  }, []);

  // Poll status while open; refresh dependent data when the state changes.
  const lastStateRef = useRef<string>('');
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    const tick = async () => {
      const s = await refreshStatus();
      if (!alive || !s) return;
      if (s.state !== lastStateRef.current) {
        lastStateRef.current = s.state;
        void refreshEntries();
        void refreshPolicy();
        void refreshHistory();
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
      lastStateRef.current = '';
    };
  }, [isOpen, refreshStatus, refreshEntries, refreshPolicy, refreshHistory]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleCreate = () =>
    run(async () => {
      const env = await postJson<{ created: boolean }>('/api/vault/init');
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Encrypted vault created. It is locked — unlock it to add entries.' });
        await refreshStatus();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
      }
    });

  const handleUnlock = () =>
    run(async () => {
      const env = await postJson<{ unlocked: boolean }>('/api/vault/unlock');
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Vault unlocked.' });
        await refreshStatus();
        await refreshEntries();
        await refreshPolicy();
        await refreshHistory();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
      }
    });

  const handleLock = () =>
    run(async () => {
      const env = await postJson<{ locked: boolean }>('/api/vault/lock', { reason: 'operator requested' });
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Vault locked.' });
        await refreshStatus();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
      }
    });

  const handleRestore = () =>
    run(async () => {
      const env = await postJson<{ restored: boolean }>('/api/vault/restore');
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Previous generation restored (MAC verified). The vault is locked again.' });
        await refreshStatus();
        await refreshEntries();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
      }
    });

  const resetAddForm = () => {
    setShowAdd(false);
    setConfirmSave(false);
    setFTitle('');
    setFUrl('');
    setFUsername('');
    setFPassword('');
    setFNotes('');
    setCustomCat('');
    setCatKey('google');
  };

  const submitAdd = () =>
    run(async () => {
      const env = await postJson<{ entry: VaultEntryMeta }>('/api/vault/entry', {
        categoryKey: effectiveCat,
        title: fTitle.trim(),
        username: fUsername || undefined,
        password: fPassword,
        notes: fNotes || undefined,
        url: fUrl.trim() || undefined,
        approval: isCategoryA ? { kind: 'user-direct' } : { kind: 'user-direct' },
        requester: 'ui',
      });
      if (env.success) {
        setNotice({ kind: 'ok', text: `Saved "${fTitle.trim()}" (encrypted).` });
        resetAddForm();
        await refreshEntries();
        await refreshStatus();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
        setConfirmSave(false);
      }
    });

  const startEdit = (entry: VaultEntryMeta) => {
    setEditingId(entry.id);
    setETitle(entry.title);
    setEUrl(entry.url ?? '');
    setEUsername('');
    setEPassword('');
    setENotes('');
    setConfirmEdit(false);
  };

  const submitEdit = () =>
    run(async () => {
      if (!editingId) return;
      const env = await postJson<{ entry: VaultEntryMeta }>('/api/vault/entry/update', {
        id: editingId,
        title: eTitle.trim(),
        url: eUrl.trim() || undefined,
        username: eUsername || undefined,
        password: ePassword || undefined,
        notes: eNotes || undefined,
        approval: { kind: 'user-direct' },
        requester: 'ui',
      });
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Entry updated (re-encrypted).' });
        setEditingId(null);
        setConfirmEdit(false);
        await refreshEntries();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
        setConfirmEdit(false);
      }
    });

  const handleDelete = () =>
    run(async () => {
      if (!deleteId) return;
      const env = await postJson<{ deleted: boolean }>('/api/vault/entry/delete', { id: deleteId, requester: 'ui' });
      if (env.success) {
        setNotice({ kind: 'ok', text: 'Entry deleted (ciphertext removed).' });
        setDeleteId(null);
        await refreshEntries();
        await refreshStatus();
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
        setDeleteId(null);
      }
    });

  const handleFill = (entry: VaultEntryMeta) =>
    run(async () => {
      setFillingId(entry.id);
      try {
        if (entry.url) {
          await postJson('/api/browser/navigate', { url: entry.url });
        }
        const grantEnv = await postJson<{ grantId: string; origin: string }>('/api/vault/fill/request', { entryId: entry.id, requester: 'ui' });
        if (!grantEnv.success || !grantEnv.result) {
          setNotice({ kind: 'error', text: friendlyError(grantEnv) });
          return;
        }
        const fields: Array<{ secret: 'username' | 'password'; match: string }> = [];
        if (entry.hasUsername) fields.push({ secret: 'username', match: 'email' });
        fields.push({ secret: 'password', match: 'password' });
        const fillEnv = await postJson<{ success: boolean; url: string; filled: Array<{ secret: string; filled: boolean; matched?: string; reason?: string }> }>(
          '/api/vault/fill',
          { grantId: grantEnv.result.grantId, fields, requester: 'ui' }
        );
        if (fillEnv.success && fillEnv.result) {
          const parts = fillEnv.result.filled.map((f) => (f.filled ? `${f.secret} → "${f.matched ?? '?'}"` : `${f.secret}: ${f.reason ?? 'failed'}`));
          setNotice({ kind: 'ok', text: `Fill attempted on ${fillEnv.result.url} — ${parts.join(', ')}.` });
          await refreshEntries();
        } else {
          setNotice({ kind: 'error', text: friendlyError(fillEnv) });
        }
      } finally {
        setFillingId(null);
      }
    });

  const updatePolicy = (patch: Partial<VaultPolicy>) =>
    run(async () => {
      const env = await postJson<{ policy: VaultPolicy }>('/api/vault/policy/update', { ...patch, requester: 'ui' });
      if (env.success && env.result) {
        setPolicy(env.result.policy);
        setNotice({ kind: 'ok', text: 'Retention policy updated.' });
      } else {
        setNotice({ kind: 'error', text: friendlyError(env) });
      }
    });

  const unlocked = status?.state === 'UNLOCKED';
  const state = status?.state ?? 'UNAVAILABLE';

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#02040a]/85 backdrop-blur-md"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          transition={{ duration: 0.22 }}
          className="relative w-full max-w-xl bg-[#050810] border border-blue-900/30 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col max-h-[85vh] z-10 text-slate-300"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/20 bg-[#080d1a]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <Lock className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90">Local Private Vault</h2>
                <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                  Encrypted on this PC only — never sent to cloud AI
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Status banner */}
          <div className="px-6 py-3 border-b border-blue-900/20 bg-[#03060d] space-y-2">
            {state === 'UNAVAILABLE' && (
              <div className="flex items-center gap-2 text-[11px] text-red-300 font-mono">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                <span>Protected storage unavailable — the vault cannot operate.</span>
              </div>
            )}
            {state === 'UNINITIALIZED' && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-blue-300/80">
                  No vault yet. Create one to store credentials encrypted (DPAPI + AES-256-GCM), locked after every restart.
                </span>
                <button
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium cursor-pointer shrink-0"
                >
                  Create vault
                </button>
              </div>
            )}
            {state === 'TAMPERED' && (
              <div className="space-y-2">
                <div className="flex items-start gap-2 text-[11px] text-red-300 font-mono">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>VAULT INTEGRITY FAILURE — all operations refused. {tamperReason || tampered ? '' : ''}</span>
                </div>
                <div className="text-[10px] text-slate-500 font-mono break-words">{tamperReason ?? 'The on-disk vault does not match its MAC.'}</div>
                <button
                  onClick={() => void handleRestore()}
                  disabled={busy}
                  className="px-3 py-1.5 bg-amber-600/80 hover:bg-amber-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium cursor-pointer"
                >
                  Restore previous generation (MAC-verified)
                </button>
              </div>
            )}
            {(state === 'LOCKED' || state === 'UNLOCKED') && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[11px] font-mono">
                  {unlocked ? (
                    <LockOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  )}
                  <span className={unlocked ? 'text-emerald-300' : 'text-amber-300'}>
                    {unlocked ? 'Unlocked' : 'Locked'} · {status?.entryCount ?? 0} entries · gen {status?.generation ?? '—'} ·{' '}
                    {status?.verified ? 'verified' : 'metadata only'} · protection {status?.protection}
                  </span>
                </div>
                <button
                  onClick={() => void (unlocked ? handleLock() : handleUnlock())}
                  disabled={busy || state === 'LOCKED' ? state === 'LOCKED' && status?.protection === 'degraded' : false}
                  className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium cursor-pointer shrink-0"
                >
                  {unlocked ? 'Lock' : 'Unlock'}
                </button>
              </div>
            )}
            {status?.protection === 'degraded' && (
              <div className="text-[10px] text-amber-400/90 font-mono">
                Storage protection DEGRADED — writes, unlock and filling are disabled until protection is restored.
              </div>
            )}
          </div>

          {/* Notice */}
          {notice && (
            <div
              className={`px-6 py-2 text-[11px] border-b border-blue-900/20 ${
                notice.kind === 'ok' ? 'text-emerald-300 bg-emerald-950/20' : notice.kind === 'error' ? 'text-red-300 bg-red-950/20' : 'text-blue-300 bg-blue-950/20'
              }`}
            >
              {notice.text}
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Entries (metadata only) */}
            {(state === 'LOCKED' || state === 'UNLOCKED') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-500">Saved entries (metadata only — secrets are never shown)</span>
                  {unlocked && !showAdd && (
                    <button
                      onClick={() => setShowAdd(true)}
                      className="flex items-center gap-1 px-2.5 py-1 bg-blue-600/80 hover:bg-blue-600 text-white rounded-lg text-[10px] font-medium cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  )}
                </div>

                {showAdd && (
                  <div className="p-3 rounded-xl bg-[#060a14] border border-blue-900/30 space-y-2">
                    {!confirmSave ? (
                      <>
                        <div className="flex gap-2">
                          <select
                            value={catKey}
                            onChange={(e) => setCatKey(e.target.value)}
                            className="flex-1 bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                          >
                            {CATEGORY_OPTIONS.map((c) => (
                              <option key={c.key} value={c.key}>
                                {c.label}
                              </option>
                            ))}
                            <option value="__custom__">Other / custom category…</option>
                          </select>
                        </div>
                        {catKey === '__custom__' && (
                          <input
                            type="text"
                            placeholder="category key (e.g. roblox)"
                            value={customCat}
                            onChange={(e) => setCustomCat(e.target.value.toLowerCase())}
                            className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                          />
                        )}
                        {effectiveCat && !CATEGORY_A_KEYS.has(effectiveCat) && (
                          <div className="text-[10px] text-amber-300/80">
                            Unclassified categories behave as Category A (approval required, never auto-saved) until you explicitly enable auto-saving below.
                          </div>
                        )}
                        <input
                          type="text"
                          placeholder="Entry title (e.g. Gmail — main account)"
                          value={fTitle}
                          onChange={(e) => setFTitle(e.target.value)}
                          className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                        />
                        <input
                          type="text"
                          placeholder="Destination URL (https://…)"
                          value={fUrl}
                          onChange={(e) => setFUrl(e.target.value)}
                          className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                        />
                        <input
                          type="text"
                          placeholder="Username / email (optional)"
                          value={fUsername}
                          onChange={(e) => setFUsername(e.target.value)}
                          className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                        />
                        <input
                          type="password"
                          placeholder="Password"
                          value={fPassword}
                          onChange={(e) => setFPassword(e.target.value)}
                          className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                        />
                        <textarea
                          placeholder="Notes (optional)"
                          value={fNotes}
                          onChange={(e) => setFNotes(e.target.value)}
                          className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                          rows={2}
                        />
                        <div className="flex gap-2 justify-end">
                          <button onClick={resetAddForm} className="px-3 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
                            Cancel
                          </button>
                          <button
                            onClick={() => fTitle.trim() && fPassword && effectiveCat && setConfirmSave(true)}
                            disabled={!fTitle.trim() || !fPassword || !effectiveCat}
                            className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium cursor-pointer"
                          >
                            Review save
                          </button>
                        </div>
                      </>
                    ) : (
                      /* Two-step explicit confirmation — required for Category A */
                      <div className="space-y-2">
                        <div className={`p-2.5 rounded-lg border ${isCategoryA ? 'border-amber-500/40 bg-amber-950/20' : 'border-emerald-500/30 bg-emerald-950/20'}`}>
                          <div className={`text-[11px] font-semibold ${isCategoryA ? 'text-amber-200' : 'text-emerald-200'}`}>
                            {isCategoryA ? 'Category A — high sensitivity' : 'Category B — lower risk (auto-save enabled for this category)'}
                          </div>
                          <div className="text-[10px] text-slate-300 mt-1 leading-relaxed">
                            Krisha wants to store: <span className="text-slate-100">“{fTitle.trim()}”</span> (category{' '}
                            <span className="font-mono">{effectiveCat}</span>
                            {fUsername ? `, username "${fUsername}"` : ''}, a password
                            {fUrl ? `, for ${fUrl}` : ''}).
                          </div>
                          <div className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                            Why: so Krisha can fill this login for you locally on request. The secret is encrypted with AES-256-GCM under a DPAPI-protected key,
                            stays on this PC, is never sent to cloud AI, and is hidden even in this panel. OTPs, CVVs and temporary codes can never be stored.
                          </div>
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setConfirmSave(false)} className="px-3 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
                            Cancel
                          </button>
                          <button
                            onClick={() => void submitAdd()}
                            disabled={busy}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-[11px] font-semibold cursor-pointer"
                          >
                            Save encrypted
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {entries.length === 0 ? (
                  <div className="py-8 text-center text-slate-600 text-xs font-light">
                    No vault entries. {unlocked ? 'Add one with the button above.' : 'Unlock to manage entries.'}
                  </div>
                ) : (
                  entries.map((entry) => (
                    <div key={entry.id} className="p-3 rounded-xl bg-[#060a14] border border-blue-900/20 hover:border-blue-700/30 transition-all">
                      {editingId === entry.id ? (
                        <div className="space-y-2">
                          {!confirmEdit ? (
                            <>
                              <input
                                type="text"
                                value={eTitle}
                                onChange={(e) => setETitle(e.target.value)}
                                className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                                placeholder="Title"
                              />
                              <input
                                type="text"
                                value={eUrl}
                                onChange={(e) => setEUrl(e.target.value)}
                                className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                                placeholder="Destination URL (https://…)"
                              />
                              <input
                                type="text"
                                value={eUsername}
                                onChange={(e) => setEUsername(e.target.value)}
                                className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                                placeholder="New username (leave empty to keep)"
                              />
                              <input
                                type="password"
                                value={ePassword}
                                onChange={(e) => setEPassword(e.target.value)}
                                className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                                placeholder="New password (leave empty to keep)"
                              />
                              <textarea
                                value={eNotes}
                                onChange={(e) => setENotes(e.target.value)}
                                rows={2}
                                className="w-full bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                                placeholder="New notes (leave empty to keep)"
                              />
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
                                  Cancel
                                </button>
                                <button
                                  onClick={() => setConfirmEdit(true)}
                                  className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 text-white rounded-lg text-[11px] font-medium cursor-pointer"
                                >
                                  Review update
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="space-y-2">
                              <div className={`p-2.5 rounded-lg border ${entry.category === 'A' ? 'border-amber-500/40 bg-amber-950/20' : 'border-emerald-500/30 bg-emerald-950/20'}`}>
                                <div className={`text-[11px] font-semibold ${entry.category === 'A' ? 'text-amber-200' : 'text-emerald-200'}`}>
                                  Update “{entry.title}” ({entry.category === 'A' ? 'Category A — approval required' : 'Category B'})
                                </div>
                                <div className="text-[10px] text-slate-300 mt-1">
                                  The payload is re-encrypted with fresh randomness. Leave a field empty to keep its current value.
                                </div>
                              </div>
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => setConfirmEdit(false)} className="px-3 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
                                  Back
                                </button>
                                <button
                                  onClick={() => void submitEdit()}
                                  disabled={busy}
                                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-[11px] font-semibold cursor-pointer"
                                >
                                  Update encrypted
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : deleteId === entry.id ? (
                        <div className="space-y-2">
                          <div className="text-[11px] text-red-300">
                            Delete “{entry.title}”? The encrypted payload is removed from the vault and its backup. This cannot be undone.
                          </div>
                          <div className="flex gap-2 justify-end">
                            <button onClick={() => setDeleteId(null)} className="px-3 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
                              Cancel
                            </button>
                            <button
                              onClick={() => void handleDelete()}
                              disabled={busy}
                              className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded-lg text-[11px] font-semibold cursor-pointer"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2.5 flex-1 min-w-0">
                              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${entry.category === 'A' ? 'bg-amber-400' : 'bg-emerald-400'} shadow-[0_0_6px_currentcolor]`} />
                              <div className="min-w-0">
                                <div className="text-xs text-slate-200 leading-relaxed truncate">{entry.title}</div>
                                <div className="text-[10px] text-slate-500 font-mono truncate">
                                  {entry.category} · {entry.categoryKey}
                                  {entry.url ? ` · ${entry.url.replace(/^https?:\/\//, '').slice(0, 40)}` : ''}
                                </div>
                                <div className="text-[10px] text-slate-600 font-mono">
                                  updated {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}
                                  {entry.retrieveCount > 0 ? ` · used ${entry.retrieveCount}×` : ' · never used'}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {unlocked && entry.url && (
                                <button
                                  title="Open in Krisha's browser and fill (credential never shown or returned)"
                                  onClick={() => void handleFill(entry)}
                                  disabled={busy || fillingId === entry.id}
                                  className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                                >
                                  <MousePointerClick className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {unlocked && (
                                <>
                                  <button
                                    title="Edit entry"
                                    onClick={() => startEdit(entry)}
                                    className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    title="Delete entry"
                                    onClick={() => setDeleteId(entry.id)}
                                    className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/40 rounded-lg transition-colors cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          {!entriesVerified && (
                            <div className="mt-1.5 text-[10px] text-amber-400/70 font-mono">metadata shown while locked — verified at unlock</div>
                          )}
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Retention policy */}
            {unlocked && policy && (
              <div className="p-3 rounded-xl bg-[#060a14] border border-blue-900/20 space-y-2.5">
                <div className="text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-500">Retention policy</div>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-slate-300">Automatic saving enabled (master switch)</span>
                  <button
                    onClick={() => void updatePolicy({ autoSaveEnabled: !policy.autoSaveEnabled })}
                    disabled={busy}
                    className={`w-10 h-5 rounded-full transition-colors cursor-pointer relative ${policy.autoSaveEnabled ? 'bg-emerald-600' : 'bg-slate-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${policy.autoSaveEnabled ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </label>
                <div className="text-[10px] text-slate-500 leading-relaxed">
                  Auto-save applies ONLY to the categories you explicitly enable below (Category B). High-sensitivity categories (google, email_primary,
                  banking, payment) and every unclassified category always require explicit approval and are never auto-saved. OTPs / CVVs / temporary codes are
                  refused outright.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(policy.autoSaveCategories).length === 0 && <span className="text-[10px] text-slate-600 font-mono">no auto-save categories enabled</span>}
                  {Object.keys(policy.autoSaveCategories).map((k) => (
                    <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/40 border border-emerald-700/30 text-[10px] text-emerald-300 font-mono">
                      {k}
                      <button
                        onClick={() => void updatePolicy({ autoSaveCategories: { [k]: false } })}
                        className="text-emerald-400/70 hover:text-red-300 cursor-pointer"
                        title="Disable auto-save for this category"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="enable auto-save for category key (e.g. roblox)"
                    value={newAutoCat}
                    onChange={(e) => setNewAutoCat(e.target.value.toLowerCase())}
                    className="flex-1 bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newAutoCat.trim()) {
                        void updatePolicy({ autoSaveCategories: { [newAutoCat.trim()]: true } });
                        setNewAutoCat('');
                      }
                    }}
                    disabled={busy || !newAutoCat.trim()}
                    className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium cursor-pointer"
                  >
                    Enable
                  </button>
                </div>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-slate-300">Auto-lock after inactivity</span>
                  <select
                    value={String(policy.autoLockMs)}
                    onChange={(e) => void updatePolicy({ autoLockMs: Number(e.target.value) })}
                    className="bg-[#070b16] border border-blue-900/30 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                  >
                    <option value="60000">1 minute</option>
                    <option value="300000">5 minutes</option>
                    <option value="900000">15 minutes</option>
                    <option value="1800000">30 minutes</option>
                    <option value="3600000">1 hour</option>
                  </select>
                </label>
              </div>
            )}

            {/* Access history */}
            {(state === 'LOCKED' || state === 'UNLOCKED') && (
              <div className="p-3 rounded-xl bg-[#060a14] border border-blue-900/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-500">
                    <History className="w-3 h-3" /> Access history (metadata only, hash-chained)
                  </div>
                  <button onClick={() => void refreshHistory()} className="p-1 text-slate-500 hover:text-blue-300 cursor-pointer" title="Refresh">
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </div>
                {historyUntrusted && (
                  <div className="text-[10px] text-red-300 font-mono flex items-start gap-1.5">
                    <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" /> audit chain UNTRUSTED — do not rely on this history
                  </div>
                )}
                {history.length === 0 ? (
                  <div className="text-[10px] text-slate-600">No vault events recorded yet.</div>
                ) : (
                  <div className="space-y-1">
                    {history
                      .slice()
                      .reverse()
                      .map((ev, i) => (
                        <div key={i} className="text-[10px] font-mono text-slate-400 flex gap-2 items-baseline">
                          <span className="text-slate-600 shrink-0">{ev.at ? new Date(ev.at).toLocaleTimeString() : ''}</span>
                          <span className={ev.kind === 'lpv_save_denied' || ev.kind === 'lpv_retrieve_denied' || ev.kind === 'lpv_fill_refused' ? 'text-red-300' : 'text-blue-300'}>
                            {ev.kind?.replace('lpv_', '')}
                          </span>
                          <span className="truncate text-slate-500">
                            {ev.entryId ? `${ev.entryId.slice(0, 16)}…` : ''}
                            {ev.approval ? ` · ${ev.approval}` : ''}
                            {ev.requester ? ` · ${ev.requester}` : ''}
                            {ev.reason ? ` · ${ev.reason}` : ''}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
