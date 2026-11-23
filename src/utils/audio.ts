// Audio handling utility with TTS & Web Speech fallback + Lip Sync triggers

// ── Krix 3D lip-sync integration ──────────────────────────────────────────────
// The KrixAvatar3D module registers a callback that receives real audio volume
// samples. We import the bridge functions directly – the module tree-shakes
// cleanly and has no side effects at import time.
import {
  startKrixAudioAnalysis as _startKrixAudio,
  stopKrixAudioAnalysis as _stopKrixAudio,
  pushKrixLipSyncVolume as _pushKrixVolume,
} from '../components/KrixAvatar3D';

function getKrixBridge() {
  return {
    startKrixAudioAnalysis: _startKrixAudio,
    stopKrixAudioAnalysis: _stopKrixAudio,
    pushKrixLipSyncVolume: _pushKrixVolume,
  };
}

let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let serverTtsCooldownUntil = 0;

// ── Background voice output (Step 2) — playback session discipline ───────────
// A monotonically increasing session id makes every async continuation and
// every media event session-checked: a stale Gemini-TTS fetch resolving after
// a newer request (or after stopKrishaSpeech) can never start playback, so
// duplicate/overlapping speech is structurally impossible — not just
// best-effort cancelled. No new engine, no new dependency; the same Gemini
// TTS audio and the same Web Speech voices/characteristics are used.
let playbackSession = 0;
/** Device-disconnect recovery: set while an unexpected pause is pending recovery. */
let unexpectedPausePending = false;
/** Session id whose one allowed recovery attempt has been used. */
let recoveryAttemptedForSession = -1;
let deviceChangeListenerInstalled = false;
/** One-time user-gesture audio unlock (autoplay policy) — hidden tabs may
 *  only play audio once the origin has interacted. Set on first gesture. */
let audioUnlocked = false;
let unlockInstalled = false;
let unlockContext: AudioContext | null = null;

/** Test hook: replace the HTMLAudioElement constructor (unit tests only). */
let audioElementFactory: (src: string) => HTMLAudioElement = (src) => new Audio(src);
export function setAudioElementFactoryForTests(factory: (src: string) => HTMLAudioElement): void {
  audioElementFactory = factory;
}

function isCurrentSession(session: number): boolean {
  return session === playbackSession;
}

// ── Conversational silence detection (Step 3) — voice-output activity signal ─
// Krix actually starting to speak IS meaningful conversational activity: the
// inactivity tracker subscribes here so replies reset the silence clock. The
// signal carries no content — just "playback started" — session-checked so
// superseded/recovered sessions cannot fake activity.
let voiceOutputActivityListener: ((started: boolean) => void) | null = null;
export function setVoiceOutputActivityListener(fn: ((started: boolean) => void) | null): void {
  voiceOutputActivityListener = fn;
}
function notifyVoiceOutputActivity(started: boolean): void {
  try {
    voiceOutputActivityListener?.(started);
  } catch {}
}

/**
 * One-time muted AudioContext start on the first user gesture. This satisfies
 * the browser autoplay policy so a LATER hidden/minimized playback attempt is
 * allowed — it costs one silent buffer at install time and nothing afterwards.
 * It never touches OS audio privacy settings and never keeps a device open
 * (the context is closed immediately).
 */
function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        const ctx: AudioContext = new AudioContextClass();
        unlockContext = ctx;
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        setTimeout(() => {
          try {
            void ctx.close();
          } catch {}
          if (unlockContext === ctx) unlockContext = null;
        }, 300);
      }
    } catch {
      // unlock is best-effort; the visible-flow gesture already permits audio
    }
    try {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    } catch {}
  };
  try {
    window.addEventListener('pointerdown', unlock, { once: false, passive: true });
    window.addEventListener('keydown', unlock, { once: false, passive: true });
  } catch {
    // exotic environments without DOM event wiring — unlock degrades gracefully
  }
}

/**
 * Device-change handling (audio output disconnect/reconnect). Installed once,
 * passive: on devicechange, if the current session's audio paused
 * unexpectedly (e.g. the output device vanished), attempt ONE bounded resume —
 * Windows routes audio to the remaining device when one reconnects, and the
 * element can usually resume. Never retries in a loop, never re-speaks
 * finished sessions.
 */
