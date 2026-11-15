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
  Sparkles,
  Monitor,
  AlertTriangle,
  Layers,
  Search,
  Send,
  Loader2,
  Maximize2,
  Compass,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { ScreenVisionAction, DetectedScreenText } from '../types';
import { spfFirewall } from '../agent/spf/index';

interface ScreenVisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  action: ScreenVisionAction | null;
  onRescanScreen: (question?: string) => Promise<void>;
  onSpeakText: (text: string) => void;
  isLightMode?: boolean;
}

export const ScreenVisionModal: React.FC<ScreenVisionModalProps> = ({
  isOpen,
  onClose,
  action,
  onRescanScreen,
  onSpeakText,
  isLightMode = false,
}) => {
  const [filterText, setFilterText] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [customQuestion, setCustomQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'text' | 'elements'>('overview');

  if (!isOpen) return null;

  const texts = action?.texts || [];
  const filteredTexts = filterText
    ? texts.filter((t) => t.text.toLowerCase().includes(filterText.toLowerCase()))
    : texts;

  const allTextString = texts.map((t) => t.text).filter(Boolean).join('\n');

  const handleCopyAll = () => {
    if (!allTextString) return;
    navigator.clipboard.writeText(allTextString);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handleCopySingle = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  const handleAskQuestion = async (q: string) => {
    if (!q.trim() || isAsking) return;
    setIsAsking(true);
    setAnswer(null);
    try {
      if (action?.snapshotUrl) {
        // SPF EP-11 — pre-send gate: a sensitive signal in the question or
        // window title blocks the snapshot upload before any bytes leave the
        // tab. The server independently re-runs the same gate.
        const preSend = spfFirewall.inspectImageTransfer(
          { question: q, activeWindowTitle: action.activeWindowTitle },
          { destination: 'gemini:vision-analyze', payloadKind: 'image', transport: 'prompt' }
        );
        if (preSend.decision === 'block') {
          setAnswer(
            `🔒 Screen Privacy Firewall: I did not send this screen to the cloud (${preSend.reason.replace(/_/g, ' ')}). ` +
            'Screen content that may include credentials must stay on your device.'
          );
          return;
        }
        // Query server vision endpoint directly with the custom question
        const base64 = action.snapshotUrl.includes(',')
          ? action.snapshotUrl.split(',')[1]
          : action.snapshotUrl;

        const res = await fetch('/api/vision/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: base64,
            question: preSend.decision === 'redact' && preSend.redactedText ? preSend.redactedText : q,
            activeWindowTitle: action.activeWindowTitle,
          }),
        });

        const data = await res.json();
        if (data?.spfBlocked) {
          setAnswer(
            `🔒 Screen Privacy Firewall: the server blocked this transmission (${String(data.spfReason ?? 'policy').replace(/^spf_blocked:/, '').replace(/_/g, ' ')}).`
          );
          return;
        }
        if (data?.analysis?.summary) {
          const ans = data.analysis.summary;
          setAnswer(ans);
          onSpeakText(ans);
        } else {
          setAnswer('I inspected your screen, but could not determine a specific answer to that question.');
        }
      } else {
        // Trigger a fresh re-scan with the custom question
        await onRescanScreen(q);
      }
    } catch (err: any) {
      setAnswer(`Inspection error: ${err?.message || 'Failed to inspect screen'}`);
    } finally {
      setIsAsking(false);
    }
  };

  const quickQuestions = [
    'Summarize what is on this screen',
    'Read all readable text and numbers',
    'What error or warning is showing?',
    'What application or website is open?',
    'What are the primary buttons or actions to click?',
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/75 backdrop-blur-md overflow-hidden animate-in fade-in duration-200"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-5xl h-[92vh] max-h-[820px] rounded-3xl border shadow-2xl flex flex-col overflow-hidden relative ${
          isLightMode
            ? 'bg-white text-slate-800 border-slate-200'
            : 'bg-[#060a17] text-slate-200 border-blue-500/30'
        }`}
      >
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-blue-500/20 flex items-center justify-between gap-3 flex-shrink-0 bg-gradient-to-r from-blue-950/30 to-indigo-950/20">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-blue-500/30 flex-shrink-0">
              <Eye className="w-5 h-5 animate-pulse" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-base sm:text-lg tracking-tight truncate">
                  Krisha Screen Vision Studio
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-mono bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  Live Vision
                </span>
              </div>
              <p className="text-xs text-blue-300/80 truncate">
                {action?.activeWindowTitle || action?.application || 'Screen capture and visual understanding'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => onRescanScreen()}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                isLightMode
                  ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
                  : 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/40'
              }`}
              title="Capture a new frame of your screen"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Capture New Frame</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                isLightMode
                  ? 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'
                  : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="Close Modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-5 pt-2 border-b border-blue-500/15 flex items-center gap-2 bg-[#080d22]/50 flex-shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'overview'
                ? 'border-blue-400 text-blue-300 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Screen & Analysis</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('text')}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'text'
                ? 'border-blue-400 text-blue-300 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Extracted Text ({texts.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('elements')}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'elements'
                ? 'border-blue-400 text-blue-300 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>UI Elements ({action?.elements?.length || 0})</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {/* TAB 1: OVERVIEW & SCREEN PREVIEW */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Left Column: Screen Snapshot + Interactive Question Box */}
              <div className="lg:col-span-7 flex flex-col gap-4">
                {/* Snapshot Image */}
                <div className="relative rounded-2xl overflow-hidden border border-blue-500/30 bg-black/60 shadow-xl group">
                  {action?.snapshotUrl ? (
                    <img
                      src={action.snapshotUrl}
                      alt="Current screen capture"
                      className="w-full max-h-[380px] object-contain mx-auto"
                    />
                  ) : (
                    <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-2">
                      <Monitor className="w-10 h-10 text-slate-600" />
                      <p className="text-xs">No screen frame captured yet.</p>
                      <button
                        type="button"
                        onClick={() => onRescanScreen()}
                        className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium mt-1 cursor-pointer"
                      >
                        Capture Screen Now
                      </button>
                    </div>
                  )}

                  {action?.snapshotUrl && (
                    <div className="absolute bottom-2 right-2 flex items-center gap-2">
                      <span className="text-[10px] bg-black/70 px-2 py-1 rounded-md text-slate-300 border border-white/10">
                        {action.application || 'Screen Frame'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Ask Krisha About Your Screen */}
                <div className={`p-4 rounded-2xl border ${isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-[#0a1026] border-blue-500/25'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                      Ask Krisha About What She Sees
                    </span>
                    {action?.summary && (
                      <button
                        type="button"
                        onClick={() => onSpeakText(action.summary)}
                        className="text-[11px] text-blue-400 hover:text-blue-200 flex items-center gap-1 transition-colors cursor-pointer"
                        title="Read full summary aloud"
                      >
                        <Volume2 className="w-3 h-3" />
                        <span>Read Aloud</span>
                      </button>
                    )}
                  </div>

                  {/* Quick Preset Buttons */}
                  <div className="flex items-center gap-1.5 flex-wrap mb-3">
                    {quickQuestions.map((q, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setCustomQuestion(q);
                          handleAskQuestion(q);
                        }}
                        className={`text-[10px] sm:text-[11px] px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                          isLightMode
                            ? 'bg-white hover:bg-blue-50 border-slate-200 text-slate-700 hover:text-blue-700'
                            : 'bg-blue-950/40 hover:bg-blue-900/40 border-blue-500/20 text-slate-300 hover:text-blue-200'
                        }`}
                      >
                        {q}
                      </button>
                    ))}
                  </div>

                  {/* Custom Question Input */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAskQuestion(customQuestion);
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      type="text"
                      value={customQuestion}
                      onChange={(e) => setCustomQuestion(e.target.value)}
                      placeholder="Ask anything about what is on your screen..."
                      className={`flex-1 text-xs px-3 py-2 rounded-xl border outline-none transition-all ${
                        isLightMode
                          ? 'bg-white border-slate-300 focus:border-blue-500'
                          : 'bg-[#080d20] border-blue-900/50 focus:border-blue-500 text-white placeholder-slate-500'
                      }`}
                    />
                    <button
                      type="submit"
                      disabled={!customQuestion.trim() || isAsking}
                      className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white disabled:opacity-40 transition-all flex items-center gap-1 cursor-pointer"
                    >
                      {isAsking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      <span>Ask</span>
                    </button>
                  </form>

                  {/* AI Response Box */}
                  <AnimatePresence>
                    {(answer || isAsking) && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        className={`mt-3 p-3 rounded-xl border text-xs leading-relaxed ${
                          isLightMode
                            ? 'bg-blue-50/80 border-blue-200 text-slate-800'
                            : 'bg-blue-950/60 border-blue-500/30 text-blue-100'
                        }`}
                      >
                        {isAsking ? (
                          <div className="flex items-center gap-2 text-blue-300">
                            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                            <span>Krisha is reading your screen and reasoning...</span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-mono uppercase text-blue-400 font-semibold">
                                Krisha's Visual Insight
                              </span>
                              <button
                                type="button"
                                onClick={() => answer && onSpeakText(answer)}
                                className="text-[10px] text-blue-400 hover:text-blue-200 flex items-center gap-1 cursor-pointer"
                              >
                                <Volume2 className="w-3 h-3" /> Replay Voice
                              </button>
                            </div>
                            <p>{answer}</p>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Right Column: Factual Summary + Application Info + Quick Text Preview */}
              <div className="lg:col-span-5 flex flex-col gap-4">
                {/* Visual Summary Card */}
                <div className={`p-4 rounded-2xl border ${isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-[#0a1026] border-blue-500/25'}`}>
                  <h4 className="text-xs font-semibold text-blue-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    What Krisha Sees
                  </h4>
                  <p className={`text-xs leading-relaxed mb-3 ${isLightMode ? 'text-slate-700' : 'text-slate-300'}`}>
                    {action?.summary || 'No screen summary generated yet. Click "Capture New Frame" to observe.'}
                  </p>

                  <div className="space-y-1.5 text-[11px] pt-2 border-t border-blue-500/15">
                    {action?.application && (
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400">Application:</span>
                        <span className="font-medium text-blue-300">{action.application}</span>
                      </div>
                    )}
                    {action?.activeWindowTitle && (
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-slate-400">Window:</span>
                        <span className="font-medium text-slate-200 truncate max-w-[220px]">{action.activeWindowTitle}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Text Blocks Read:</span>
                      <span className="font-medium text-emerald-400">{texts.length}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">UI Elements:</span>
                      <span className="font-medium text-indigo-400">{action?.elements?.length || 0}</span>
                    </div>
                  </div>
                </div>

                {/* Detected Errors or Warnings */}
                {((action?.errors && action.errors.length > 0) || (action?.warnings && action.warnings.length > 0)) && (
                  <div className="p-3.5 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-rose-300 mb-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>Errors / Warnings Visible on Screen</span>
                    </div>
                    <ul className="space-y-1 text-[11px] text-rose-200 list-disc list-inside">
                      {action.errors?.map((err, i) => <li key={`err-${i}`}>{err}</li>)}
                      {action.warnings?.map((warn, i) => <li key={`warn-${i}`}>{warn}</li>)}
                    </ul>
                  </div>
                )}

                {/* Quick Extracted Text Snippet */}
                <div className={`p-4 rounded-2xl border flex flex-col gap-2 ${isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-[#0a1026] border-blue-500/25'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      Key Legible Screen Text
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('text')}
                      className="text-[11px] text-blue-400 hover:underline cursor-pointer"
                    >
                      View all ({texts.length})
                    </button>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {texts.slice(0, 8).map((t, idx) => (
                      <div
                        key={idx}
                        className={`p-2 rounded-xl text-xs flex items-center justify-between gap-2 ${
                          isLightMode ? 'bg-white border border-slate-200' : 'bg-[#080d22] border border-blue-900/30'
                        }`}
                      >
                        <span className="truncate">{t.text}</span>
                        {t.kind && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono flex-shrink-0">
                            {t.kind}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  {allTextString && (
                    <button
                      type="button"
                      onClick={handleCopyAll}
                      className="mt-1 w-full py-1.5 rounded-xl border border-blue-500/30 bg-blue-600/15 hover:bg-blue-600/25 text-blue-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    >
                      {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedAll ? 'All Text Copied!' : 'Copy All Extracted Text'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: EXTRACTED TEXT FULL VIEW */}
          {activeTab === 'text' && (
            <div className="space-y-4">
              {/* Search & Actions Bar */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder="Search extracted text..."
                    className={`w-full text-xs pl-8 pr-3 py-2 rounded-xl border outline-none ${
                      isLightMode
                        ? 'bg-slate-50 border-slate-300 focus:border-blue-500'
                        : 'bg-[#080d22] border-blue-900/40 text-white focus:border-blue-500'
                    }`}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyAll}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition-all cursor-pointer"
                  >
                    {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedAll ? 'Copied All!' : 'Copy All Text'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => allTextString && onSpeakText(allTextString.slice(0, 400))}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 transition-all cursor-pointer"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Read Aloud</span>
                  </button>
                </div>
              </div>

              {/* Text Blocks List */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {filteredTexts.length > 0 ? (
                  filteredTexts.map((item, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-2xl border transition-all flex flex-col justify-between gap-2 ${
                        isLightMode
                          ? 'bg-white border-slate-200 hover:border-blue-300 shadow-sm'
                          : 'bg-[#080d22] border-blue-900/30 hover:border-blue-500/40 shadow-md'
                      }`}
                    >
                      <p className="text-xs font-normal leading-relaxed select-text">{item.text}</p>
                      <div className="flex items-center justify-between pt-1 border-t border-slate-700/20">
                        {item.kind && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-300">
                            {item.kind}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleCopySingle(item.text, idx)}
                          className="text-[11px] text-slate-400 hover:text-blue-300 flex items-center gap-1 ml-auto cursor-pointer"
                        >
                          {copiedIndex === idx ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          <span>{copiedIndex === idx ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="col-span-2 py-12 text-center text-slate-400 text-xs">
                    No text blocks match "{filterText}".
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: UI ELEMENTS */}
          {activeTab === 'elements' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                Krisha detected {action?.elements?.length || 0} interactive and structural UI elements on your screen.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {action?.elements && action.elements.length > 0 ? (
                  action.elements.map((el, i) => (
                    <div
                      key={i}
                      className={`p-3 rounded-2xl border flex flex-col gap-1.5 ${
                        isLightMode ? 'bg-white border-slate-200' : 'bg-[#080d22] border-blue-900/30'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-blue-300 uppercase font-mono">{el.type}</span>
                        {el.actionable && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-medium">
                            Actionable
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-medium truncate">{el.text || 'No label'}</p>
                      {el.bounds && (
                        <span className="text-[10px] text-slate-500 font-mono">
                          pos: x={Math.round(el.bounds.x * 100)}%, y={Math.round(el.bounds.y * 100)}%
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="col-span-3 py-12 text-center text-slate-400 text-xs">
                    No individual UI elements detected.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};
