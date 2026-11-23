// Audio Recording and Gemini Transcription Service

import { MUTE_ZERO_LEVEL_FRAMES } from './conversationInactivity';

export interface TranscriptionResult {
  transcript: string;
  model?: string;
  durationSeconds?: number;
  success: boolean;
  error?: string;
}

export class AudioRecordingSession {
  private mediaRecorder: MediaRecorder | null = null;
  private audioStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private startTime: number = 0;
  private mimeType: string = 'audio/webm';
  private zeroLevelFrames = 0;
  private mutedReported = false;

  public isRecording: boolean = false;
  public onVolumeChange?: (volume: number) => void;
  /**
   * Step 3 — conversational silence detection: detectable microphone mute.
   * Fires when the capture track reports muted at start or stays at zero
   * level for ~2.5 s (reuses the existing metering loop — no new timers).
   * Content-free: carries a reason code only, never audio.
   */
  public onMutedDetected?: (reason: 'muted_at_start' | 'zero_level') => void;

  async start(): Promise<void> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser.');
    }

    // Stop previous if any
    this.stopSessionCleanup();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioStream = stream;
    this.audioChunks = [];
    this.startTime = Date.now();
    this.zeroLevelFrames = 0;
    this.mutedReported = false;

    // Detectable mute at start (Windows privacy switch / hardware mute).
    const firstTrack = stream.getAudioTracks()[0];
    if (firstTrack && firstTrack.muted) {
      this.onMutedDetected?.('muted_at_start');
    }

    // Determine supported mimeType
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav',
    ];
    let selectedMimeType = '';
    for (const mt of mimeTypes) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) {
        selectedMimeType = mt;
        break;
      }
    }
    this.mimeType = selectedMimeType || 'audio/webm';

    const recorder = new MediaRecorder(stream, selectedMimeType ? { mimeType: selectedMimeType } : undefined);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.audioChunks.push(e.data);
      }
    };

    recorder.start(100);
    this.mediaRecorder = recorder;
    this.isRecording = true;

    // Setup volume meter using AudioContext
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);

        this.audioContext = ctx;
        this.analyser = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkVolume = () => {
          if (!this.isRecording) return;
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          const normalized = Math.min(1, avg / 128);
          this.onVolumeChange?.(normalized);
          // Step 3: sustained zero level while recording ⇒ detectable mute
          // (once per session; reuses this existing loop — no new timers).
          if (normalized <= 0.001) {
            this.zeroLevelFrames += 1;
            if (!this.mutedReported && this.zeroLevelFrames >= MUTE_ZERO_LEVEL_FRAMES) {
              this.mutedReported = true;
              this.onMutedDetected?.('zero_level');
            }
          } else {
            this.zeroLevelFrames = 0;
          }
          this.animFrameId = requestAnimationFrame(checkVolume);
        };
        checkVolume();
      }
    } catch {
      // AudioContext meter is optional
    }
  }

  async stop(): Promise<{ blob: Blob; mimeType: string; durationSeconds: number; base64: string }> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        this.stopSessionCleanup();
        return reject(new Error('No active recording session'));
      }

      const recorder = this.mediaRecorder;
      const durationSeconds = Math.max(0.5, (Date.now() - this.startTime) / 1000);

      recorder.onstop = async () => {
        try {
          const blobType = this.mimeType.split(';')[0] || 'audio/webm';
          const audioBlob = new Blob(this.audioChunks, { type: blobType });
          const base64 = await blobToBase64(audioBlob);

          this.stopSessionCleanup();
          resolve({
            blob: audioBlob,
            mimeType: blobType,
            durationSeconds,
            base64,
          });
        } catch (err) {
          this.stopSessionCleanup();
          reject(err);
        }
      };

      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch (err) {
        this.stopSessionCleanup();
        reject(err);
      }
    });
  }

  cancel(): void {
    this.stopSessionCleanup();
  }

  private stopSessionCleanup(): void {
    this.isRecording = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {}
    }
    this.mediaRecorder = null;

    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => track.stop());
      this.audioStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {}
    }
    this.audioContext = null;
    this.analyser = null;
    this.audioChunks = [];
  }
}

/**
 * Convert Blob to raw base64 string
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip data:audio/xyz;base64,
      const base64 = result.replace(/^data:[^;]+;base64,/, '');
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Transcribe base64 audio via Gemini server endpoint
 */
export async function transcribeAudio(
  base64Audio: string,
  mimeType: string = 'audio/webm',
  prompt?: string
): Promise<TranscriptionResult> {
  try {
    const res = await fetch('/api/audio/transcribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audioData: base64Audio,
        mimeType,
        prompt,
      }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `Server responded with status ${res.status}`);
    }

    const data = await res.json();
    return {
      transcript: data.transcript || '',
      model: data.model || 'gemini-3.5-transcribe',
      success: true,
    };
  } catch (err: any) {
    console.error('Transcription API error:', err);
    return {
      transcript: '',
      success: false,
      error: err?.message || 'Failed to transcribe audio',
    };
  }
}
