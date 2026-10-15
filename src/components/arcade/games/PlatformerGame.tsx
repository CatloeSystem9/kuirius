import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, RotateCcw, Trophy, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playGameOverSound, playMoveSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  vx?: number;
  minX?: number;
  maxX?: number;
}

interface Gem {
  x: number;
  y: number;
  collected: boolean;
}

interface Hazard {
  x: number;
  y: number;
  w: number;
  h: number;
  vx?: number;
  minX?: number;
  maxX?: number;
}

interface StageConfig {
  playerStart: { x: number; y: number };
  goal: { x: number; y: number; w: number; h: number };
  platforms: Platform[];
  gems: Gem[];
  hazards: Hazard[];
}

const STAGES: StageConfig[] = [
  // Stage 1: Introduction to Cyber Leaps
  {
    playerStart: { x: 50, y: 350 },
    goal: { x: 730, y: 120, w: 40, h: 60 },
    platforms: [
      { x: 0, y: 410, w: 800, h: 40 }, // Ground
      { x: 140, y: 340, w: 100, h: 16 },
      { x: 280, y: 280, w: 110, h: 16 },
      { x: 440, y: 220, w: 120, h: 16 },
      { x: 600, y: 170, w: 100, h: 16 },
      { x: 710, y: 170, w: 90, h: 16 },
    ],
    gems: [
      { x: 180, y: 300, collected: false },
      { x: 330, y: 240, collected: false },
      { x: 490, y: 180, collected: false },
      { x: 640, y: 130, collected: false },
    ],
    hazards: [
      { x: 380, y: 395, w: 50, h: 15 }, // ground spike
    ],
  },
  // Stage 2: Moving Platforms & Sky Hazards
  {
    playerStart: { x: 40, y: 350 },
    goal: { x: 740, y: 80, w: 40, h: 60 },
    platforms: [
      { x: 0, y: 410, w: 250, h: 40 },
      { x: 320, y: 350, w: 90, h: 16, vx: 1.5, minX: 300, maxX: 460 }, // moving platform
      { x: 540, y: 280, w: 100, h: 16 },
      { x: 380, y: 210, w: 90, h: 16, vx: -1.2, minX: 280, maxX: 440 },
      { x: 580, y: 150, w: 100, h: 16 },
      { x: 710, y: 130, w: 90, h: 16 },
    ],
    gems: [
      { x: 180, y: 370, collected: false },
      { x: 360, y: 310, collected: false },
      { x: 580, y: 240, collected: false },
      { x: 420, y: 170, collected: false },
      { x: 620, y: 110, collected: false },
    ],
    hazards: [
      { x: 250, y: 400, w: 550, h: 15 }, // pit of spikes
      { x: 540, y: 240, w: 20, h: 20, vx: 1.8, minX: 520, maxX: 660 }, // floating drone
    ],
  },
  // Stage 3: Master of Gravity
  {
    playerStart: { x: 40, y: 350 },
    goal: { x: 730, y: 60, w: 40, h: 60 },
    platforms: [
      { x: 0, y: 410, w: 160, h: 40 },
      { x: 190, y: 340, w: 80, h: 16 },
      { x: 310, y: 280, w: 80, h: 16, vx: 2, minX: 300, maxX: 460 },
      { x: 510, y: 230, w: 80, h: 16 },
      { x: 360, y: 160, w: 80, h: 16, vx: -2, minX: 250, maxX: 420 },
      { x: 520, y: 110, w: 90, h: 16 },
      { x: 690, y: 110, w: 110, h: 16 },
    ],
    gems: [
      { x: 100, y: 370, collected: false },
      { x: 230, y: 300, collected: false },
      { x: 350, y: 240, collected: false },
      { x: 550, y: 190, collected: false },
      { x: 400, y: 120, collected: false },
      { x: 560, y: 70, collected: false },
    ],
    hazards: [
      { x: 160, y: 400, w: 640, h: 15 }, // endless spikes
      { x: 420, y: 200, w: 22, h: 22, vx: 2.2, minX: 380, maxX: 560 },
      { x: 480, y: 90, w: 22, h: 22, vx: -2.0, minX: 420, maxX: 600 },
    ],
  },
];

