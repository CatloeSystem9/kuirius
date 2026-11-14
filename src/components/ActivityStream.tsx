/**
 * ActivityStream (Action Transparency) — a live subtitle feed directly above
 * the composer. Renders ONLY entries derived from real system events (see
 * utils/activityFeed.ts): new sentences enter at the bottom, previous ones
 * move upward, older ones fade. Running actions, approval requests and
 * important errors stay until they are resolved or dismissed.
 *
 * The stream is pointer-transparent (it can never block the composer) except
 * for the dismiss affordances on sticky entries and the session-history
 * button. The session history here is a convenience view; the authoritative
 * audit record remains the server-side SafetyAuditLog.
 */
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { History, X } from 'lucide-react';
import type { ActivityEntry, ActivityKind } from '../utils/activityFeed';

interface ActivityStreamProps {
  entries: ActivityEntry[];
  history: ActivityEntry[];
  onDismiss: (id: number) => void;
  isLightMode?: boolean;
}

const KIND_STYLES: Record<ActivityKind, string> = {
  info: 'text-slate-300/90',
  success: 'text-emerald-300/90',
  error: 'text-red-300',
  approval: 'text-amber-300',
  running: 'text-cyan-200',
};

const KIND_DOT: Record<ActivityKind, string> = {
  info: 'bg-blue-400/70',
  success: 'bg-emerald-400/80',
  error: 'bg-red-400',
  approval: 'bg-amber-400',
  running: 'bg-cyan-300 animate-pulse',
};

const fmtTime = (at: number): string => {
  const d = new Date(at);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const ActivityStream: React.FC<ActivityStreamProps> = ({ entries, history, onDismiss, isLightMode = false }) => {
  const [historyOpen, setHistoryOpen] = useState(false);

  if (entries.length === 0 && !historyOpen) return null;

  return (
    <div className={`relative w-full flex flex-col items-center ${isLightMode ? '' : 'pointer-events-none'}`}>
      {/* Live entries — newest at the bottom, previous lines shift upward. */}
      <div className="flex flex-col items-center justify-end gap-1 w-full">
        <AnimatePresence initial={false}>
          {entries.map((entry) => {
            const interactive = entry.sticky === true;
            return (
              <motion.div
                key={entry.id}
                layout
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.45, ease: 'easeIn' } }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className={`pointer-events-auto flex items-center gap-2 max-w-[92%] sm:max-w-xl px-3 py-1 rounded-full ${
                  interactive
                    ? isLightMode
                      ? 'bg-white/90 border border-slate-200 shadow-sm'
                      : 'bg-[#070b16]/80 backdrop-blur-sm border border-white/[0.07]'
                    : ''
                }`}
                title={entry.text}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLightMode && entry.kind === 'info' ? 'bg-blue-500' : KIND_DOT[entry.kind]}`} />
                <span
                  className={`text-[11px] leading-4 truncate ${
                    isLightMode ? (entry.kind === 'error' ? 'text-red-700' : 'text-slate-700') : KIND_STYLES[entry.kind]
                  }`}
                >
                  {entry.text}
                </span>
                {interactive && (
                  <button
                    type="button"
                    onClick={() => onDismiss(entry.id)}
                    className="flex-shrink-0 p-0.5 rounded-full text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                    title="Dismiss"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Session history toggle — the only persistent affordance. */}
      {(history.length > 0 || historyOpen) && (
        <div className="mt-1 flex justify-end w-full pr-1">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className={`pointer-events-auto p-1.5 rounded-full transition-colors cursor-pointer ${
              isLightMode
                ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                : 'text-slate-500 hover:text-blue-300 hover:bg-white/[0.04]'
            }`}
            title="Recent activity (this session)"
          >
            <History className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Session history popover. */}
      <AnimatePresence>
        {historyOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.2 } }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className={`pointer-events-auto absolute bottom-0 right-0 z-40 w-[22rem] max-w-[92vw] rounded-2xl border shadow-xl overflow-hidden ${
              isLightMode ? 'bg-white/95 border-slate-200' : 'bg-[#070b16]/90 backdrop-blur-md border-white/[0.08]'
            }`}
          >
            <div className={`flex items-center justify-between px-3.5 py-2 border-b ${isLightMode ? 'border-slate-200' : 'border-white/[0.06]'}`}>
              <span className={`text-[11px] font-medium tracking-wide uppercase ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>
                Activity — this session
              </span>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className={`p-1 rounded-full transition-colors cursor-pointer ${isLightMode ? 'text-slate-400 hover:text-slate-700' : 'text-slate-500 hover:text-slate-200'}`}
                title="Close activity history"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto px-3.5 py-2 space-y-1.5">
              {history.length === 0 ? (
                <p className={`text-[11px] ${isLightMode ? 'text-slate-500' : 'text-slate-500'}`}>No activity yet.</p>
              ) : (
                [...history].reverse().map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${isLightMode && entry.kind === 'info' ? 'bg-blue-500' : KIND_DOT[entry.kind]}`} />
                    <span className={`text-[11px] leading-4 flex-1 ${isLightMode ? 'text-slate-700' : 'text-slate-300/90'}`}>{entry.text}</span>
                    <span className={`text-[10px] font-mono flex-shrink-0 mt-0.5 ${isLightMode ? 'text-slate-400' : 'text-slate-600'}`}>{fmtTime(entry.at)}</span>
                  </div>
                ))
              )}
            </div>
            <div className={`px-3.5 py-1.5 border-t ${isLightMode ? 'border-slate-200' : 'border-white/[0.06]'}`}>
              <span className={`text-[10px] ${isLightMode ? 'text-slate-400' : 'text-slate-600'}`}>
                Session view only — the full audit record is kept by the system's safety log.
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
