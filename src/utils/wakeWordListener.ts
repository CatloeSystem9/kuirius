/**
 * High-performance, battery-friendly Wake-Word detection engine for "Krisha"
 * Optimized to use minimal CPU and RAM:
 * - Single-instance listener with strict debounce locking to prevent duplicate commands ("too many orders")
 * - Automatic pause when tab is in background / hidden
 * - Instant teardown on stop
 */

export interface WakeWordResult {
  fullTranscript: string;
  command: string | null;
  wakeWordMatched: string;
}

export type WakeWordStatus = 'listening' | 'idle' | 'detected' | 'paused_speaking' | 'paused_hidden' | 'error' | 'unsupported';

const WAKE_WORD_PATTERNS = [
  /\b(?:hey|hi|hello|ok|okay|wake\s+up|yo)?\s*krisha\b/i,
  /\bkrisha\s*(?:wake\s+up|listen|are\s+you\s+there|suno|kya\s+kar\s+rahi\s+ho)?\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*kreesha\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*kreisha\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*krishna\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*trisha\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*crisha\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*karisha\b/i,
  /\b(?:hey|hi|hello|ok|okay)?\s*grisha\b/i,
  // Hindi script & phonetics:
  /(?:नमस्ते|सुनो|हे|अरे)?\s*कृषा/i,
  /कृषा\s*(?:सुनो|नमस्ते|कैसी\s+हो)?/i,
  /\b(?:suno|namaste|arey|are|sun)\s+krisha\b/i,
];

export class WakeWordManager {
  private recognition: any = null;
  private currentLanguage: string = 'en-IN';
  private isListeningDesired: boolean = false;
  private isKrishaSpeaking: boolean = false;
  private isTabHidden: boolean = false;
  private status: WakeWordStatus = 'idle';
  private restartTimeout: any = null;
  private lastTriggerTime: number = 0;
  private isProcessing: boolean = false;

  private onWakeWordCallback: ((result: WakeWordResult) => void) | null = null;
  private onStatusChangeCallback: ((status: WakeWordStatus) => void) | null = null;
  private onTranscriptUpdateCallback: ((transcript: string) => void) | null = null;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  public isSupported(): boolean {
    return typeof window !== 'undefined' && Boolean(
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    );
  }

  private handleVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    this.isTabHidden = document.hidden;
    if (this.isTabHidden) {
      this.pauseRecognition();
      this.setStatus('paused_hidden');
    } else if (this.isListeningDesired && !this.isKrishaSpeaking) {
      this.scheduleRestart(300);
    }
  };

  private initRecognition() {
    if (!this.isSupported()) {
      this.setStatus('unsupported');
      return;
    }

    try {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = this.currentLanguage || 'en-IN';
      rec.maxAlternatives = 1; // Lower alternatives to save RAM and CPU

      rec.onstart = () => {
        if (!this.isKrishaSpeaking && !this.isTabHidden) {
          this.setStatus('listening');
        }
      };

      rec.onresult = (event: any) => {
        if (this.isKrishaSpeaking || this.isTabHidden || this.isProcessing) return;

        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const trans = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += trans + ' ';
          } else {
            interimTranscript += trans;
          }
        }

        const candidateText = (finalTranscript || interimTranscript).trim();
        if (candidateText) {
          this.onTranscriptUpdateCallback?.(candidateText);
          this.checkAndProcessWakeWord(candidateText);
        }
      };

      rec.onerror = (e: any) => {
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.debug('Recognition notice:', e.error);
        }
      };

      rec.onend = () => {
        if (this.isListeningDesired && !this.isKrishaSpeaking && !this.isTabHidden) {
          this.scheduleRestart(500); // 500ms debounce prevents CPU spin
        } else if (this.isKrishaSpeaking) {
          this.setStatus('paused_speaking');
        } else if (this.isTabHidden) {
          this.setStatus('paused_hidden');
        } else {
          this.setStatus('idle');
        }
      };

      this.recognition = rec;
    } catch (err) {
      console.error('Failed to initialize speech recognition:', err);
      this.setStatus('error');
    }
  }

  private checkAndProcessWakeWord(transcript: string) {
    const now = Date.now();
    // Strict 3.0-second cooldown lock to prevent spam / duplicate orders
    if (this.isProcessing || now - this.lastTriggerTime < 3000) {
      return;
    }

    const clean = transcript.toLowerCase();

    for (const pattern_regex of WAKE_WORD_PATTERNS) {
      const match = clean.match(pattern_regex);
      if (match) {
        this.isProcessing = true;
        this.lastTriggerTime = now;

        const matchedStr = match[0];
        const matchIndex = match.index || 0;
        const afterWakeWord = transcript.slice(matchIndex + matchedStr.length).trim();

        // Clean leading punctuation and helper words
        const cleanedCommand = afterWakeWord
          .replace(/^[,.:;!?-]+/, '')
          .replace(/^(?:please|can you|could you|would you)\s+/i, '')
          .trim();

        this.setStatus('detected');

        // Stop recognition immediately while processing command
        this.pauseRecognition();

        this.onWakeWordCallback?.({
          fullTranscript: transcript,
          command: cleanedCommand && cleanedCommand.length > 1 ? cleanedCommand : null,
          wakeWordMatched: matchedStr,
        });

        // Release processing lock after brief cooldown
        setTimeout(() => {
          this.isProcessing = false;
        }, 2000);

        return;
      }
    }
  }

  private setStatus(newStatus: WakeWordStatus) {
    this.status = newStatus;
    this.onStatusChangeCallback?.(newStatus);
  }

  private scheduleRestart(delayMs: number = 500) {
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
    this.restartTimeout = setTimeout(() => {
      if (this.isListeningDesired && !this.isKrishaSpeaking && !this.isTabHidden && this.recognition) {
        try {
          this.recognition.start();
        } catch {
          // Already running
        }
      }
    }, delayMs);
  }

  private pauseRecognition() {
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {}
    }
  }

  public startListening(
    onWake: (res: WakeWordResult) => void,
    onStatusChange?: (status: WakeWordStatus) => void,
    onTranscript?: (transcript: string) => void,
    languagePreference?: string
  ) {
    this.isListeningDesired = true;
    this.onWakeWordCallback = onWake;
    this.onStatusChangeCallback = onStatusChange || null;
    this.onTranscriptUpdateCallback = onTranscript || null;

    const newLang =
      languagePreference === 'hi' ? 'hi-IN' : languagePreference === 'en' ? 'en-US' : 'en-IN';
    if (this.currentLanguage !== newLang && this.recognition) {
      this.currentLanguage = newLang;
      this.recognition.lang = newLang;
    } else {
      this.currentLanguage = newLang;
    }

    if (!this.recognition) {
      this.initRecognition();
    }

    if (this.recognition && !this.isKrishaSpeaking && !this.isTabHidden) {
      try {
        this.recognition.start();
        this.setStatus('listening');
      } catch {
        // already active
      }
    }
  }

  public stopListening() {
    this.isListeningDesired = false;
    this.pauseRecognition();
    this.setStatus('idle');
  }

  public setKrishaSpeaking(isSpeaking: boolean) {
    this.isKrishaSpeaking = isSpeaking;
    if (isSpeaking) {
      this.setStatus('paused_speaking');
      this.pauseRecognition();
    } else {
      if (this.isListeningDesired && !this.isTabHidden) {
        this.scheduleRestart(600);
      }
    }
  }

  public getStatus(): WakeWordStatus {
    return this.status;
  }
}

// Global singleton instance
export const wakeWordManager = new WakeWordManager();