export const PlatformerGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'platformer')!;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [currentStageIdx, setCurrentStageIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [isPaused, setIsPaused] = useState(false);
  const [gameState, setGameState] = useState<'playing' | 'stage_cleared' | 'game_over' | 'victory'>('playing');

  // Input keys
  const keysRef = useRef<{ left: boolean; right: boolean; jump: boolean }>({
    left: false,
    right: false,
    jump: false,
  });

  // Player physics state
  const playerRef = useRef({
    x: 50,
    y: 350,
    w: 24,
    h: 30,
    vx: 0,
    vy: 0,
    isGrounded: false,
    canDoubleJump: true,
  });

  const stageDataRef = useRef<StageConfig>(JSON.parse(JSON.stringify(STAGES[0])));
  const rafRef = useRef<number | null>(null);

  // Initialize stage
  const loadStage = useCallback((stageIdx: number) => {
    const rawStage = STAGES[stageIdx] || STAGES[0];
    const cloned = JSON.parse(JSON.stringify(rawStage));
    stageDataRef.current = cloned;
    playerRef.current = {
      x: cloned.playerStart.x,
      y: cloned.playerStart.y,
      w: 24,
      h: 30,
      vx: 0,
      vy: 0,
      isGrounded: false,
      canDoubleJump: true,
    };
    setCurrentStageIdx(stageIdx);
    setGameState('playing');
  }, []);

  const resetGame = useCallback(() => {
    setScore(0);
    setLives(3);
    setIsPaused(false);
    loadStage(0);
  }, [loadStage]);

  // Keyboard Event Listeners with strict cleanup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') keysRef.current.left = true;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') keysRef.current.right = true;
      if (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Space') {
        if (!keysRef.current.jump) {
          // Trigger jump
          const p = playerRef.current;
          if (p.isGrounded) {
            p.vy = -10.5;
            p.isGrounded = false;
            p.canDoubleJump = true;
            playMoveSound();
          } else if (p.canDoubleJump) {
            p.vy = -9.5;
            p.canDoubleJump = false;
            playMoveSound();
          }
        }
        keysRef.current.jump = true;
      }
      if (e.code === 'KeyP') {
        setIsPaused((prev) => !prev);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') keysRef.current.left = false;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') keysRef.current.right = false;
      if (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Space') keysRef.current.jump = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Main 60fps Game Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let running = true;

    const loop = () => {
      if (!running) return;

      if (!isPaused && gameState === 'playing') {
        const p = playerRef.current;
        const stage = stageDataRef.current;

        // 1. Horizontal movement & friction
        const accel = 0.8;
        const maxSpeed = 4.8;
        const friction = 0.82;

        if (keysRef.current.left) p.vx = Math.max(p.vx - accel, -maxSpeed);
        else if (keysRef.current.right) p.vx = Math.min(p.vx + accel, maxSpeed);
        else p.vx *= friction;

        p.x += p.vx;

        // Boundary clamp
        if (p.x < 0) {
          p.x = 0;
          p.vx = 0;
        }
        if (p.x + p.w > 800) {
          p.x = 800 - p.w;
          p.vx = 0;
        }

        // 2. Gravity
        const gravity = 0.52;
        p.vy += gravity;
        if (p.vy > 12) p.vy = 12;
        p.y += p.vy;

        // 3. Move moving platforms
        for (const plat of stage.platforms) {
          if (plat.vx && plat.minX !== undefined && plat.maxX !== undefined) {
            plat.x += plat.vx;
            if (plat.x < plat.minX || plat.x + plat.w > plat.maxX) {
              plat.vx = -plat.vx;
            }
          }
        }

        // 4. Move hazards
        for (const h of stage.hazards) {
          if (h.vx && h.minX !== undefined && h.maxX !== undefined) {
            h.x += h.vx;
            if (h.x < h.minX || h.x + h.w > h.maxX) {
              h.vx = -h.vx;
            }
          }
        }

        // 5. Platform collision (AABB)
        p.isGrounded = false;
        for (const plat of stage.platforms) {
          // Check horizontal overlap
          if (p.x + p.w > plat.x && p.x < plat.x + plat.w) {
            // Landing on top
            if (p.y + p.h >= plat.y && p.y + p.h - p.vy <= plat.y + 12 && p.vy >= 0) {
              p.y = plat.y - p.h;
              p.vy = 0;
              p.isGrounded = true;
              p.canDoubleJump = true;
              // Ride moving platform
              if (plat.vx) p.x += plat.vx;
            }
          }
        }

        // Pit fall death check
        if (p.y > 450) {
          handlePlayerDeath();
        }

        // 6. Hazard collision
        for (const h of stage.hazards) {
          if (
            p.x + p.w > h.x &&
            p.x < h.x + h.w &&
            p.y + p.h > h.y &&
            p.y < h.y + h.h
          ) {
            handlePlayerDeath();
            break;
          }
        }

        // 7. Gem collection
        for (const gem of stage.gems) {
          if (!gem.collected) {
            const dist = Math.hypot(p.x + p.w / 2 - gem.x, p.y + p.h / 2 - gem.y);
            if (dist < 22) {
              gem.collected = true;
              setScore((s) => s + 100);
              playHitSound();
            }
          }
        }

        // 8. Goal collision
        const g = stage.goal;
        if (
          p.x + p.w > g.x &&
          p.x < g.x + g.w &&
          p.y + p.h > g.y &&
          p.y < g.y + g.h
        ) {
          if (currentStageIdx + 1 < STAGES.length) {
            setGameState('stage_cleared');
            playSuccessSound();
            setScore((s) => s + 500);
          } else {
            setGameState('victory');
            playSuccessSound();
            recordGameResult('platformer', {
              won: true,
              score: score + 1000,
            });
          }
        }
      }

      // Render Stage
      drawCanvas(ctx);

      rafRef.current = requestAnimationFrame(loop);
    };

    const handlePlayerDeath = () => {
      playGameOverSound();
      setLives((l) => {
        const next = l - 1;
        if (next <= 0) {
          setGameState('game_over');
          recordGameResult('platformer', { score });
          return 0;
        } else {
          // Respawn at stage start
          const p = playerRef.current;
          const stage = stageDataRef.current;
          p.x = stage.playerStart.x;
          p.y = stage.playerStart.y;
          p.vx = 0;
          p.vy = 0;
          return next;
        }
      });
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPaused, gameState, currentStageIdx, score]);

  // Drawing routines
  const drawCanvas = (ctx: CanvasRenderingContext2D) => {
    const stage = stageDataRef.current;
    const p = playerRef.current;

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, 450);
    bgGrad.addColorStop(0, '#040711');
    bgGrad.addColorStop(1, '#0b1329');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 800, 450);

    // Subtle starry grid lines
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < 800; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 450);
      ctx.stroke();
    }

    // Platforms
    for (const plat of stage.platforms) {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
      // Glowing cyber top edge
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(plat.x, plat.y, plat.w, 3);
    }

    // Hazards (Red glowing spikes or drone)
    for (const h of stage.hazards) {
      if (h.vx) {
        // Drone
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(h.x + h.w / 2, h.y + h.h / 2, h.w / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fca5a5';
        ctx.beginPath();
        ctx.arc(h.x + h.w / 2, h.y + h.h / 2, h.w / 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Spikes
        ctx.fillStyle = '#f43f5e';
        const spikeCount = Math.floor(h.w / 12);
        for (let i = 0; i < spikeCount; i++) {
          ctx.beginPath();
          ctx.moveTo(h.x + i * 12, h.y + h.h);
          ctx.lineTo(h.x + i * 12 + 6, h.y);
          ctx.lineTo(h.x + (i + 1) * 12, h.y + h.h);
          ctx.fill();
        }
      }
    }

    // Gems (Spinning starlight crystals)
    for (const gem of stage.gems) {
      if (!gem.collected) {
        const time = performance.now() / 300;
        const bob = Math.sin(time) * 3;
        ctx.save();
        ctx.translate(gem.x, gem.y + bob);
        ctx.fillStyle = '#fbbf24';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, -9);
        ctx.lineTo(7, 0);
        ctx.lineTo(0, 9);
        ctx.lineTo(-7, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // Goal Portal
    const g = stage.goal;
    const pulse = Math.sin(performance.now() / 250) * 4;
    ctx.save();
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#6366f1';
    ctx.shadowBlur = 15;
    ctx.strokeRect(g.x - pulse / 2, g.y - pulse / 2, g.w + pulse, g.h + pulse);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.2)';
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.restore();

    // Player Avatar (Glowing Neon Cyber Runner)
    ctx.save();
    ctx.fillStyle = '#60a5fa';
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 12;
    // Body
    ctx.fillRect(p.x, p.y, p.w, p.h);
    // Visor
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(p.x + (p.vx >= 0 ? 10 : 2), p.y + 6, 12, 6);
    ctx.restore();
  };

  const handleTouchJump = () => {
    const p = playerRef.current;
    if (p.isGrounded) {
      p.vy = -10.5;
      p.isGrounded = false;
      p.canDoubleJump = true;
      playMoveSound();
    } else if (p.canDoubleJump) {
      p.vy = -9.5;
      p.canDoubleJump = false;
      playMoveSound();
    }
  };

  const stats = getArcadeStats('platformer');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={resetGame}
      onPauseToggle={setIsPaused}
      isPaused={isPaused}
      score={score}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-400">Stage: {currentStageIdx + 1}/3</span>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Lives:</span>
            {Array.from({ length: 3 }).map((_, i) => (
              <span
                key={i}
                className={`w-2 h-2 rounded-full ${
                  i < lives ? 'bg-rose-500 shadow-[0_0_6px_#f43f5e]' : 'bg-slate-800'
                }`}
              />
            ))}
          </div>
        </div>
      }
    >
      <div className="flex flex-col items-center max-w-4xl w-full mx-auto select-none">
        {/* Game Canvas Container */}
        <div className="relative rounded-2xl overflow-hidden border-2 border-blue-900/50 shadow-2xl bg-[#030611] max-w-full">
          <canvas
            ref={canvasRef}
            width={800}
            height={450}
            className="w-[min(94vw,760px)] h-auto aspect-16/9 block"
          />

          {/* Pause Overlay */}
          {isPaused && (
            <div className="absolute inset-0 bg-black/75 backdrop-blur-xs flex flex-col items-center justify-center text-center">
              <Pause className="w-12 h-12 text-amber-400 mb-2 animate-pulse" />
              <h3 className="text-xl font-bold text-white mb-2">Game Paused</h3>
              <button
                type="button"
                onClick={() => setIsPaused(false)}
                className="px-6 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors cursor-pointer"
              >
                Resume
              </button>
            </div>
          )}

          {/* Stage Cleared Overlay */}
          {gameState === 'stage_cleared' && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 animate-in fade-in">
              <Trophy className="w-12 h-12 text-amber-400 mb-2 animate-bounce" />
              <h3 className="text-2xl font-bold text-white mb-1">Stage Cleared!</h3>
              <p className="text-sm text-slate-300 mb-4">+500 Stage Clear Bonus</p>
              <button
                type="button"
                onClick={() => loadStage(currentStageIdx + 1)}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors cursor-pointer shadow-lg shadow-blue-600/30"
              >
                Proceed to Stage {currentStageIdx + 2}
              </button>
            </div>
          )}

          {/* Game Over Overlay */}
          {gameState === 'game_over' && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 animate-in fade-in">
              <h3 className="text-2xl font-bold text-rose-400 mb-2">System Offline</h3>
              <p className="text-sm text-slate-300 mb-4">Final Score: {score}</p>
              <button
                type="button"
                onClick={resetGame}
                className="px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm transition-colors cursor-pointer"
              >
                Try Again
              </button>
            </div>
          )}

          {/* All Stages Cleared Victory */}
          {gameState === 'victory' && (
            <div className="absolute inset-0 bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 animate-in fade-in">
              <Trophy className="w-14 h-14 text-amber-400 mb-3 animate-bounce" />
              <h3 className="text-2xl font-bold text-white mb-1">Warp Gateway Conquered!</h3>
              <p className="text-sm text-slate-300 mb-4">
                You mastered all 3 cyber stages! Score: {score}
              </p>
              <button
                type="button"
                onClick={resetGame}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors cursor-pointer"
              >
                Replay Mission
              </button>
            </div>
          )}
        </div>

        {/* Mobile On-Screen Controls */}
        <div className="flex sm:hidden items-center justify-between w-full max-w-sm mt-3 px-2">
          <div className="flex gap-2">
            <button
              type="button"
              onPointerDown={() => (keysRef.current.left = true)}
              onPointerUp={() => (keysRef.current.left = false)}
              onPointerLeave={() => (keysRef.current.left = false)}
              className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800 transition-colors"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <button
              type="button"
              onPointerDown={() => (keysRef.current.right = true)}
              onPointerUp={() => (keysRef.current.right = false)}
              onPointerLeave={() => (keysRef.current.right = false)}
              className="w-14 h-14 rounded-2xl bg-blue-950/70 border border-blue-700/50 flex items-center justify-center text-white active:bg-blue-800 transition-colors"
            >
              <ArrowRight className="w-6 h-6" />
            </button>
          </div>

          <button
            type="button"
            onPointerDown={handleTouchJump}
            className="w-16 h-14 rounded-2xl bg-indigo-600 border border-indigo-400 flex items-center justify-center text-white font-bold text-sm active:bg-indigo-500 transition-colors shadow-lg shadow-indigo-600/40"
          >
            <ArrowUp className="w-6 h-6" />
          </button>
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default PlatformerGame;