function installDeviceChangeRecovery(): void {
  if (deviceChangeListenerInstalled || typeof navigator === 'undefined') return;
  const mediaDevices = (navigator as Navigator & { mediaDevices?: EventTarget }).mediaDevices;
  if (!mediaDevices) return;
  deviceChangeListenerInstalled = true;
  try {
    mediaDevices.addEventListener('devicechange', () => {
      const session = playbackSession;
      const audio = currentAudio;
      if (!audio || !isCurrentSession(session)) return;
      // If the element is stuck paused because its device disappeared, try once.
      if (audio.paused && !audio.ended) {
        try {
          void audio.play().catch(() => undefined);
        } catch {}
      }
    });
  } catch {
    // environments without devicechange support — recovery via onpause remains
  }
}

/**
 * Bounded recovery of an unexpected pause (device disconnect while speaking,
 * OS audio-route change). Exactly ONE resume attempt PER SESSION, 1 s after
 * the pause so Windows has settled the new default device. The budget is
 * session-wide (not per-pause): if the device stays missing, repeated OS
 * pause events must not retry forever — the session ends honestly instead.
 * Does not re-synthesize speech — the same decoded audio element resumes,
 * voice identity unchanged.
 */
function scheduleUnexpectedPauseRecovery(audio: HTMLAudioElement, session: number): void {
  if (unexpectedPausePending || recoveryAttemptedForSession === session || !isCurrentSession(session)) return;
  recoveryAttemptedForSession = session;
  unexpectedPausePending = true;
  setTimeout(() => {
    unexpectedPausePending = false;
    if (!isCurrentSession(session) || audio.ended) return;
    if (audio.paused) {
      try {
        void audio.play().catch(() => undefined);
      } catch {}
    }
  }, 1000);
}

// Preload browser voices
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    try {
      window.speechSynthesis.getVoices();
    } catch {}
  };
}

/**
 * Detect language of text, recognizing Devanagari script, Hindi/Hinglish vocabulary, and English.
 */
export function detectSpeechLanguage(text: string): { lang: string; isHindi: boolean } {
  if (!text) return { lang: 'en-US', isHindi: false };

  // 1. Devanagari script check (e.g. हिन्दी, नमस्ते, कैसे हो)
  if (/[\u0900-\u097F]/.test(text)) {
    return { lang: 'hi-IN', isHindi: true };
  }

  // 2. Hindi / Hinglish common words
  const hindiWordsRegex =
    /\b(namaste|kaise|kaisi|kaisa|kya|kyun|kyu|haan|nahi|nahin|shukriya|aap|tum|hum|mujhe|mera|meri|mere|yaar|batao|bolo|karo|karna|rahi|rahe|raha|theek|accha|achha|acche|bhai|sunao|kuch|pyar|pyaar|prem|dost|madad|khana|ghar|kaam|chal|suno|kripya|bahut|zaroor|dil|baat|baatein|lag|karein|kare|chalo|khush|dhanyawad|alvida)\b/i;

  const matches = text.match(new RegExp(hindiWordsRegex, 'gi'));
  if (matches && matches.length >= 2) {
    return { lang: 'hi-IN', isHindi: true };
  }
  if (matches && matches.length === 1 && text.split(/\s+/).length <= 5) {
    return { lang: 'hi-IN', isHindi: true };
  }

  // 3. Other script checks (e.g. Japanese, Cyrillic)
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text)) {
    return { lang: 'ja-JP', isHindi: false };
  }

  return { lang: 'en-US', isHindi: false };
}

/**
 * Clean text for Text-to-Speech: strips emotion tags, stage directions,
 * laughter words/giggles, and markdown to prevent odd laughing sounds.
 */
