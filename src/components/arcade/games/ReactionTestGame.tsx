import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Timer, Zap, Trophy, RotateCcw, AlertTriangle } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playGameOverSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

type State = 'idle' | 'waiting' | 'early' | 'ready' | 'result' | 'summary';

const TOTAL_ROUNDS = 5;

export const ReactionTestGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'reaction_test')!;
  const [state, setState] = useState<State>('idle');
  const [currentRound, setCurrentRound] = useState(1);
  const [roundTimes, setRoundTimes] = useState<number[]>([]);
  const [lastTime, setLastTime] = useState<number | null>(null);

  const startTimeRef = useRef<number>(0);
  const timerTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up timeouts on unmount
  useEffect(() => {
    return () => {
      if (timerTimeoutRef.current) clearTimeout(timerTimeoutRef.current);
    };
  }, []);

  const startRound = useCallback(() => {
    setState('waiting');
    // Random delay between 1500ms and 4500ms
    const delay = Math.floor(Math.random() * 3000) + 1500;

    if (timerTimeoutRef.current) clearTimeout(timerTimeoutRef.current);

    timerTimeoutRef.current = setTimeout(() => {
      startTimeRef.current = performance.now();
      setState('ready');
      playHitSound();
    }, delay);
  }, []);

  const handleClickArena = () => {
    if (state === 'idle') {
      startRound();
    } else if (state === 'waiting') {
      // Too early!
      if (timerTimeoutRef.current) clearTimeout(timerTimeoutRef.current);
      playGameOverSound();
      setState('early');
    } else if (state === 'early') {
      // Restart current round
      startRound();
    } else if (state === 'ready') {
      const elapsed = Math.round(performance.now() - startTimeRef.current);
      playSuccessSound();
      setLastTime(elapsed);
      const nextTimes = [...roundTimes, elapsed];
      setRoundTimes(nextTimes);

      if (nextTimes.length >= TOTAL_ROUNDS) {
        setState('summary');
        const avg = Math.round(
          nextTimes.reduce((a, b) => a + b, 0) / nextTimes.length
        );
        const best = Math.min(...nextTimes);
        recordGameResult('reaction_test', {
          score: Math.max(50, 1000 - avg),
          timeSeconds: best,
        });
      } else {
        setState('result');
      }
    } else if (state === 'result') {
      setCurrentRound((r) => r + 1);
      startRound();
    }
  };

  const resetAll = () => {
    if (timerTimeoutRef.current) clearTimeout(timerTimeoutRef.current);
    setState('idle');
    setCurrentRound(1);
    setRoundTimes([]);
    setLastTime(null);
  };

  const avgTime =
    roundTimes.length > 0
      ? Math.round(roundTimes.reduce((a, b) => a + b, 0) / roundTimes.length)
      : 0;

  const getRank = (ms: number) => {
    if (ms < 190) return { title: 'Godlike Reflexes', color: 'text-amber-400' };
    if (ms < 230) return { title: 'Neural Lightning', color: 'text-indigo-400' };
    if (ms < 270) return { title: 'Master Agility', color: 'text-emerald-400' };
    if (ms < 320) return { title: 'Sharp Reflexes', color: 'text-cyan-400' };
    if (ms < 420) return { title: 'Human Average', color: 'text-blue-300' };
    return { title: 'Slightly Sluggish', color: 'text-slate-400' };
  };

  const stats = getArcadeStats('reaction_test');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={resetAll}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">
            Round: {Math.min(currentRound, TOTAL_ROUNDS)}/{TOTAL_ROUNDS}
          </span>
          {avgTime > 0 && (
            <span className="font-mono text-cyan-300">Avg: {avgTime}ms</span>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center justify-center max-w-xl w-full mx-auto select-none">
        {/* Interactive Reaction Surface */}
        <div
          onClick={handleClickArena}
          className={`w-full min-h-[380px] sm:min-h-[420px] rounded-3xl flex flex-col items-center justify-center p-6 text-center transition-all duration-150 cursor-pointer shadow-2xl relative overflow-hidden ${
            state === 'ready'
              ? 'bg-emerald-500 shadow-emerald-500/50 text-slate-950 scale-[1.01]'
              : state === 'waiting'
              ? 'bg-rose-950/80 border-2 border-rose-600/70 text-rose-200'
              : state === 'early'
              ? 'bg-amber-950/80 border-2 border-amber-600/70 text-amber-200'
              : 'bg-[#0a0f20] border-2 border-blue-900/40 hover:border-blue-600/50 text-slate-100'
          }`}
        >
          {state === 'idle' && (
            <div className="space-y-3">
              <Zap className="w-16 h-16 mx-auto text-blue-400 animate-pulse" />
              <h3 className="text-2xl font-bold">Neural Reaction Test</h3>
              <p className="text-sm text-slate-400 max-w-xs mx-auto">
                Tap anywhere to start. When the screen flashes bright green, tap as fast as humanly possible!
              </p>
              <div className="pt-2 text-xs font-mono text-blue-300">
                [ Click anywhere to initialize ]
              </div>
            </div>
          )}

          {state === 'waiting' && (
            <div className="space-y-3">
              <div className="w-16 h-16 rounded-full bg-rose-600/30 border-2 border-rose-500 flex items-center justify-center mx-auto animate-pulse">
                <span className="w-6 h-6 rounded-full bg-rose-500" />
              </div>
              <h3 className="text-2xl font-bold tracking-wide">Wait for Green...</h3>
              <p className="text-xs text-rose-300">Do not click early!</p>
            </div>
          )}

          {state === 'early' && (
            <div className="space-y-3">
              <AlertTriangle className="w-16 h-16 mx-auto text-amber-400 animate-bounce" />
              <h3 className="text-2xl font-bold">Too Early!</h3>
              <p className="text-sm text-amber-200">
                You clicked before the green flash.
              </p>
              <div className="text-xs font-mono text-amber-300">
                [ Click to retry this round ]
              </div>
            </div>
          )}

          {state === 'ready' && (
            <div className="space-y-2">
              <Zap className="w-20 h-20 mx-auto text-slate-950 animate-bounce" />
              <h3 className="text-4xl sm:text-5xl font-black tracking-tight text-slate-950">
                CLICK NOW!
              </h3>
            </div>
          )}

          {state === 'result' && (
            <div className="space-y-3">
              <Timer className="w-14 h-14 mx-auto text-emerald-400" />
              <div className="font-mono text-5xl font-extrabold text-emerald-400">
                {lastTime} ms
              </div>
              <p className="text-xs text-slate-400">
                Click to advance to Round {currentRound + 1}
              </p>
            </div>
          )}

          {state === 'summary' && (
            <div className="space-y-4">
              <Trophy className="w-16 h-16 mx-auto text-amber-400 animate-bounce" />
              <div>
                <span className="text-xs uppercase tracking-wider text-slate-400">
                  Average Response Time
                </span>
                <div className="font-mono text-4xl sm:text-5xl font-black text-white mt-1">
                  {avgTime} ms
                </div>
                <div className={`text-base font-bold mt-2 ${getRank(avgTime).color}`}>
                  {getRank(avgTime).title}
                </div>
              </div>

              {/* Round by round breakdown */}
              <div className="flex gap-2 justify-center pt-2">
                {roundTimes.map((t, i) => (
                  <div
                    key={i}
                    className="px-2.5 py-1 rounded-lg bg-blue-950/60 border border-blue-800/40 font-mono text-xs text-slate-300"
                  >
                    R{i + 1}: <span className="text-emerald-400 font-bold">{t}ms</span>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  resetAll();
                }}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors cursor-pointer shadow-lg shadow-blue-600/30"
              >
                Test Again
              </button>
            </div>
          )}
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default ReactionTestGame;
