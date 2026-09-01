import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Mic, MicOff, Volume2, VolumeX, Loader2, Sparkles, Radio, Paperclip } from 'lucide-react';

interface DirectChatInputProps {
  onSendMessage: (text: string) => void;
  onTypingChange?: (text: string) => void;
  onOpenPdfOrFile?: () => void;
  isLoading: boolean;
  isSpeaking: boolean;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  isLightMode?: boolean;
  wakeWordEnabled?: boolean;
  onToggleWakeWord?: () => void;
  wakeWordStatus?: string;
  wakeWordDetected?: boolean;
  liveTranscript?: string;
}

export const DirectChatInput: React.FC<DirectChatInputProps> = ({
  onSendMessage,
  onTypingChange,
  onOpenPdfOrFile,
  isLoading,
  isSpeaking,
  voiceEnabled,
  onToggleVoice,
  isLightMode = false,
  wakeWordEnabled = true,
  onToggleWakeWord,
  wakeWordStatus = 'listening',
  wakeWordDetected = false,
  liveTranscript = '',
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Single-shot speech recognition (when manually tapping the mic button)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
          let trans = '';
          for (let i = 0; i < event.results.length; i++) {
            trans += event.results[i][0].transcript;
          }
          if (trans) {
            setInputText(trans);
            onTypingChange?.(trans);
          }
          if (event.results[0]?.isFinal) {
            setIsRecording(false);
            if (trans.trim()) {
              onSendMessage(trans.trim());
              setInputText('');
              onTypingChange?.('');
            }
          }
        };

        recognition.onerror = () => {
          setIsRecording(false);
        };

        recognition.onend = () => {
          setIsRecording(false);
        };

        recognitionRef.current = recognition;
      }
    }
  }, [onSendMessage, onTypingChange]);

  const toggleRecording = () => {
    if (!recognitionRef.current) {
      return;
    }

    if (isRecording) {
      try {
        recognitionRef.current.stop();
      } catch {}
      setIsRecording(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (err) {
        console.error('Speech recognition error:', err);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setInputText(text);
    onTypingChange?.(text);
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim() && !isLoading) {
      onSendMessage(inputText.trim());
      setInputText('');
      onTypingChange?.('');
    }
  };

  const isAmbientListening = wakeWordEnabled && (wakeWordStatus === 'listening' || wakeWordStatus === 'detected');

  return (
    <div className="w-full max-w-2xl px-4 sm:px-6 flex flex-col items-center">
      {/* Wake-Word Status Pill / Indicator */}
      <AnimatePresence>
        {wakeWordEnabled && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="mb-2 flex items-center gap-2"
          >
            <button
              type="button"
              onClick={onToggleWakeWord}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all backdrop-blur-md cursor-pointer border ${
                wakeWordDetected
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                  : isSpeaking
                  ? 'bg-slate-800/40 border-slate-700/40 text-slate-400'
                  : isLightMode
                  ? 'bg-white/80 border-blue-200 text-blue-700 shadow-sm'
                  : 'bg-blue-950/40 border-blue-500/30 text-blue-300 shadow-[0_0_15px_rgba(30,58,138,0.2)]'
              }`}
              title="Click to toggle automatic wake-word listening"
            >
              {wakeWordDetected ? (
                <>
                  <Sparkles className="w-3 h-3 text-emerald-400 animate-spin" />
                  <span>"Krisha" detected — Turning on!</span>
                </>
              ) : isSpeaking ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span>Krisha is speaking...</span>
                </>
              ) : (
                <>
                  <Radio className="w-3 h-3 text-blue-400 animate-pulse" />
                  <span>
                    Auto-Listen: Say <strong className="text-blue-200 font-mono">"Krisha"</strong> to turn on
                  </span>
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Input Form */}
      <form
        onSubmit={handleSend}
        className={`w-full relative flex items-center rounded-2xl sm:rounded-full p-1.5 sm:p-2 backdrop-blur-md transition-all duration-500 ${
          wakeWordDetected
            ? 'border-emerald-500 shadow-[0_0_35px_rgba(16,185,129,0.4)]'
            : isLightMode
            ? 'bg-white/95 border border-slate-300/80 shadow-[0_10px_35px_rgba(0,0,0,0.08)] focus-within:border-blue-500 focus-within:shadow-[0_10px_35px_rgba(59,130,246,0.15)]'
            : 'bg-[#070b16]/90 border border-blue-900/35 hover:border-blue-500/40 focus-within:border-blue-500/60 shadow-[0_0_35px_rgba(2,4,10,0.8)]'
        }`}
      >
        {/* Microphone Button */}
        <button
          type="button"
          onClick={toggleRecording}
          id="btn-voice-input"
          className={`p-2.5 sm:p-3 rounded-full transition-all cursor-pointer flex-shrink-0 ${
            isRecording
              ? 'bg-rose-600 text-white shadow-[0_0_15px_rgba(225,29,72,0.5)] animate-pulse'
              : isAmbientListening
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30'
              : isLightMode
              ? 'bg-slate-100 text-slate-600 hover:text-blue-600 hover:bg-slate-200'
              : 'bg-[#0b1020] text-slate-400 hover:text-blue-300 hover:bg-[#101830]'
          }`}
          title={
            isRecording
              ? 'Recording your voice... Click to stop'
              : wakeWordEnabled
              ? 'Wake-word enabled (Say "Krisha" or click to speak)'
              : 'Click to speak'
          }
        >
          {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        {/* Paperclip / File Picker Button */}
        {onOpenPdfOrFile && (
          <button
            type="button"
            onClick={onOpenPdfOrFile}
            className={`p-2 rounded-full transition-colors cursor-pointer flex-shrink-0 ${
              isLightMode
                ? 'text-slate-500 hover:text-blue-600 hover:bg-slate-100'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40'
            }`}
            title="Pick & Open PDF / Document from Laptop"
          >
            <Paperclip className="w-4 h-4" />
          </button>
        )}

        {/* Text Input directly on main screen */}
        <input
          ref={inputRef}
          type="text"
          id="main-chat-input"
          placeholder={
            isLoading
              ? 'Krisha is thinking...'
              : isSpeaking
              ? 'Krisha is speaking...'
              : wakeWordEnabled
              ? 'Say "Krisha open PDF" or type here...'
              : 'Type "open pdf" or ask Krisha...'
          }
          value={inputText}
          onChange={handleInputChange}
          disabled={isLoading}
          autoComplete="off"
          className={`flex-1 bg-transparent px-2 sm:px-3 py-2 text-xs sm:text-sm focus:outline-none disabled:opacity-50 transition-colors ${
            isLightMode
              ? 'text-slate-800 placeholder-slate-400'
              : 'text-slate-100 placeholder-slate-500'
          }`}
        />

        {/* Action Buttons: Voice Mute Toggle & Send */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          {/* Quick Voice Audio Output Toggle */}
          <button
            type="button"
            onClick={onToggleVoice}
            id="btn-toggle-voice"
            className={`p-2.5 rounded-full transition-colors cursor-pointer ${
              isLightMode
                ? 'bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-blue-600'
                : 'bg-[#0b1020] hover:bg-[#101830] text-slate-400 hover:text-blue-300'
            }`}
            title={voiceEnabled ? 'Voice output is enabled' : 'Voice output is muted'}
          >
            {voiceEnabled ? (
              <Volume2 className="w-4 h-4 text-blue-500" />
            ) : (
              <VolumeX className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {/* Send Message Button */}
          <button
            type="submit"
            id="btn-send-message"
            disabled={!inputText.trim() || isLoading}
            className="p-2.5 sm:p-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 text-white rounded-full transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)] cursor-pointer flex-shrink-0"
            title="Send message"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
