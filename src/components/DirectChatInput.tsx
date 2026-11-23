import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Loader2,
  Sparkles,
  Radio,
  Paperclip,
  Globe,
  AudioLines,
  MapPin,
  Eye,
  Camera,
  X,
  Check,
} from 'lucide-react';
import { LanguagePreference } from '../types';
import { AudioRecordingSession, transcribeAudio } from '../utils/transcribeService';
import { getConversationInactivityTracker } from '../utils/conversationInactivity';
import { getConversationTurnManager } from '../utils/conversationTurnManager';
import { WindowsLogo } from './WindowsLogo';

interface DirectChatInputProps {
  onSendMessage: (text: string, useMapsGrounding?: boolean) => void;
  onTypingChange?: (text: string) => void;
  onOpenPdfOrFile?: () => void;
  onOpenTranscribeModal?: () => void;
  onOpenWindowsApps?: () => void;
  onReadScreen?: () => void;
  /** Step 6: explicit camera activation/stop control (toggle). */
  onToggleCamera?: () => void;
  cameraActive?: boolean;
  /** Action Transparency: live activity entries rendered directly above the input. */
  aboveInput?: React.ReactNode;
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
  languagePreference?: LanguagePreference;
  onChangeLanguage?: (lang: LanguagePreference) => void;
}

