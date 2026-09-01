import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Settings, Volume2, User, Sparkles, RefreshCw, Check, Mic } from 'lucide-react';
import { CompanionSettings, VoiceModel } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: CompanionSettings;
  onSaveSettings: (settings: CompanionSettings) => void;
  onResetAllData: () => void;
}

const AVAILABLE_VOICES: { id: VoiceModel; name: string; description: string }[] = [
  { id: 'Kore', name: 'Kore', description: 'Calm, gentle & warm tone (Default)' },
  { id: 'Zephyr', name: 'Zephyr', description: 'Soft, airy & peaceful cadence' },
  { id: 'Puck', name: 'Puck', description: 'Playful, lively & expressive' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Deeper, grounding & resonant' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onResetAllData,
}) => {
  const [userName, setUserName] = useState(settings.userName);
  const [voiceEnabled, setVoiceEnabled] = useState(settings.voiceEnabled);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(
    settings.wakeWordEnabled !== undefined ? settings.wakeWordEnabled : true
  );
  const [voiceName, setVoiceName] = useState<VoiceModel>(settings.voiceName);
  const [voiceSpeed, setVoiceSpeed] = useState(settings.voiceSpeed);
  const [companionNotes, setCompanionNotes] = useState(settings.companionNotes || '');
  const [confirmReset, setConfirmReset] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveSettings({
      userName: userName.trim(),
      voiceEnabled,
      wakeWordEnabled,
      voiceName,
      voiceSpeed,
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
                <div className="space-y-3 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    {AVAILABLE_VOICES.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setVoiceName(v.id)}
                        className={`text-left p-2.5 rounded-xl border text-xs transition-all cursor-pointer ${
                          voiceName === v.id
                            ? 'bg-blue-950/40 border-blue-600 text-blue-200 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                            : 'bg-[#060a14] border-blue-900/20 text-slate-400 hover:border-blue-700/40'
                        }`}
                      >
                        <div className="font-medium text-slate-200">{v.name}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">
                          {v.description}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Speech Pace */}
                  <div className="pt-2">
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

            {/* 4. Reset Data */}
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
