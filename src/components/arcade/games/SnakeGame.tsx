import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Trophy, Flame, Sparkles, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playGameOverSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

const GRID_SIZE = 20;

type Point = [number, number];
type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export const SnakeGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'snake')!;
  const [snake, setSnake] = useState<Point[]>([
    [10, 10],
    [10, 11],
    [10, 12],
  ]);
  const [food, setFood] = useState<Point>([5, 5]);
  const [goldenFood, setGoldenFood] = useState<Point | null>(null);
  const [goldenTimer, setGoldenTimer] = useState(0);

  const [score, setScore] = useState(0);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const dirRef = useRef<Direction>('UP');
  const nextDirRef = useRef<Direction>('UP');
  const snakeRef = useRef<Point[]>([[10, 10], [10, 11], [10, 12]]);
  const foodRef = useRef<Point>([5, 5]);
  const goldenRef = useRef<Point | null>(null);
  const scoreRef = useRef(0);

  // Generate random food not on snake
  const spawnFood = (currentSnake: Point[]): Point => {
    while (true) {
      const r = Math.floor(Math.random() * GRID_SIZE);
      const c = Math.floor(Math.random() * GRID_SIZE);
      if (!currentSnake.some(([sr, sc]) => sr === r && sc === c)) {
        return [r, c];
      }
    }
  };

  const resetGame = useCallback(() => {
    const initialSnake: Point[] = [
      [10, 10],
      [10, 11],
      [10, 12],
    ];
    snakeRef.current = initialSnake;
    dirRef.current = 'UP';
    nextDirRef.current = 'UP';
    scoreRef.current = 0;
    goldenRef.current = null;
    const initialFood = spawnFood(initialSnake);
    foodRef.current = initialFood;

    setSnake(initialSnake);
    setFood(initialFood);
    setGoldenFood(null);
    setScore(0);
    setIsGameOver(false);
    setIsPaused(false);
  }, []);

  // Direction handler preventing 180-degree instant suicide
  const setDirection = (newDir: Direction) => {
    const cur = dirRef.current;
    if (newDir === 'UP' && cur !== 'DOWN') nextDirRef.current = 'UP';
    if (newDir === 'DOWN' && cur !== 'UP') nextDirRef.current = 'DOWN';
    if (newDir === 'LEFT' && cur !== 'RIGHT') nextDirRef.current = 'LEFT';
    if (newDir === 'RIGHT' && cur !== 'LEFT') nextDirRef.current = 'RIGHT';
  };

  // Keyboard controls with cleanup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        setDirection('UP');
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        e.preventDefault();
        setDirection('DOWN');
      } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault();
        setDirection('LEFT');
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault();
        setDirection('RIGHT');
      } else if (e.code === 'Space') {
        e.preventDefault();
        setIsPaused((p) => !p);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Golden star generator timer
  useEffect(() => {
    if (isGameOver || isPaused) return;
    const timer = setInterval(() => {
      if (!goldenRef.current && Math.random() < 0.35) {
        const star = spawnFood(snakeRef.current);
        goldenRef.current = star;
        setGoldenFood(star);
        setGoldenTimer(25); // ticks
      } else if (goldenRef.current) {
        setGoldenTimer((gt) => {
          if (gt <= 1) {
            goldenRef.current = null;
            setGoldenFood(null);
            return 0;
          }
          return gt - 1;
        });
      }
    }, 400);

    return () => clearInterval(timer);
  }, [isGameOver, isPaused]);

  // Main game loop ticker with dynamic speed increase
  useEffect(() => {
    if (isGameOver || isPaused) return;

    // Speed increases as score grows (140ms down to 65ms)
    const speed = Math.max(65, 140 - Math.floor(scoreRef.current / 40) * 10);

    const interval = setInterval(() => {
      dirRef.current = nextDirRef.current;
      const cur = snakeRef.current;
      const head = cur[0];

      let [hr, hc] = head;
      if (dirRef.current === 'UP') hr -= 1;
      if (dirRef.current === 'DOWN') hr += 1;
      if (dirRef.current === 'LEFT') hc -= 1;
      if (dirRef.current === 'RIGHT') hc += 1;

      // Wall collision check
      if (hr < 0 || hr >= GRID_SIZE || hc < 0 || hc >= GRID_SIZE) {
        playGameOverSound();
        setIsGameOver(true);
        recordGameResult('snake', { score: scoreRef.current });
        return;
      }

      // Self collision check
      if (cur.some(([sr, sc]) => sr === hr && sc === hc)) {
        playGameOverSound();
        setIsGameOver(true);
        recordGameResult('snake', { score: scoreRef.current });
        return;
      }

      const newHead: Point = [hr, hc];
      const newSnake = [newHead, ...cur];

      // Check regular food
      if (hr === foodRef.current[0] && hc === foodRef.current[1]) {
        playHitSound();
        scoreRef.current += 10;
        setScore(scoreRef.current);
        const nextFood = spawnFood(newSnake);
        foodRef.current = nextFood;
        setFood(nextFood);
      } else if (
        goldenRef.current &&
        hr === goldenRef.current[0] &&
        hc === goldenRef.current[1]
      ) {
        // Ate golden star!
        playSuccessSound();
        scoreRef.current += 50;
        setScore(scoreRef.current);
        goldenRef.current = null;
        setGoldenFood(null);
      } else {
        newSnake.pop(); // normal move, remove tail
      }

      snakeRef.current = newSnake;
      setSnake(newSnake);
    }, speed);

    return () => clearInterval(interval);
  }, [isGameOver, isPaused]);

  const stats = getArcadeStats('snake');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={resetGame}
      onPauseToggle={setIsPaused}
      isPaused={isPaused}
      score={score}
      stats={stats}
    >
      <div className="flex flex-col items-center gap-4 max-w-xl w-full mx-auto select-none">
        {/* Game Arena */}
        <div className="relative p-2 sm:p-3 rounded-2xl bg-[#090f1d] border-2 border-emerald-900/40 shadow-2xl">
          <div
            className="grid grid-cols-20 grid-rows-20 gap-[1px] w-[min(90vw,380px)] h-[min(90vw,380px)] sm:w-[420px] sm:h-[420px] bg-[#0d1629] rounded-lg overflow-hidden"
            style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: GRID_SIZE * GRID_SIZE }).map((_, idx) => {
              const r = Math.floor(idx / GRID_SIZE);
              const c = idx % GRID_SIZE;

              const isHead = snake[0][0] === r && snake[0][1] === c;
              const isBody =
                !isHead && snake.some(([sr, sc]) => sr === r && sc === c);
              const isFood = food[0] === r && food[1] === c;
              const isGolden = goldenFood && goldenFood[0] === r && goldenFood[1] === c;

              return (
                <div
                  key={idx}
                  className={`flex items-center justify-center rounded-[2px] transition-all ${
                    isHead
                      ? 'bg-emerald-400 shadow-[0_0_8px_#34d399] z-10'
                      : isBody
                      ? 'bg-emerald-600/90'
                      : isFood
                      ? 'bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-pulse rounded-full'
                      : isGolden
                      ? 'bg-amber-400 shadow-[0_0_12px_#fbbf24] animate-bounce rounded-full'
                      : 'bg-transparent'
                  }`}
                />
              );
            })}
          </div>

          {/* Game Over Overlay */}
          {isGameOver && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-6 text-center animate-in fade-in">
              <Trophy className="w-12 h-12 text-amber-400 mb-2" />
              <h3 className="text-2xl font-bold text-white mb-1">Crash!</h3>
              <p className="text-sm text-slate-300 mb-4">
                Final Score: <span className="font-bold text-emerald-400">{score}</span>
              </p>
              <button
                type="button"
                onClick={resetGame}
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors cursor-pointer shadow-lg shadow-emerald-600/30"
              >
                Play Again
              </button>
            </div>
          )}
        </div>

        {/* Mobile Touch D-Pad */}
        <div className="grid grid-cols-3 gap-2 w-48 sm:hidden mt-2">
          <div />
          <button
            type="button"
            onClick={() => setDirection('UP')}
            className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800"
          >
            <ArrowUp className="w-6 h-6" />
          </button>
          <div />

          <button
            type="button"
            onClick={() => setDirection('LEFT')}
            className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={() => setDirection('DOWN')}
            className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800"
          >
            <ArrowDown className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={() => setDirection('RIGHT')}
            className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800"
          >
            <ArrowRight className="w-6 h-6" />
          </button>
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default SnakeGame;