export const DirectChatInput: React.FC<DirectChatInputProps> = ({
  onSendMessage,
  onTypingChange,
  onOpenPdfOrFile,
  onOpenTranscribeModal,
  onOpenWindowsApps,
  onReadScreen,
  onToggleCamera,
  cameraActive = false,
  aboveInput,
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
  languagePreference = 'auto',
  onChangeLanguage,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordVolume, setRecordVolume] = useState(0);
  const [useMapsGrounding, setUseMapsGrounding] = useState(false);

  const sessionRef = useRef<AudioRecordingSession | null>(null);
  const timerRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.cancel();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  const handleStartRecording = async () => {
    // Step 5: pressing the mic while Krix speaks is a confirmed barge-in —
    // stop her playback FIRST so the recording never captures her own voice.
    getConversationTurnManager().requestBargeIn();
    try {
      const session = new AudioRecordingSession();
      session.onVolumeChange = (vol) => {
        setRecordVolume(vol);
      };
      // Step 3: detectable microphone failures are reported to the inactivity
      // tracker as failures — never as ordinary conversational silence.
      session.onMutedDetected = () => {
        getConversationInactivityTracker().reportMicIssue('microphone_permission_denied');
      };
      await session.start();
      sessionRef.current = session;
      setIsRecording(true);
      setRecordSeconds(0);

      timerRef.current = setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.warn('Microphone recording error:', err);
      // Step 3: map the getUserMedia failure to a content-free diagnostic kind.
      const name = String(err?.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        getConversationInactivityTracker().reportMicIssue('microphone_permission_denied');
      } else if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') {
        getConversationInactivityTracker().reportMicIssue('microphone_unavailable');
      }
      setIsRecording(false);
    }
  };

  const handleStopRecording = async (sendImmediately = true) => {
    if (!sessionRef.current || !isRecording) return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    try {
      setIsRecording(false);
      setIsTranscribing(true);
      const { base64, mimeType } = await sessionRef.current.stop();

      // Transcribe with gemini-3.5-transcribe
      const result = await transcribeAudio(base64, mimeType);
      setIsTranscribing(false);

      if (result.success && result.transcript) {
        const text = result.transcript.trim();
        setInputText(text);
        onTypingChange?.(text);

        if (sendImmediately && text) {
          // Step 3: a successfully transcribed + sent voice message is
          // meaningful activity (also proves the microphone path recovered).
          getConversationInactivityTracker().notifyActivity('transcribed_speech');
          onSendMessage(text, useMapsGrounding);
          setInputText('');
          onTypingChange?.('');
        }
      }
    } catch (err) {
      console.error('Failed to transcribe recording:', err);
      setIsRecording(false);
      setIsTranscribing(false);
    }
  };

  const handleCancelRecording = () => {
    if (sessionRef.current) {
      sessionRef.current.cancel();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setRecordSeconds(0);
    setRecordVolume(0);
  };

  const toggleRecording = () => {
    if (isRecording) {
      handleStopRecording(true);
    } else {
      handleStartRecording();
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
      onSendMessage(inputText.trim(), useMapsGrounding);
      setInputText('');
      onTypingChange?.('');
    }
  };

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-2xl px-4 sm:px-6 flex flex-col items-center">
      {/* Top Status Bar: Wake-word indicator & Quick feature pills */}
      <div className="mb-2 flex items-center gap-2 flex-wrap justify-center">
        {/* Wake-Word Status Pill / Indicator */}
        <AnimatePresence>
          {wakeWordEnabled && (
            <motion.button
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
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
            </motion.button>
          )}
        </AnimatePresence>

        {/* Google Maps Grounding Toggle Pill */}
        <button
          type="button"
          onClick={() => setUseMapsGrounding(!useMapsGrounding)}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer border backdrop-blur-md ${
            useMapsGrounding
              ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
              : isLightMode
              ? 'bg-slate-100/90 border-slate-300 text-slate-600 hover:text-emerald-700'
              : 'bg-blue-950/30 border-blue-900/40 text-slate-400 hover:text-emerald-300'
          }`}
          title="Toggle Google Maps Grounding (gemini-3.5-flash with googleMaps tool)"
        >
          <MapPin className={`w-3 h-3 ${useMapsGrounding ? 'text-emerald-400' : 'text-slate-400'}`} />
          <span>Maps Grounding: {useMapsGrounding ? 'ON' : 'Auto'}</span>
        </button>

        {/* Open Transcription Studio Pill */}
        {onOpenTranscribeModal && (
          <button
            type="button"
            onClick={onOpenTranscribeModal}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer border backdrop-blur-md ${
              isLightMode
                ? 'bg-slate-100/90 border-slate-300 text-slate-600 hover:text-blue-700'
                : 'bg-blue-950/30 border-blue-900/40 text-slate-400 hover:text-blue-300'
            }`}
            title="Open Audio Transcription Studio (Microphone & Audio Files with gemini-3.5-transcribe)"
          >
            <AudioLines className="w-3 h-3 text-blue-400" />
            <span>Transcribe Audio</span>
          </button>
        )}

        {/* Read Screen Vision Pill */}
        {onReadScreen && (
          <button
            type="button"
            onClick={onReadScreen}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer border backdrop-blur-md ${
              isLightMode
                ? 'bg-cyan-50/90 border-cyan-300 text-cyan-800 hover:text-cyan-950 hover:bg-cyan-100'
                : 'bg-cyan-950/40 border-cyan-500/30 text-cyan-300 hover:text-cyan-100 hover:bg-cyan-900/40 shadow-[0_0_12px_rgba(6,182,212,0.15)]'
            }`}
            title="Read and see your screen with Gemini Vision"
          >
            <Eye className="w-3 h-3 text-cyan-400" />
            <span>Read Screen</span>
          </button>
        )}

        {/* Step 6 — Camera Vision Pill: explicit camera activation control. */}
        {onToggleCamera && (
          <button
            type="button"
            onClick={onToggleCamera}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer border backdrop-blur-md ${
              cameraActive
                ? 'bg-rose-950/50 border-rose-500/50 text-rose-200 hover:bg-rose-900/50 shadow-[0_0_12px_rgba(244,63,94,0.25)]'
                : isLightMode
                ? 'bg-violet-50/90 border-violet-300 text-violet-800 hover:text-violet-950 hover:bg-violet-100'
                : 'bg-violet-950/40 border-violet-500/30 text-violet-300 hover:text-violet-100 hover:bg-violet-900/40 shadow-[0_0_12px_rgba(139,92,246,0.15)]'
            }`}
            title={cameraActive ? 'Stop the camera immediately' : 'Start camera vision (you will be asked for permission)'}
          >
            <Camera className="w-3 h-3 text-violet-400" />
            <span>{cameraActive ? 'Stop Camera' : 'Camera'}</span>
          </button>
        )}
      </div>

      {/* Real-time Microphone Recording Bar */}
      <AnimatePresence>
        {isRecording && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            className="w-full mb-2 p-2.5 px-4 rounded-2xl bg-gradient-to-r from-red-950/70 via-rose-950/60 to-red-950/70 border border-red-500/40 backdrop-blur-xl flex items-center justify-between shadow-lg shadow-red-950/40"
          >
            <div className="flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-red-200">
                  Recording microphone ({formatSec(recordSeconds)})
                </span>
                {/* Mini audio volume bars */}
                <div className="flex items-center gap-1 h-4">
                  {[0.4, 0.8, 1.0, 0.6, 0.9, 0.3].map((m, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-full bg-red-400 transition-all duration-75"
                      style={{ height: `${Math.max(4, Math.min(16, 4 + recordVolume * 14 * m))}px` }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancelRecording}
                className="p-1.5 px-2.5 rounded-xl text-xs text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/50 flex items-center gap-1 transition-colors"
                title="Cancel recording"
              >
                <X className="w-3 h-3" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                onClick={() => handleStopRecording(true)}
                className="p-1.5 px-3 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-500 shadow-sm flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Finish recording and transcribe with gemini-3.5-transcribe"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Transcribe & Send</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transcribing Indicator Bar */}
      <AnimatePresence>
        {isTranscribing && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="w-full mb-2 p-2 px-4 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 text-xs flex items-center justify-center gap-2 animate-pulse"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
            <span>Transcribing microphone audio with gemini-3.5-transcribe...</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Action Transparency: live activity stream, directly above the input */}
      {aboveInput}

      {/* Main Input Form */}
      <form
        onSubmit={handleSend}
        className={`w-full relative flex items-center rounded-2xl sm:rounded-full p-1.5 sm:p-2 backdrop-blur-md transition-all duration-500 ${
          wakeWordDetected
            ? 'border-emerald-500 shadow-[0_0_35px_rgba(16,185,129,0.4)]'
            : isLightMode
            ? 'bg-white/95 border border-slate-300/80 shadow-[0_10px_35px_rgba(0,0,0,0.08)] focus-within:border-blue-500 focus-within:shadow-[0_10px_35px_rgba(59,130,246,0.15)]'
            : 'bg-white/[0.045] border border-white/[0.08] hover:border-blue-400/30 focus-within:border-blue-400/45'
        }`}
      >
        {/* Microphone Button (Audio Transcription with gemini-3.5-transcribe) */}
        <button
          type="button"
          onClick={toggleRecording}
          id="btn-voice-input"
          className={`p-2.5 sm:p-3 rounded-full transition-all cursor-pointer flex-shrink-0 ${
            isRecording
              ? 'bg-rose-600 text-white shadow-[0_0_15px_rgba(225,29,72,0.5)] animate-pulse'
              : isLightMode
              ? 'bg-slate-100 text-slate-600 hover:text-blue-600 hover:bg-slate-200'
              : 'bg-[#0b1020] text-slate-400 hover:text-blue-300 hover:bg-[#101830]'
          }`}
          title={
            isRecording
              ? 'Recording microphone... Click to stop and transcribe'
              : 'Record audio with microphone (transcribed by gemini-3.5-transcribe)'
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

        {/* Windows Option Quick Button */}
        {onOpenWindowsApps && (
          <button
            type="button"
            onClick={onOpenWindowsApps}
            id="btn-windows-option"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all cursor-pointer flex-shrink-0 ${
              isLightMode
                ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
                : 'bg-blue-600/15 hover:bg-blue-600/25 text-blue-300 border border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
            title="⊞ Windows Option — Click to search and open any app on your laptop"
          >
            <WindowsLogo className="w-3.5 h-3.5" />
            <span className="hidden sm:inline font-medium text-[11px]">Windows</span>
          </button>
        )}

        {/* Quick Language Toggle Pill */}
        <button
          type="button"
          onClick={() => {
            const nextLang =
              languagePreference === 'auto' ? 'hi' : languagePreference === 'hi' ? 'en' : 'auto';
            onChangeLanguage?.(nextLang);
          }}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-medium transition-all cursor-pointer flex-shrink-0 ${
            languagePreference === 'hi'
              ? 'bg-amber-500/15 border border-amber-500/40 text-amber-300'
              : languagePreference === 'en'
              ? 'bg-blue-500/15 border border-blue-500/40 text-blue-300'
              : isLightMode
              ? 'bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200'
              : 'bg-[#0b1020] border border-blue-900/30 text-slate-300 hover:bg-[#101830] hover:text-blue-300'
          }`}
          title={`Language mode: ${
            languagePreference === 'hi'
              ? 'Hindi (हिन्दी / Hinglish)'
              : languagePreference === 'en'
              ? 'English'
              : 'Auto (English & Hindi)'
          } - Click to switch speech & reply language`}
        >
          <Globe className="w-3 h-3 flex-shrink-0" />
          <span className="font-mono text-[10px] tracking-wide uppercase">
            {languagePreference === 'hi' ? 'हिन्दी' : languagePreference === 'en' ? 'EN' : 'Auto'}
          </span>
        </button>

        {/* Text Input directly on main screen */}
        <input
          ref={inputRef}
          type="text"
          id="main-chat-input"
          placeholder={
            isLoading
              ? languagePreference === 'hi'
                ? 'कृषा सोच रही है...'
                : 'Krisha is thinking...'
              : isSpeaking
              ? languagePreference === 'hi'
                ? 'कृषा बोल रही है...'
                : 'Krisha is speaking...'
              : useMapsGrounding
              ? 'Ask anything with Google Maps Grounding...'
              : wakeWordEnabled
              ? languagePreference === 'hi'
                ? 'कहिए "Krisha" या यहाँ टाइप कीजिए...'
                : 'Say "Krisha" or type here...'
              : languagePreference === 'hi'
              ? 'यहाँ हिन्दी या English में लिखिए...'
              : 'Type in English, Hindi, or ask Krisha...'
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

