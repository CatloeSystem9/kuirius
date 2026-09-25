// Audio handling utility with TTS & Web Speech fallback + Lip Sync triggers

let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;

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

export async function speakKrishaText(
  text: string,
  voiceName: string = 'Aoede',
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void,
  preferredLanguage?: string,
  pitch: number = 1.25
): Promise<void> {
  // Stop previous speech
  stopKrishaSpeech();

  const detected = detectSpeechLanguage(text);
  const targetLang =
    preferredLanguage && preferredLanguage !== 'auto'
      ? preferredLanguage === 'hi'
        ? 'hi-IN'
        : 'en-US'
      : detected.lang;

  // Try Server Gemini TTS first (Aoede is Gemini's sweet, melodic feminine voice)
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceName, lang: targetLang }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.audio) {
        // Play base64 audio
        const audioSrc = `data:audio/mp3;base64,${data.audio}`;
        const audio = new Audio(audioSrc);
        audio.playbackRate = speed;
        currentAudio = audio;

        let mouthInterval: any = null;

        audio.onplay = () => {
          onStart?.();
          // Simulate rhythmic mouth lip sync
          let open = false;
          mouthInterval = setInterval(() => {
            open = !open;
            onSpeakingChunk?.(open);
          }, 140);
        };

        audio.onended = () => {
          if (mouthInterval) clearInterval(mouthInterval);
          onSpeakingChunk?.(false);
          onEnd?.();
          currentAudio = null;
        };

        audio.onerror = () => {
          if (mouthInterval) clearInterval(mouthInterval);
          onSpeakingChunk?.(false);
          playWebSpeechFallback(text, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch);
        };

        await audio.play();
        return;
      }
    }
  } catch {}

  // Browser Web Speech Fallback with sweet feminine pitch
  playWebSpeechFallback(text, speed, onStart, onEnd, onSpeakingChunk, targetLang, pitch);
}

function playWebSpeechFallback(
  text: string,
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void,
  targetLang?: string,
  pitch: number = 1.25
) {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onEnd?.();
    return;
  }

  window.speechSynthesis.cancel();

  // Clean text from emotion markers, expression brackets, or markdown tags
  const clean = text
    .replace(/\[(?:emotion|expression):[^\]]+\]/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[*_~`]/g, '')
    .trim();

  if (!clean) {
    onEnd?.();
    return;
  }

  const detected = detectSpeechLanguage(clean);
  const langToUse = targetLang || detected.lang;

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = langToUse;
  // Natural gentle pace for sweet feminine delivery
  utterance.rate = Math.max(0.75, Math.min(1.3, speed * 0.98));
  // Sweet feminine pitch (1.25 creates a tender, warm feminine anime cadence)
  utterance.pitch = Math.max(0.85, Math.min(1.7, pitch || 1.25));

  // Voice selection according to language
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
    // English: prioritize top sweet, soft, natural feminine voices
    const langPrefix = langToUse.slice(0, 2).toLowerCase();
    const sweetVoiceNames = [
      'jenny', // Microsoft Jenny (Natural) - soft, sweet feminine
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

  let mouthInterval: any = null;

  utterance.onstart = () => {
    onStart?.();
    let open = false;
    mouthInterval = setInterval(() => {
      open = !open;
      onSpeakingChunk?.(open);
    }, 150);
  };

  utterance.onend = () => {
    if (mouthInterval) clearInterval(mouthInterval);
    onSpeakingChunk?.(false);
    onEnd?.();
    currentUtterance = null;
  };

  utterance.onerror = () => {
    if (mouthInterval) clearInterval(mouthInterval);
    onSpeakingChunk?.(false);
    onEnd?.();
    currentUtterance = null;
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function stopKrishaSpeech(): void {
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
