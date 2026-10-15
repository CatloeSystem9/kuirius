let audioCtx: AudioContext | null = null;
let isMuted = false;

try {
  const storedMute = localStorage.getItem('krisha_arcade_muted');
  isMuted = storedMute === 'true';
} catch {
  isMuted = false;
}

export function isArcadeMuted(): boolean {
  return isMuted;
}

export function setArcadeMuted(muted: boolean): void {
  isMuted = muted;
  try {
    localStorage.setItem('krisha_arcade_muted', String(muted));
  } catch {}
}

function getAudioContext(): AudioContext | null {
  if (isMuted) return null;
  if (typeof window === 'undefined') return null;

  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export function playArcadeTone(
  freq: number,
  type: OscillatorType = 'sine',
  duration = 0.1,
  volume = 0.15
): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Ignore audio error
  }
}

export function playMoveSound(): void {
  playArcadeTone(320, 'sine', 0.08, 0.1);
}

export function playCaptureSound(): void {
  playArcadeTone(180, 'triangle', 0.12, 0.18);
}

export function playCheckSound(): void {
  playArcadeTone(520, 'sine', 0.15, 0.2);
}

export function playHitSound(): void {
  playArcadeTone(140, 'sawtooth', 0.18, 0.15);
}

export function playMissSound(): void {
  playArcadeTone(240, 'sine', 0.08, 0.08);
}

export function playSuccessSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    [440, 554, 659, 880].forEach((freq, idx) => {
      setTimeout(() => {
        playArcadeTone(freq, 'sine', 0.16, 0.12);
      }, idx * 70);
    });
  } catch {}
}

export function playGameOverSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    [320, 280, 220, 160].forEach((freq, idx) => {
      setTimeout(() => {
        playArcadeTone(freq, 'sawtooth', 0.2, 0.15);
      }, idx * 90);
    });
  } catch {}
}

export function stopAllArcadeAudio(): void {
  if (audioCtx && audioCtx.state !== 'closed') {
    try {
      audioCtx.suspend().catch(() => {});
    } catch {}
  }
}
