import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Settings,
  Volume2,
  User,
  Sparkles,
  RefreshCw,
  Check,
  Mic,
  Globe,
  Play,
  Square,
  Download,
  Upload,
  Copy,
  CheckCircle2,
  Database,
} from 'lucide-react';
import { CompanionSettings, VoiceModel, LanguagePreference } from '../types';
import { speakKrishaText, stopKrishaSpeech } from '../utils/audio';
import { createKrishaBackupBundle, restoreKrishaBackupBundle } from '../utils/storage';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: CompanionSettings;
  onSaveSettings: (settings: CompanionSettings) => void;
  onResetAllData: () => void;
  onDataRestored?: () => void;
}

const AVAILABLE_VOICES: { id: VoiceModel; name: string; tag: string; description: string }[] = [
  {
    id: 'Aoede',
    name: 'Aoede (Sweet Muse)',
    tag: 'Sweetest Feminine',
    description: 'Bright, sweet, melodic & charming tone (Recommended)',
  },
  {
    id: 'Zephyr',
    name: 'Zephyr (Soft Breeze)',
    tag: 'Whisper Soft',
    description: 'Gentle, airy & peaceful feminine cadence',
  },
  {
    id: 'Leda',
    name: 'Leda (Graceful)',
    tag: 'Delicate',
    description: 'Sweet, graceful & soft-spoken tone',
  },
  {
    id: 'Kore',
    name: 'Kore (Warm Bloom)',
    tag: 'Calm Feminine',
    description: 'Calm, comforting & gentle warmth',
  },
  {
    id: 'Puck',
    name: 'Puck (Playful)',
    tag: 'Energetic',
    description: 'Cheerful, lively & bubbly pace',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onResetAllData,
  onDataRestored,
}) => {
  const [userName, setUserName] = useState(settings.userName);
  const [voiceEnabled, setVoiceEnabled] = useState(settings.voiceEnabled);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(
    settings.wakeWordEnabled !== undefined ? settings.wakeWordEnabled : true
  );
  const [voiceName, setVoiceName] = useState<VoiceModel>(settings.voiceName || 'Aoede');
  const [voiceSpeed, setVoiceSpeed] = useState(settings.voiceSpeed);
  const [voicePitch, setVoicePitch] = useState(settings.voicePitch ?? 1.25);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(
    settings.languagePreference || 'auto'
  );
  const [companionNotes, setCompanionNotes] = useState(settings.companionNotes || '');
  const [confirmReset, setConfirmReset] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [isPreviewSpeaking, setIsPreviewSpeaking] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [copiedBackup, setCopiedBackup] = useState(false);

  const handleExportBackup = () => {
    try {
      const bundle = createKrishaBackupBundle();
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `krisha-memories-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupStatus('Backup exported! Save this file to import into your terminal/localhost.');
      setTimeout(() => setBackupStatus(null), 5000);
    } catch (err) {
      setBackupStatus('Export failed: ' + String(err));
    }
  };

  const handleCopyBackup = () => {
    try {
      const bundle = createKrishaBackupBundle();
      navigator.clipboard.writeText(JSON.stringify(bundle));
      setCopiedBackup(true);
      setBackupStatus('All memories & chats copied! You can paste or restore anytime.');
      setTimeout(() => {
        setCopiedBackup(false);
        setBackupStatus(null);
      }, 4000);
    } catch {
      setBackupStatus('Could not copy to clipboard.');
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        const res = restoreKrishaBackupBundle(parsed);
        if (res.success) {
          setBackupStatus(`Restored ${res.restoredMemoriesCount} memories & ${res.restoredConversationsCount} chats! Reloading...`);
          onDataRestored?.();
          setTimeout(() => {
            window.location.reload();
          }, 1200);
        } else {
          setBackupStatus(`Import failed: ${res.message}`);
        }
      } catch {
        setBackupStatus('Failed to read file: invalid JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  if (!isOpen) return null;

  const handlePreviewVoice = (selectedVoice: VoiceModel = voiceName) => {
    if (isPreviewSpeaking) {
      stopKrishaSpeech();
      setIsPreviewSpeaking(false);
      return;
    }

    const samplePhrase =
      languagePreference === 'hi'
        ? 'नमस्ते जी! मैं कृषा हूँ, आपकी प्यारी और मीठी साथी~ क्या हाल है आपका?'
        : "Hi darling~ I'm Krisha! I've tuned my voice to sound extra sweet and feminine, just for you~";

    speakKrishaText(
      samplePhrase,
      selectedVoice,
      voiceSpeed,
      () => setIsPreviewSpeaking(true),
      () => setIsPreviewSpeaking(false),
      undefined,
      languagePreference,
      voicePitch
    );
  };

  const handleSave = () => {
    stopKrishaSpeech();
    onSaveSettings({
      userName: userName.trim(),
      voiceEnabled,
      wakeWordEnabled,
      voiceName,
      voiceSpeed,
      voicePitch,
      languagePreference,
      companionNotes: companionNotes.trim(),
    });
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 600);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#02040a]/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          transition={{ duration: 0.22 }}
          className="relative w-full max-w-lg bg-[#050810] border border-blue-900/30 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col max-h-[85vh] z-10 text-slate-300"
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/20 bg-[#080d1a]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <Settings className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90">
                  Settings
                </h2>
                <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                  Configure personality, speech, and preferences
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              id="close-settings-modal"
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Form Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* 1. Name Setting */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-blue-400" />
                <span>Your Name / Nickname</span>
              </label>
              <input
                type="text"
                placeholder="What should Krisha call you?"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="w-full bg-[#070b16] border border-blue-900/30 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors"
              />
            </div>

            {/* 2. Voice Settings */}
            <div className="space-y-3 pt-2 border-t border-blue-900/20">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-blue-400" />
                  <span>Voice & Speech</span>
                </label>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={voiceEnabled}
                    onChange={(e) => setVoiceEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {voiceEnabled && (
                <div className="space-y-3.5 pl-1">
                  {/* Voice Options Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {AVAILABLE_VOICES.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          setVoiceName(v.id);
                        }}
                        className={`text-left p-2.5 rounded-xl border text-xs transition-all cursor-pointer relative ${
                          voiceName === v.id
                            ? 'bg-gradient-to-br from-pink-950/40 to-blue-950/40 border-pink-500/60 text-pink-100 shadow-[0_0_15px_rgba(236,72,153,0.15)]'
                            : 'bg-[#060a14] border-blue-900/20 text-slate-400 hover:border-pink-500/30'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-200">{v.name}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                            voiceName === v.id
                              ? 'bg-pink-500/30 text-pink-300 border border-pink-500/40'
                              : 'bg-slate-800 text-slate-400'
                          }`}>
                            {v.tag}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 leading-tight">
                          {v.description}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Voice Test Preview Bar */}
                  <div className="flex items-center justify-between p-2.5 rounded-xl bg-pink-950/20 border border-pink-900/30">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-pink-400 animate-pulse" />
                      <div className="text-[11px] text-slate-300">
                        <span className="text-pink-300 font-medium">Sweet Feminine Tuning: </span>
                        <span>{voiceName} voice active</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handlePreviewVoice(voiceName)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-500/20 hover:bg-pink-500/30 border border-pink-500/40 text-pink-200 text-xs font-medium transition-all cursor-pointer shadow-sm active:scale-95"
                    >
                      {isPreviewSpeaking ? (
                        <>
                          <Square className="w-3 h-3 text-pink-400 fill-current" />
                          <span>Stop</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 text-pink-400 fill-current" />
                          <span>Test Voice</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Voice Sweetness & Pitch Slider */}
                  <div className="pt-1">
                    <div className="flex justify-between text-[11px] text-slate-400 mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <span>Voice Sweetness & Pitch</span>
                        <Sparkles className="w-3 h-3 text-pink-400" />
                      </span>
                      <span className="font-mono text-pink-400 font-medium">
                        {voicePitch >= 1.28
                          ? 'Ultra-Sweet & Feminine'
                          : voicePitch >= 1.18
                          ? 'Sweet Feminine'
                          : 'Soft Natural'}{' '}
                        ({voicePitch.toFixed(2)}x)
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.95"
                      max="1.45"
                      step="0.05"
                      value={voicePitch}
                      onChange={(e) => setVoicePitch(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                    />
                    <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                      <span>Deeper/Natural</span>
                      <span className="text-pink-400/80 font-medium">Sweet Feminine (Default)</span>
                      <span>Bright Anime Sweet</span>
                    </div>
                  </div>

                  {/* Speech Pace */}
                  <div className="pt-1">
                    <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                      <span>Speech Pace</span>
                      <span className="font-mono text-blue-400">{voiceSpeed.toFixed(2)}x</span>
                    </div>
                    <input
                      type="range"
                      min="0.75"
                      max="1.25"
                      step="0.05"
                      value={voiceSpeed}
                      onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Language & Multilingual Speech Mode */}
            <div className="space-y-3 pt-2 border-t border-blue-900/20">
              <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-blue-400" />
                <span>Language & Voice Speech (भाषा)</span>
              </label>
              <p className="text-[11px] text-slate-400">
                Krisha speaks naturally in different languages according to your input, with specialized fluency in English and Hindi.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  {
                    id: 'auto',
                    label: 'Auto (EN / HI)',
                    badge: 'Recommended',
                    desc: 'Dynamically adapts to whatever language you use',
                  },
                  {
                    id: 'en',
                    label: 'English',
                    badge: 'English Only',
                    desc: 'Responds in natural, fluent English',
                  },
                  {
                    id: 'hi',
                    label: 'हिन्दी / Hinglish',
                    badge: 'Hindi Mode',
                    desc: 'Responds in affectionate, warm Hindi speech',
                  },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLanguagePreference(item.id as any)}
                    className={`text-left p-2.5 rounded-xl border text-xs transition-all cursor-pointer ${
                      languagePreference === item.id
                        ? 'bg-blue-950/40 border-blue-600 text-blue-200 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                        : 'bg-[#060a14] border-blue-900/20 text-slate-400 hover:border-blue-700/40'
                    }`}
                  >
                    <div className="font-medium text-slate-200 flex items-center justify-between">
                      <span className="truncate">{item.label}</span>
                      {languagePreference === item.id && <Check className="w-3 h-3 text-blue-400 flex-shrink-0" />}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1 leading-tight line-clamp-2">
                      {item.desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* 3. Automatic Voice Wake-Word */}
            <div className="space-y-2 pt-2 border-t border-blue-900/20">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5 text-blue-400" />
                    <span>Auto Wake-Word ("Krisha")</span>
                  </label>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Automatically turns on & listens when you say <span className="text-blue-300 font-mono">"Krisha"</span> or <span className="text-blue-300 font-mono">"Hey Krisha"</span>.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 ml-3">
                  <input
                    type="checkbox"
                    checked={wakeWordEnabled}
                    onChange={(e) => setWakeWordEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>

            {/* 4. Companion Context Notes */}
            <div className="space-y-2 pt-2 border-t border-blue-900/20">
              <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                <span>Custom Persona & Nuance</span>
              </label>
              <textarea
                placeholder="Optional notes (e.g., 'Be gentle and speak softly', 'Call me by my favorite nickname', 'We met in college')..."
                value={companionNotes}
                onChange={(e) => setCompanionNotes(e.target.value)}
                rows={3}
                className="w-full bg-[#070b16] border border-blue-900/30 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors resize-none"
              />
            </div>

            {/* 4. Backup & Transfer (Export / Import Memories & Chats) */}
            <div className="space-y-2.5 pt-3 border-t border-blue-900/20">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-blue-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-blue-400" />
                  <span>Backup & Sync (Studio ↔ Terminal)</span>
                </label>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Krisha saves memories & conversations in your browser. Export your backup file here to easily restore her in your terminal, local folder, or another browser.
              </p>

              {backupStatus && (
                <div className="p-2.5 rounded-lg bg-blue-950/40 border border-blue-500/30 text-xs text-blue-300 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span>{backupStatus}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleExportBackup}
                  className="px-3 py-1.5 bg-blue-950/40 hover:bg-blue-900/40 border border-blue-800/40 hover:border-blue-700/60 rounded-xl text-xs text-blue-200 font-medium flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                  title="Download all memories, conversations, and settings as a JSON file"
                >
                  <Download className="w-3.5 h-3.5 text-blue-400" />
                  <span>Export Backup (.json)</span>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 bg-purple-950/30 hover:bg-purple-900/40 border border-purple-800/40 hover:border-purple-700/60 rounded-xl text-xs text-purple-200 font-medium flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                  title="Restore memories and chats from an exported backup file"
                >
                  <Upload className="w-3.5 h-3.5 text-purple-400" />
                  <span>Import Backup</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyBackup}
                  className="px-3 py-1.5 bg-slate-900/60 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl text-xs text-slate-300 font-medium flex items-center gap-1.5 transition-all cursor-pointer"
                  title="Copy backup JSON string to clipboard"
                >
                  {copiedBackup ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-slate-400" />
                      <span>Copy Data</span>
                    </>
                  )}
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportFile}
                />
              </div>
            </div>

            {/* 5. Reset Data */}
            <div className="pt-4 border-t border-blue-900/20">
              {!confirmReset ? (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="text-[11px] text-slate-500 hover:text-red-400 transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Reset All Local Companion Data</span>
                </button>
              ) : (
                <div className="p-3 rounded-xl bg-red-950/20 border border-red-900/30 flex items-center justify-between text-xs text-red-300">
                  <span>Are you sure? This erases all past chats & memories.</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        onResetAllData();
                        setConfirmReset(false);
                        onClose();
                      }}
                      className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs cursor-pointer"
                    >
                      Erase
                    </button>
                    <button
                      onClick={() => setConfirmReset(false)}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div className="p-4 border-t border-blue-900/20 bg-[#080d1a] flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-6 py-2 bg-blue-600/80 hover:bg-blue-600 text-white rounded-xl text-xs font-medium tracking-wider uppercase transition-all shadow-[0_0_15px_rgba(37,99,235,0.25)] flex items-center gap-1.5 cursor-pointer"
            >
              {savedSuccess ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
