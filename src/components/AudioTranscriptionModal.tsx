import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Upload,
  Copy,
  Check,
  Download,
  Trash2,
  Sparkles,
  Play,
  Pause,
  Send,
  X,
  AudioLines,
  FileAudio,
  Radio,
  RefreshCw,
} from 'lucide-react';
import { AudioRecordingSession, transcribeAudio, blobToBase64 } from '../utils/transcribeService';
import { getConversationInactivityTracker } from '../utils/conversationInactivity';

interface AudioTranscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSendToChat?: (text: string) => void;
  isLightMode?: boolean;
}

interface TranscriptHistoryItem {
  id: string;
  timestamp: number;
  text: string;
  source: 'microphone' | 'file';
  fileName?: string;
  duration?: number;
  model?: string;
}

export const AudioTranscriptionModal: React.FC<AudioTranscriptionModalProps> = ({
  isOpen,
  onClose,
  onSendToChat,
  isLightMode = false,
}) => {
  const [activeTab, setActiveTab] = useState<'mic' | 'file'>('mic');

  // Microphone recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [recordVolume, setRecordVolume] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);

  // File upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileAudioUrl, setFileAudioUrl] = useState<string | null>(null);

  // Transcription state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [usedModel, setUsedModel] = useState<string>('gemini-3.5-transcribe');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Audio preview playback
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Session history
  const [history, setHistory] = useState<TranscriptHistoryItem[]>([]);

  const sessionRef = useRef<AudioRecordingSession | null>(null);
  const timerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.cancel();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
      if (fileAudioUrl) {
        URL.revokeObjectURL(fileAudioUrl);
      }
    };
  }, [recordedUrl, fileAudioUrl]);

  if (!isOpen) return null;

  const handleStartRecording = async () => {
    setErrorMessage(null);
    try {
      const session = new AudioRecordingSession();
      session.onVolumeChange = (vol) => {
        setRecordVolume(vol);
      };
      // Step 3: detectable microphone failures are reported to the inactivity
      // tracker as failures — never as ordinary conversational silence. (This
      // modal's transcripts are utility recordings, not conversational turns,
      // so success here deliberately does NOT reset the inactivity clock.)
      session.onMutedDetected = () => {
        getConversationInactivityTracker().reportMicIssue('microphone_permission_denied');
      };
      await session.start();
      sessionRef.current = session;
      setIsRecording(true);
      setRecordDuration(0);

      timerRef.current = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      const name = String(err?.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        getConversationInactivityTracker().reportMicIssue('microphone_permission_denied');
      } else if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') {
        getConversationInactivityTracker().reportMicIssue('microphone_unavailable');
      }
      setErrorMessage(err?.message || 'Could not access microphone.');
      setIsRecording(false);
    }
  };

  const handleStopRecording = async (shouldTranscribe = true) => {
    if (!sessionRef.current || !isRecording) return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    try {
      const { blob, base64, mimeType, durationSeconds } = await sessionRef.current.stop();
      setIsRecording(false);
      setRecordVolume(0);

      const url = URL.createObjectURL(blob);
      setRecordedBlob(blob);
      setRecordedUrl(url);

      if (shouldTranscribe) {
        await executeTranscription(base64, mimeType, 'microphone', undefined, durationSeconds);
      }
    } catch (err: any) {
      setIsRecording(false);
      setErrorMessage(err?.message || 'Failed to stop recording.');
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
    setRecordDuration(0);
    setRecordVolume(0);
  };

  const executeTranscription = async (
    base64Data: string,
    mimeType: string,
    source: 'microphone' | 'file',
    fileName?: string,
    duration?: number
  ) => {
    setIsTranscribing(true);
    setErrorMessage(null);

    const result = await transcribeAudio(base64Data, mimeType);

    setIsTranscribing(false);

    if (result.success && result.transcript) {
      setCurrentTranscript(result.transcript);
      setUsedModel(result.model || 'gemini-3.5-transcribe');

      const newItem: TranscriptHistoryItem = {
        id: 'trans_' + Date.now(),
        timestamp: Date.now(),
        text: result.transcript,
        source,
        fileName,
        duration,
        model: result.model,
      };
      setHistory((prev) => [newItem, ...prev.slice(0, 19)]);
    } else {
      setErrorMessage(result.error || 'No speech recognized. Please speak clearly and try again.');
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    if (fileAudioUrl) {
      URL.revokeObjectURL(fileAudioUrl);
    }
    const url = URL.createObjectURL(file);
    setFileAudioUrl(url);
    setErrorMessage(null);

    try {
      const base64 = await blobToBase64(file);
      await executeTranscription(base64, file.type || 'audio/mp3', 'file', file.name);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to read audio file.');
    }
  };

  const handleCopyTranscript = () => {
    if (!currentTranscript) return;
    navigator.clipboard.writeText(currentTranscript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendToKrisha = () => {
    if (!currentTranscript) return;
    onSendToChat?.(currentTranscript);
    onClose();
  };

  const handleDownloadTranscript = () => {
    if (!currentTranscript) return;
    const blob = new Blob([currentTranscript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `krisha-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        className={`w-full max-w-2xl max-h-[92vh] flex flex-col rounded-3xl shadow-2xl overflow-hidden border backdrop-blur-xl ${
          isLightMode
            ? 'bg-slate-50 border-slate-200 text-slate-800'
            : 'bg-[#080d1e]/95 border-blue-500/30 text-slate-100 shadow-[0_0_50px_rgba(30,58,138,0.25)]'
        }`}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-blue-900/30 flex items-center justify-between shrink-0 bg-blue-950/20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/20 border border-blue-400/40 flex items-center justify-center text-blue-400 shadow-sm shadow-blue-500/20">
              <AudioLines className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-wide text-white">
                  Audio Transcription
                </h2>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  <Sparkles className="w-2.5 h-2.5 mr-1 text-blue-400" />
                  gemini-3.5-transcribe
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Input audio with your microphone or upload audio files for AI transcription
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="flex border-b border-blue-900/20 px-6 pt-3 gap-2 shrink-0 bg-blue-950/10">
          <button
            onClick={() => setActiveTab('mic')}
            className={`pb-3 px-3 text-xs font-medium border-b-2 flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === 'mic'
                ? 'border-blue-400 text-blue-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            Microphone Input
          </button>
          <button
            onClick={() => setActiveTab('file')}
            className={`pb-3 px-3 text-xs font-medium border-b-2 flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === 'file'
                ? 'border-blue-400 text-blue-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            Upload Audio File
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Microphone Tab */}
          {activeTab === 'mic' && (
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-blue-950/20 border border-blue-500/20 space-y-5">
              {/* Recording Status / Waveform Animation */}
              <div className="flex flex-col items-center gap-3">
                <div className="relative flex items-center justify-center">
                  {isRecording && (
                    <span
                      className="absolute w-24 h-24 rounded-full bg-red-500/20 animate-ping pointer-events-none"
                      style={{
                        animationDuration: '1.4s',
                        transform: `scale(${1 + recordVolume * 0.8})`,
                      }}
                    />
                  )}
                  <button
                    onClick={isRecording ? () => handleStopRecording(true) : handleStartRecording}
                    disabled={isTranscribing}
                    className={`relative w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer ${
                      isRecording
                        ? 'bg-gradient-to-tr from-red-600 to-rose-500 text-white shadow-red-500/30 ring-4 ring-red-400/30 hover:scale-105'
                        : 'bg-gradient-to-tr from-blue-600 via-indigo-600 to-blue-500 text-white shadow-blue-500/30 hover:scale-105 active:scale-95'
                    }`}
                  >
                    {isRecording ? (
                      <MicOff className="w-8 h-8 animate-pulse" />
                    ) : (
                      <Mic className="w-8 h-8" />
                    )}
                  </button>
                </div>

                <div className="text-center">
                  <div className="text-sm font-semibold tracking-wide">
                    {isRecording ? (
                      <span className="text-red-400 flex items-center justify-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        Recording Microphone... {formatSeconds(recordDuration)}
                      </span>
                    ) : (
                      <span className="text-slate-300">Tap microphone to start recording</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    {isRecording
                      ? 'Speak naturally in English, Hindi, or any language. Tap again to finish and transcribe.'
                      : 'High-accuracy audio speech recognition powered by gemini-3.5-transcribe.'}
                  </p>
                </div>
              </div>

              {/* Volume Bars Waveform (Visualizer) */}
              {isRecording && (
                <div className="flex items-center gap-1.5 h-8">
                  {[0.4, 0.7, 1.0, 0.8, 0.5, 0.9, 0.6, 0.3, 0.7, 1.0, 0.5].map((multiplier, i) => {
                    const height = Math.max(6, Math.min(32, 6 + recordVolume * 28 * multiplier));
                    return (
                      <motion.div
                        key={i}
                        className="w-1.5 rounded-full bg-gradient-to-t from-red-500 to-rose-300"
                        style={{ height: `${height}px` }}
                        transition={{ duration: 0.1 }}
                      />
                    );
                  })}
                </div>
              )}

              {/* Controls while recording */}
              {isRecording && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleCancelRecording}
                    className="px-4 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleStopRecording(true)}
                    className="px-4 py-1.5 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 border border-blue-400/40 shadow-sm transition-colors flex items-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Transcribe Recording
                  </button>
                </div>
              )}
            </div>
          )}

          {/* File Upload Tab */}
          {activeTab === 'file' && (
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-blue-950/20 border border-blue-500/20 space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.webm,.aac"
                onChange={handleFileSelect}
                className="hidden"
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-blue-500/30 hover:border-blue-400/60 rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-blue-950/10 hover:bg-blue-950/30"
              >
                <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-400/30 flex items-center justify-center text-blue-400 mb-3">
                  <FileAudio className="w-7 h-7" />
                </div>
                <div className="text-sm font-semibold text-white mb-1">
                  Click to select audio file or drag & drop
                </div>
                <p className="text-xs text-slate-400">
                  Supports MP3, WAV, WebM, M4A, OGG (up to 25MB)
                </p>
                {selectedFile && (
                  <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-xl bg-blue-900/40 text-blue-200 text-xs font-mono border border-blue-500/30">
                    <FileAudio className="w-3.5 h-3.5 text-blue-400" />
                    {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Transcribing Indicator */}
          {isTranscribing && (
            <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center gap-3 animate-pulse">
              <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" />
              <div>
                <div className="text-xs font-semibold text-blue-300">
                  Transcribing with {usedModel}...
                </div>
                <div className="text-[11px] text-slate-400">
                  Analyzing speech acoustic patterns and verbatim words
                </div>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <div className="p-3.5 rounded-2xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center justify-between">
              <span>{errorMessage}</span>
              <button
                onClick={() => setErrorMessage(null)}
                className="text-red-400 hover:text-red-200 ml-2"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Current Transcribed Result */}
          {currentTranscript && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    Transcribed Text
                  </span>
                  <span className="text-[10px] text-slate-400">
                    ({currentTranscript.length} chars, {currentTranscript.split(/\s+/).filter(Boolean).length} words)
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyTranscript}
                    className="p-1.5 px-2.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 flex items-center gap-1 transition-colors"
                    title="Copy transcript to clipboard"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>

                  <button
                    onClick={handleDownloadTranscript}
                    className="p-1.5 px-2.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 flex items-center gap-1 transition-colors"
                    title="Download as text file"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Save .txt</span>
                  </button>
                </div>
              </div>

              <div className="relative rounded-2xl p-4 bg-slate-900/60 border border-blue-500/20 text-slate-100 text-sm leading-relaxed whitespace-pre-wrap select-text">
                {currentTranscript}
              </div>

              {/* Action buttons */}
              {onSendToChat && (
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={handleSendToKrisha}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/20 flex items-center gap-2 transition-all cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send to Krisha</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* History of Transcriptions */}
          {history.length > 1 && (
            <div className="pt-4 border-t border-blue-900/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">
                  Session History ({history.length})
                </span>
                <button
                  onClick={() => setHistory([])}
                  className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear history
                </button>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {history.slice(1).map((item) => (
                  <div
                    key={item.id}
                    onClick={() => setCurrentTranscript(item.text)}
                    className="p-3 rounded-xl bg-blue-950/20 hover:bg-blue-900/30 border border-blue-500/10 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                      <span className="flex items-center gap-1">
                        {item.source === 'microphone' ? <Mic className="w-3 h-3 text-blue-400" /> : <FileAudio className="w-3 h-3 text-cyan-400" />}
                        {item.source === 'microphone' ? 'Microphone' : item.fileName || 'File'}
                      </span>
                      <span>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-xs text-slate-200 line-clamp-2">
                      {item.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};
