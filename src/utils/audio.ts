// Audio handling utility with TTS & Web Speech fallback + Lip Sync triggers

let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;

export async function speakKrishaText(
  text: string,
  voiceName: string = 'Kore',
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void
): Promise<void> {
  // Stop previous speech
  stopKrishaSpeech();

  // Try Server Gemini TTS first
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceName }),
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
          playWebSpeechFallback(text, speed, onStart, onEnd, onSpeakingChunk);
        };

        await audio.play();
        return;
      }
    }
  } catch {}

  // Browser Web Speech Fallback
  playWebSpeechFallback(text, speed, onStart, onEnd, onSpeakingChunk);
}

function playWebSpeechFallback(
  text: string,
  speed: number = 1.0,
  onStart?: () => void,
  onEnd?: () => void,
  onSpeakingChunk?: (isMouthOpen: boolean) => void
) {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onEnd?.();
    return;
  }

  window.speechSynthesis.cancel();

  // Clean text from expression markers or brackets
  const clean = text.replace(/\[expression:[^\]]+\]/gi, '').trim();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = Math.max(0.7, Math.min(1.4, speed));
  utterance.pitch = 1.15; // slightly higher pitch for feminine tone

  // Find a good voice if possible
  const voices = window.speechSynthesis.getVoices();
  const preferredVoice = voices.find(
    (v) =>
      v.lang.startsWith('en') &&
      (v.name.includes('Female') ||
        v.name.includes('Samantha') ||
        v.name.includes('Karen') ||
        v.name.includes('Victoria') ||
        v.name.includes('Google US English') ||
        v.name.includes('Natural'))
  );
  if (preferredVoice) {
    utterance.voice = preferredVoice;
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
