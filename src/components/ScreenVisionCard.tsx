import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Eye,
  FileText,
  Copy,
  Check,
  X,
  Volume2,
  RefreshCw,
  ExternalLink,
  Maximize2,
  Sparkles,
  Monitor,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { ScreenVisionAction } from '../types';

interface ScreenVisionCardProps {
  action: ScreenVisionAction | null;
  onDismiss?: () => void;
  onOpenModal?: () => void;
  onRescan?: () => void;
  onSpeakText?: (text: string) => void;
  isLightMode?: boolean;
}

export const ScreenVisionCard: React.FC<ScreenVisionCardProps> = ({
  action,
  onDismiss,
  onOpenModal,
  onRescan,
  onSpeakText,
  isLightMode = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [showFullSummary, setShowFullSummary] = useState(false);

  if (!action) return null;

  const allTextString = action.texts?.map((t) => t.text).filter(Boolean).join('\n') || '';

  const handleCopy = () => {
    if (!allTextString && !action.summary) return;
    navigator.clipboard.writeText(allTextString || action.summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReadAloud = () => {
    const speechContent = action.summary + (allTextString ? `. Visible text includes: ${allTextString.slice(0, 300)}` : '');
    onSpeakText?.(speechContent);
  };

  const textCount = action.texts?.length || 0;
  const elementCount = action.elements?.length || 0;
  const errorCount = action.errors?.length || 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className={`w-full max-w-2xl mb-3 p-3.5 sm:p-4 rounded-2xl backdrop-blur-xl border shadow-xl flex flex-col gap-2.5 transition-all duration-300 relative overflow-hidden ${
          isLightMode
            ? 'bg-white/95 border-blue-200/90 shadow-[0_12px_36px_rgba(37,99,235,0.12)] text-slate-800'
            : 'bg-[#080d1e]/95 border-blue-500/35 shadow-[0_12px_40px_rgba(2,6,23,0.7)] text-slate-200'
        }`}
      >
        {/* Glow ambient background highlight */}
        <div className="absolute -top-16 -right-16 w-36 h-36 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Top Header Row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative flex items-center justify-center p-2 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-500/30 flex-shrink-0">
              <Eye className="w-4 h-4 animate-pulse" />
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#080d1e] animate-ping" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold text-blue-400 flex items-center gap-1">
                  <Monitor className="w-3 h-3" />
                  Screen Vision Active
                </span>
                {action.application && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 font-medium truncate max-w-[200px]">
                    {action.application}
                  </span>
                )}
              </div>
              <h4 className="text-xs sm:text-sm font-semibold truncate leading-tight mt-0.5">
                {action.activeWindowTitle || action.application || "User's Screen View"}
              </h4>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {onRescan && (
              <button
                type="button"
                onClick={onRescan}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer flex items-center gap-1 text-[11px] font-medium ${
                  isLightMode
                    ? 'hover:bg-slate-100 text-slate-600 hover:text-blue-600'
                    : 'hover:bg-blue-900/30 text-blue-300 hover:text-blue-100'
                }`}
                title="Capture updated screen view"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Re-scan</span>
              </button>
            )}

            {onOpenModal && (
              <button
                type="button"
                onClick={onOpenModal}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer flex items-center gap-1 text-[11px] font-medium ${
                  isLightMode
                    ? 'hover:bg-slate-100 text-slate-600 hover:text-blue-600'
                    : 'hover:bg-blue-900/30 text-blue-300 hover:text-blue-100'
                }`}
                title="Open Screen Vision Studio"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Inspect</span>
              </button>
            )}

            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  isLightMode
                    ? 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'
                    : 'hover:bg-blue-900/30 text-slate-400 hover:text-slate-200'
                }`}
                title="Dismiss Card"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Middle Content: Snapshot preview (if present) + What Krisha Sees */}
        <div className="flex flex-col sm:flex-row gap-3 items-start">
          {action.snapshotUrl && (
            <div
              onClick={onOpenModal}
              className="relative w-full sm:w-36 h-24 rounded-xl overflow-hidden border border-blue-500/25 bg-black/40 flex-shrink-0 cursor-pointer group"
              title="Click to zoom in"
            >
              <img
                src={action.snapshotUrl}
                alt="Captured screen view"
                className="w-full h-full object-cover transition-transform group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-blue-950/20 group-hover:bg-transparent transition-colors flex items-center justify-center">
                <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 px-2 py-1 rounded text-[10px] text-white flex items-center gap-1">
                  <Maximize2 className="w-2.5 h-2.5" /> Zoom
                </span>
              </div>
            </div>
          )}

          <div className="flex-1 min-w-0">
            <p className={`text-xs leading-relaxed ${isLightMode ? 'text-slate-700' : 'text-slate-300'}`}>
              {showFullSummary || action.summary.length <= 180
                ? action.summary
                : `${action.summary.slice(0, 180)}... `}
              {action.summary.length > 180 && (
                <button
                  type="button"
                  onClick={() => setShowFullSummary(!showFullSummary)}
                  className="text-blue-400 hover:underline font-medium text-[11px] ml-1 cursor-pointer"
                >
                  {showFullSummary ? 'Show less' : 'Read more'}
                </button>
              )}
            </p>

            {/* Badges: Texts found, Elements detected, Errors */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {textCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-300">
                  <FileText className="w-2.5 h-2.5" />
                  {textCount} text blocks read
                </span>
              )}
              {elementCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
                  <Layers className="w-2.5 h-2.5" />
                  {elementCount} UI elements
                </span>
              )}
              {errorCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-300">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  {errorCount} errors detected
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Bottom Actions Row */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-blue-500/15 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReadAloud}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                isLightMode
                  ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
                  : 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30'
              }`}
              title="Krisha reads the screen contents aloud"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>Read Aloud</span>
            </button>

            {allTextString && (
              <button
                type="button"
                onClick={handleCopy}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  isLightMode
                    ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                    : 'bg-slate-800/60 hover:bg-slate-800 text-slate-300 border border-slate-700/50'
                }`}
                title="Copy all extracted screen text to clipboard"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied!' : 'Copy Screen Text'}</span>
              </button>
            )}
          </div>

          {onOpenModal && (
            <button
              type="button"
              onClick={onOpenModal}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors cursor-pointer font-medium ml-auto"
            >
              <span>View Full Screen & Ask Questions</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
