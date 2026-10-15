import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Trophy, Play, RotateCcw, Flame } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playArcadeTone, playSuccessSound, playGameOverSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

type PadId = 0 | 1 | 2 | 3;

interface PadConfig {
  id: PadId;
  label: string;
  freq: number;
  bgNormal: string;
  bgActive: string;
  borderNormal: string;
  glowActive: string;
}

const PADS: PadConfig[] = [
  {
    id: 0,
    label: 'Emerald',
    freq: 329.63, // E4
    bgNormal: 'bg-emerald-950/50',
    bgActive: 'bg-emerald-400',
    borderNormal: 'border-emerald-600/40',
    glowActive: 'shadow-[0_0_30px_#34d399] ring-4 ring-emerald-300',
  },
  {
    id: 1,
    label: 'Ruby',
    freq: 440.0, // A4
    bgNormal: 'bg-rose-950/50',
    bgActive: 'bg-rose-500',
    borderNormal: 'border-rose-600/40',
    glowActive: 'shadow-[0_0_30px_#f43f5e] ring-4 ring-rose-300',
  },
  {
    id: 2,
    label: 'Amber',
    freq: 554.37, // C#5
    bgNormal: 'bg-amber-950/50',
    bgActive: 'bg-amber-400',
    borderNormal: 'border-amber-600/40',
    glowActive: 'shadow-[0_0_30px_#fbbf24] ring-4 ring-amber-300',
  },
  {
    id: 3,
    label: 'Sapphire',
    freq: 659.25, // E5
    bgNormal: 'bg-blue-950/50',
    bgActive: 'bg-blue-400',
    borderNormal: 'border-blue-600/40',
    glowActive: 'shadow-[0_0_30px_#60a5fa] ring-4 ring-blue-300',
  },
];

export const SimonSaysGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'simon_says')!;
  const [sequence, setSequence] = useState<PadId[]>([]);
  const [userStep, setUserStep] = useState(0);
  const [activePad, setActivePad] = useState<PadId | null>(null);
  const [isPlayingSeq, setIsPlayingSeq] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [score, setScore] = useState(0);

  const activeTimeoutsRef = useRef<NodeJS.Timeout[]>([]);

  const clearAllTimeouts = () => {
    activeTimeoutsRef.current.forEach((t) => clearTimeout(t));
    activeTimeoutsRef.current = [];
  };

  useEffect(() => {
    return () => {
      clearAllTimeouts();
    };
  }, []);

  const flashPad = useCallback((padId: PadId, duration = 300) => {
    setActivePad(padId);
    playArcadeTone(PADS[padId].freq, 'sine', duration / 1000, 0.25);
    const timeout = setTimeout(() => {
      setActivePad(null);
    }, duration);
    activeTimeoutsRef.current.push(timeout);
  }, []);

  const playSequence = useCallback(
    (seq: PadId[]) => {
      setIsPlayingSeq(true);
      setUserStep(0);
      clearAllTimeouts();

      // Tempo ramps up with score
      const stepDuration = Math.max(220, 500 - seq.length * 20);
      const pauseDuration = Math.max(100, 200 - seq.length * 10);

      seq.forEach((pad, index) => {
        const timeout = setTimeout(() => {
          flashPad(pad, stepDuration);
          if (index === seq.length - 1) {
            const endTimeout = setTimeout(() => {
              setIsPlayingSeq(false);
            }, stepDuration + 50);
            activeTimeoutsRef.current.push(endTimeout);
          }
        }, index * (stepDuration + pauseDuration) + 500);
        activeTimeoutsRef.current.push(timeout);
      });
    },
    [flashPad]
  );

  const startNewGame = useCallback(() => {
    clearAllTimeouts();
    setIsGameOver(false);
    setScore(0);
    const firstPad = Math.floor(Math.random() * 4) as PadId;
    const initial = [firstPad];
    setSequence(initial);
    playSequence(initial);
  }, [playSequence]);

  const handlePadClick = (padId: PadId) => {
    if (isPlayingSeq || isGameOver || sequence.length === 0) return;

    flashPad(padId, 220);

    // Verify step
    if (padId === sequence[userStep]) {
      const nextStep = userStep + 1;
      if (nextStep === sequence.length) {
        // Round cleared!
        const nextScore = score + 1;
        setScore(nextScore);
        playSuccessSound();

        const nextPad = Math.floor(Math.random() * 4) as PadId;
        const nextSeq = [...sequence, nextPad];
        setSequence(nextSeq);

        const timeout = setTimeout(() => {
          playSequence(nextSeq);
        }, 800);
        activeTimeoutsRef.current.push(timeout);
      } else {
        setUserStep(nextStep);
      }
    } else {
      // Wrong pad - Game Over
      playGameOverSound();
      setIsGameOver(true);
      recordGameResult('simon_says', { score });
    }
  };

  const stats = getArcadeStats('simon_says');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={startNewGame}
      score={score}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">Streak:</span>
          <span className="font-bold text-amber-400 font-mono text-sm">{score}</span>
        </div>
      }
    >
      <div className="flex flex-col items-center justify-center gap-6 max-w-md w-full mx-auto select-none">
        {/* Status Prompt */}
        <div className="px-4 py-1.5 rounded-xl bg-blue-950/40 border border-blue-900/30 text-xs font-semibold text-slate-300">
          {isGameOver
            ? 'Sequence Broken!'
            : isPlayingSeq
            ? 'Watch & listen closely...'
            : sequence.length === 0
            ? 'Press Start to ignite the pulse'
            : `Your Turn: ${userStep}/${sequence.length}`}
        </div>

        {/* 4 Simon Pads Circle */}
        <div className="relative p-4 rounded-full bg-[#0a0f20] border-4 border-blue-900/50 shadow-2xl">
          <div className="grid grid-cols-2 gap-3 w-64 h-64 sm:w-72 sm:h-72">
            {PADS.map((pad) => {
              const isActive = activePad === pad.id;
              return (
                <button
                  key={pad.id}
                  type="button"
                  disabled={isPlayingSeq || isGameOver}
                  onClick={() => handlePadClick(pad.id)}
                  className={`w-full h-full rounded-2xl border-2 transition-all duration-100 cursor-pointer disabled:cursor-default active:scale-95 ${
                    isActive
                      ? `${pad.bgActive} ${pad.glowActive} scale-[1.03]`
                      : `${pad.bgNormal} ${pad.borderNormal} hover:brightness-125`
                  }`}
                  aria-label={pad.label}
                />
              );
            })}
          </div>

          {/* Center Hub */}
          <div className="absolute inset-0 m-auto w-24 h-24 rounded-full bg-[#050812] border-2 border-blue-800/60 shadow-xl flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
              Score
            </span>
            <span className="text-2xl font-black text-amber-400 font-mono">{score}</span>
          </div>
        </div>

        {/* Start / Retry Button */}
        {(sequence.length === 0 || isGameOver) && (
          <button
            type="button"
            onClick={startNewGame}
            className="px-8 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-indigo-600/40 transition-all cursor-pointer hover:scale-105 active:scale-95"
          >
            {isGameOver ? 'Play Again' : 'Start Pulse'}
          </button>
        )}
      </div>
    </ArcadeGameShell>
  );
};
export default SimonSaysGame;