export function cleanSpeechText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[(?:emotion|expression):[^\]]+\]/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\*[^*]+\*/g, '')
    .replace(/\([^)]+\)/g, '')
    .replace(/\b(ehehe+|hihi+|hehe+|haha+|hahaha+|ahahaha+|giggle[s]?|chuckle[s]?|gasp|sigh|lol|rofl|pffft+)\b/gi, '')
    .replace(/[*_~`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function speakKrishaText(
  text: string,
  voiceName: string = 'Aoede',
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void,
  preferredLanguage?: string,
  pitch: number = 1.0,
  voiceEngine: 'auto' | 'gemini' | 'browser' = 'auto'
): Promise<void> {
  // Stop previous speech AND open a fresh session: every async continuation
  // below checks isCurrentSession(session) so a superseded request can never
  // start playback (overlap prevention is structural).
  stopKrishaSpeech();
  const session = ++playbackSession;
  recoveryAttemptedForSession = -1; // fresh recovery budget per session

  installAudioUnlock();
  installDeviceChangeRecovery();

  const cleaned = cleanSpeechText(text);
  if (!cleaned) {
    onEnd?.();
    return;
  }

  const detected = detectSpeechLanguage(cleaned);
  const targetLang =
    preferredLanguage && preferredLanguage !== 'auto'
      ? preferredLanguage === 'hi'
        ? 'hi-IN'
        : 'en-US'
      : detected.lang;

  // If user explicitly configured browser engine or server is cooling down, skip cloud call directly
  if (voiceEngine === 'browser' || Date.now() < serverTtsCooldownUntil) {
    if (isCurrentSession(session)) {
      playWebSpeechFallback(cleaned, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch, voiceName, session);
    }
    return;
  }

  // Try Server Gemini TTS first with selected voice model (Aoede, Zephyr, Leda, Kore, Puck, Fenrir)
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleaned, voice: voiceName, lang: targetLang }),
    });

    // A newer request (or stop) superseded this one while we were fetching.
    if (!isCurrentSession(session)) return;

    if (res.ok) {
      const data = await res.json();
      if (data.fallback) {
        if (data.cooldownMs) {
          serverTtsCooldownUntil = Date.now() + data.cooldownMs;
        }
      } else if (data.audio) {
        // Play base64 audio (handles standard audio/wav returned by Gemini TTS)
        const mimeType = data.mimeType || 'audio/wav';
        const audioSrc = `data:${mimeType};base64,${data.audio}`;
        const audio = audioElementFactory(audioSrc);
        audio.playbackRate = speed;
        currentAudio = audio;
        unexpectedPausePending = false;

        let mouthInterval: any = null;
        // Stuck-session watchdog: if playback neither starts nor fails within
        // 12 s (suspended element, wedged decoder), clean up and hand the
        // session to the Web Speech path exactly once. No polling loops.
        const stuckTimer = setTimeout(() => {
          if (!isCurrentSession(session)) return;
          if (audio.paused && !audio.ended) {
            if (mouthInterval) clearInterval(mouthInterval);
            try {
              audio.pause();
            } catch {}
            if (currentAudio === audio) currentAudio = null;
            getKrixBridge()?.stopKrixAudioAnalysis();
            if (isCurrentSession(session)) {
              playWebSpeechFallback(cleaned, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch, voiceName, session);
            }
          }
        }, 12_000);
        if (typeof stuckTimer === 'object' && 'unref' in stuckTimer) (stuckTimer as any).unref?.();

        const teardownLipSync = () => {
          if (mouthInterval) clearInterval(mouthInterval);
          onSpeakingChunk?.(false);
          getKrixBridge()?.stopKrixAudioAnalysis();
        };

        audio.onplay = () => {
          if (!isCurrentSession(session)) return;
          onStart?.();
          notifyVoiceOutputActivity(true);
          // Connect to Krix 3D lip-sync analyser (real audio frequency analysis)
          const bridge = getKrixBridge();
          bridge?.startKrixAudioAnalysis(audio);
          // Simulate rhythmic mouth lip sync (2D avatar fallback)
          let open = false;
          mouthInterval = setInterval(() => {
            if (!isCurrentSession(session)) {
              clearInterval(mouthInterval);
              return;
            }
            open = !open;
            onSpeakingChunk?.(open);
          }, 140);
        };

        audio.onended = () => {
          if (!isCurrentSession(session)) return;
          clearTimeout(stuckTimer);
          teardownLipSync();
          notifyVoiceOutputActivity(false); // Step 5: playback end signal
          onEnd?.();
          currentAudio = null;
        };

        audio.onpause = () => {
          if (!isCurrentSession(session) || audio.ended) return;
          // Unexpected pause (audio device vanished / route change) — bounded
          // single recovery; the watchdog still bounds a failed resume.
          scheduleUnexpectedPauseRecovery(audio, session);
        };

        audio.onerror = () => {
          if (!isCurrentSession(session)) return;
          clearTimeout(stuckTimer);
          teardownLipSync();
          if (currentAudio === audio) currentAudio = null;
          playWebSpeechFallback(cleaned, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch, voiceName, session);
        };

        // Bound the await: a wedged play() (autoplay-policy suspension,
        // wedged decoder) must not keep this session promise unsettled
        // forever — the stuck watchdog owns the recovery path. Late
        // rejections are absorbed (the onerror handler already ran or the
        // session was superseded).
        const playPromise = audio.play();
        playPromise.catch(() => undefined);
        await Promise.race([
          playPromise,
          new Promise<void>((resolve) => {
            const raceTimer = setTimeout(() => resolve(), 12_500);
            if (typeof raceTimer === 'object' && 'unref' in raceTimer) (raceTimer as any).unref?.();
          }),
        ]);
        // Autoplay policy: a rejected play() in a never-interacted hidden tab
        // surfaces here or via onerror — either way the session ends at the
        // Web Speech fallback, never in a stuck state.
        return;
      }
    }
  } catch {}

  // Seamless fallback to browser Web Speech API matching chosen voice profile
  if (isCurrentSession(session)) {
    playWebSpeechFallback(cleaned, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch, voiceName, session);
  }
}

function playWebSpeechFallback(
  text: string,
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void,
  targetLang?: string,
  pitch: number = 1.0,
  voiceName: string = 'Aoede',
  session: number = playbackSession
) {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onEnd?.();
    return;
  }

  window.speechSynthesis.cancel();

  const clean = cleanSpeechText(text);
  if (!clean) {
    onEnd?.();
    return;
  }

  const detected = detectSpeechLanguage(clean);
  const langToUse = targetLang || detected.lang;

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = langToUse;

  // Voice personality profile tuning without squeaky distortion
  let effectivePitch = pitch;
  let effectiveRate = speed;

  if (voiceName === 'Aoede') {
    // Bright, melodic feminine tone
    effectivePitch = pitch * 1.05;
    effectiveRate = speed * 1.0;
  } else if (voiceName === 'Zephyr') {
    // Soft, gentle, peaceful cadence
    effectivePitch = pitch * 0.98;
    effectiveRate = speed * 0.94;
  } else if (voiceName === 'Leda') {
    // Delicate, graceful, warm
    effectivePitch = pitch * 1.0;
    effectiveRate = speed * 0.98;
  } else if (voiceName === 'Kore') {
    // Calm, soothing, rich warmth
    effectivePitch = pitch * 0.96;
    effectiveRate = speed * 0.95;
  } else if (voiceName === 'Puck') {
    // Cheerful, upbeat, playful
    effectivePitch = pitch * 1.08;
    effectiveRate = speed * 1.04;
  } else if (voiceName === 'Fenrir') {
    // Deeper, calm, resonant tone
    effectivePitch = pitch * 0.88;
    effectiveRate = speed * 0.95;
  }

  utterance.rate = Math.max(0.75, Math.min(1.3, effectiveRate));
  utterance.pitch = Math.max(0.8, Math.min(1.25, effectivePitch));

  // Voice selection according to language and requested voice personality
  const voices = window.speechSynthesis.getVoices();

  if (langToUse.startsWith('hi') || detected.isHindi) {
    // 1. Prioritize sweet native Hindi female voices (Swara, Kalpana, Lekha, Google हिन्दी)
    const hindiVoice =
      voices.find(
        (v) =>
          (v.lang.toLowerCase().startsWith('hi') ||
            v.name.toLowerCase().includes('hindi') ||
            v.name.includes('हिन्दी')) &&
          (v.name.toLowerCase().includes('swara') ||
            v.name.toLowerCase().includes('kalpana') ||
            v.name.toLowerCase().includes('lekha') ||
            v.name.toLowerCase().includes('female') ||
            v.name.toLowerCase().includes('natural'))
      ) ||
      voices.find(
        (v) =>
          v.lang.toLowerCase().startsWith('hi') ||
          v.name.toLowerCase().includes('hindi') ||
          v.name.includes('हिन्दी')
      );

    // 2. Fallback to sweet Indian English voices (Neerja, Heera)
    const indianVoice =
      voices.find(
        (v) =>
          (v.lang.toLowerCase().includes('en-in') ||
            v.name.toLowerCase().includes('india')) &&
          (v.name.toLowerCase().includes('neerja') ||
            v.name.toLowerCase().includes('heera') ||
            v.name.toLowerCase().includes('female') ||
            v.name.toLowerCase().includes('natural'))
      ) ||
      voices.find(
        (v) =>
          v.lang.toLowerCase().includes('en-in') ||
          v.lang.toLowerCase().includes('in')
      );

    if (hindiVoice) {
      utterance.voice = hindiVoice;
    } else if (indianVoice) {
      utterance.voice = indianVoice;
    }
  } else {
    // English: choose based on voice model characteristics
    const langPrefix = langToUse.slice(0, 2).toLowerCase();
    
    if (voiceName === 'Fenrir') {
      // Deeper resonant voice
      const deepVoice = voices.find((v) => {
        const n = v.name.toLowerCase();
        return (
          v.lang.toLowerCase().startsWith(langPrefix) &&
          (n.includes('guy') || n.includes('david') || n.includes('george') || n.includes('male') || n.includes('deep'))
        );
      });
      if (deepVoice) utterance.voice = deepVoice;
    } else {
      // Feminine & expressive models: Aoede, Zephyr, Leda, Kore, Puck
      const sweetVoiceNames = [
        'jenny', // Microsoft Jenny (Natural)
        'aria', // Microsoft Aria (Natural)
        'samantha', // Apple Samantha
        'victoria', // Apple Victoria
        'karen', // Apple Karen
        'serena', // UK Serena
        'sonia', // Microsoft Sonia
        'zira', // Microsoft Zira
        'google us english',
        'google uk english female',
        'natural female',
        'female',
      ];

      const preferredVoice =
        voices.find((v) => {
          const name = v.name.toLowerCase();
          const langMatch = v.lang.toLowerCase().startsWith(langPrefix);
          return langMatch && sweetVoiceNames.some((fav) => name.includes(fav));
        }) || voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    }
  }

  let mouthInterval: any = null;

  utterance.onstart = () => {
    if (!isCurrentSession(session)) return;
    onStart?.();
    notifyVoiceOutputActivity(true);
    let open = false;
    // Push synthetic lip-sync volume for the 3D avatar (Web Speech API
    // doesn't expose raw audio so we simulate with the mouth-open toggle)
    mouthInterval = setInterval(() => {
      if (!isCurrentSession(session)) {
        clearInterval(mouthInterval);
        return;
      }
      open = !open;
      onSpeakingChunk?.(open);
      getKrixBridge()?.pushKrixLipSyncVolume(open ? 0.45 : 0.1);
    }, 150);
  };

  utterance.onend = () => {
    if (!isCurrentSession(session)) return;
    if (mouthInterval) clearInterval(mouthInterval);
    onSpeakingChunk?.(false);
    getKrixBridge()?.pushKrixLipSyncVolume(0);
    notifyVoiceOutputActivity(false); // Step 5: playback end signal
    onEnd?.();
    currentUtterance = null;
  };

  utterance.onerror = () => {
    if (!isCurrentSession(session)) return;
    if (mouthInterval) clearInterval(mouthInterval);
    onSpeakingChunk?.(false);
    getKrixBridge()?.pushKrixLipSyncVolume(0);
    notifyVoiceOutputActivity(false); // Step 5: playback end signal
    onEnd?.();
    currentUtterance = null;
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function stopKrishaSpeech(): void {
  // Invalidate the current playback session FIRST: any in-flight Gemini-TTS
  // fetch or pending recovery timer becomes a no-op the moment it resumes
  // (speech stops correctly and completely on explicit stop/shutdown).
  playbackSession += 1;
  unexpectedPausePending = false;

  // Stop Krix 3D lip-sync analysis
  getKrixBridge()?.stopKrixAudioAnalysis();
  getKrixBridge()?.pushKrixLipSyncVolume(0);

  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {}
    currentAudio = null;
  }

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
    currentUtterance = null;
  }
}

/**
 * Plays a pleasant soft dual-tone crystal chime when wake-word "Krisha" is recognized.
 */
export function playWakeChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // First note: E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Second note: B5 (987.77 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(987.77, now + 0.1);
    gain2.gain.setValueAtTime(0.14, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.55);
    // Close AudioContext after chime finishes to free memory & prevent RAM leak
    setTimeout(() => {
      try {
        ctx.close();
      } catch {}
    }, 700);
  } catch (e) {
    // Web audio might be restricted before user gesture
    console.debug('Wake chime error:', e);
  }
}
