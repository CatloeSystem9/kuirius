import React, { useState, useCallback } from 'react';
import { RotateCw, FlipHorizontal, Trophy, Check, Sparkles } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playMoveSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

export interface TanPiece {
  id: string;
  name: string;
  type: 'large_tri' | 'med_tri' | 'small_tri' | 'square' | 'parallelogram';
  x: number;
  y: number;
  rotation: number; // in 45-degree steps (0 to 7)
  flipped?: boolean;
  color: string;
  points: [number, number][]; // normalized polygon relative to center
}

interface SilhouetteTarget {
  id: string;
  name: string;
  description: string;
  targets: { id: string; targetX: number; targetY: number; targetRot: number }[];
}

const BASE_TANS: Omit<TanPiece, 'x' | 'y' | 'rotation'>[] = [
  {
    id: 'lt1',
    name: 'Large Triangle A',
    type: 'large_tri',
    color: '#38bdf8',
    points: [[-40, 40], [40, 40], [-40, -40]],
  },
  {
    id: 'lt2',
    name: 'Large Triangle B',
    type: 'large_tri',
    color: '#818cf8',
    points: [[-40, 40], [40, 40], [-40, -40]],
  },
  {
    id: 'mt',
    name: 'Medium Triangle',
    type: 'med_tri',
    color: '#34d399',
    points: [[-28, 28], [28, 28], [-28, -28]],
  },
  {
    id: 'st1',
    name: 'Small Triangle A',
    type: 'small_tri',
    color: '#fbbf24',
    points: [[-20, 20], [20, 20], [-20, -20]],
  },
  {
    id: 'st2',
    name: 'Small Triangle B',
    type: 'small_tri',
    color: '#f43f5e',
    points: [[-20, 20], [20, 20], [-20, -20]],
  },
  {
    id: 'sq',
    name: 'Square',
    type: 'square',
    color: '#a78bfa',
    points: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
  },
  {
    id: 'para',
    name: 'Parallelogram',
    type: 'parallelogram',
    color: '#2dd4bf',
    points: [[-30, 15], [10, 15], [30, -15], [-10, -15]],
  },
];

const SILHOUETTES: SilhouetteTarget[] = [
  {
    id: 'house',
    name: 'Cyber Cottage',
    description: 'Assemble a cozy digital dwelling.',
    targets: [
      { id: 'lt1', targetX: 160, targetY: 130, targetRot: 0 },
      { id: 'lt2', targetX: 240, targetY: 130, targetRot: 2 },
      { id: 'mt', targetX: 200, targetY: 200, targetRot: 0 },
      { id: 'sq', targetX: 200, targetY: 250, targetRot: 0 },
      { id: 'st1', targetX: 160, targetY: 250, targetRot: 0 },
      { id: 'st2', targetX: 240, targetY: 250, targetRot: 2 },
      { id: 'para', targetX: 200, targetY: 290, targetRot: 0 },
    ],
  },
  {
    id: 'boat',
    name: 'Starlight Cutter',
    description: 'Form a sleek sailing vessel.',
    targets: [
      { id: 'lt1', targetX: 180, targetY: 140, targetRot: 1 },
      { id: 'lt2', targetX: 230, targetY: 180, targetRot: 3 },
      { id: 'mt', targetX: 150, targetY: 240, targetRot: 0 },
      { id: 'sq', targetX: 210, targetY: 240, targetRot: 0 },
      { id: 'st1', targetX: 260, targetY: 240, targetRot: 1 },
      { id: 'st2', targetX: 110, targetY: 240, targetRot: 3 },
      { id: 'para', targetX: 200, targetY: 280, targetRot: 0 },
    ],
  },
  {
    id: 'swan',
    name: 'Cosmic Swan',
    description: 'Reconstruct a graceful celestial bird.',
    targets: [
      { id: 'lt1', targetX: 190, targetY: 180, targetRot: 2 },
      { id: 'lt2', targetX: 250, targetY: 220, targetRot: 0 },
      { id: 'mt', targetX: 150, targetY: 120, targetRot: 1 },
      { id: 'sq', targetX: 120, targetY: 80, targetRot: 0 },
      { id: 'st1', targetX: 100, targetY: 50, targetRot: 3 },
      { id: 'st2', targetX: 200, targetY: 250, targetRot: 0 },
      { id: 'para', targetX: 280, targetY: 270, targetRot: 1 },
    ],
  },
];

export const TangramGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'tangram')!;
  const [silhouetteIdx, setSilhouetteIdx] = useState(0);
  const currentSilhouette = SILHOUETTES[silhouetteIdx];

  const initPieces = useCallback(() => {
    return BASE_TANS.map((b, i) => ({
      ...b,
      x: 60 + (i % 4) * 80,
      y: 360 + Math.floor(i / 4) * 60,
      rotation: 0,
      flipped: false,
    }));
  }, []);

  const [pieces, setPieces] = useState<TanPiece[]>(initPieces);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [isWon, setIsWon] = useState(false);

  const selectedPiece = pieces.find((p) => p.id === selectedPieceId);

  // Check matching against target silhouette
  const checkWinCondition = (currentPieces: TanPiece[]) => {
    const targets = currentSilhouette.targets;
    let matchedCount = 0;

    for (const t of targets) {
      const p = currentPieces.find((piece) => piece.id === t.id);
      if (p) {
        const dx = Math.abs(p.x - t.targetX);
        const dy = Math.abs(p.y - t.targetY);
        const dRot = Math.abs((p.rotation % 8) - (t.targetRot % 8));

        // Tolerance snap check
        if (dx <= 25 && dy <= 25 && (dRot === 0 || dRot === 8)) {
          matchedCount++;
        }
      }
    }

    if (matchedCount >= targets.length) {
      setIsWon(true);
      playSuccessSound();
      recordGameResult('tangram', { won: true, score: 500 });
    }
  };

  const handleSelectPiece = (id: string) => {
    setSelectedPieceId(id);
    playMoveSound();
  };

  const handleRotate = () => {
    if (!selectedPieceId) return;
    setPieces((prev) =>
      prev.map((p) => {
        if (p.id === selectedPieceId) {
          const next = { ...p, rotation: (p.rotation + 1) % 8 };
          return next;
        }
        return p;
      })
    );
    playMoveSound();
  };

  const handleFlip = () => {
    if (!selectedPieceId) return;
    setPieces((prev) =>
      prev.map((p) => {
        if (p.id === selectedPieceId) {
          return { ...p, flipped: !p.flipped };
        }
        return p;
      })
    );
    playMoveSound();
  };

  // Drag piece over target board
  const handleBoardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedPieceId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);

    const updated = pieces.map((p) => {
      if (p.id === selectedPieceId) {
        // Snap to target if near
        const target = currentSilhouette.targets.find((t) => t.id === p.id);
        let finalX = x;
        let finalY = y;
        if (target && Math.hypot(x - target.targetX, y - target.targetY) < 30) {
          finalX = target.targetX;
          finalY = target.targetY;
          playHitSound();
        }
        return { ...p, x: finalX, y: finalY };
      }
      return p;
    });

    setPieces(updated);
    checkWinCondition(updated);
  };

  const resetGame = useCallback(() => {
    setPieces(initPieces());
    setSelectedPieceId(null);
    setIsWon(false);
  }, [initPieces]);

  const stats = getArcadeStats('tangram');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={resetGame}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2">
          <select
            value={silhouetteIdx}
            onChange={(e) => {
              setSilhouetteIdx(Number(e.target.value));
              resetGame();
            }}
            className="px-2 py-1 rounded-lg bg-blue-950/60 border border-blue-900/40 text-xs text-slate-200 outline-none cursor-pointer"
          >
            {SILHOUETTES.map((s, idx) => (
              <option key={idx} value={idx}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 max-w-2xl w-full mx-auto select-none">
        {/* Silhouette Board Canvas Container */}
        <div
          onClick={handleBoardClick}
          className="relative w-[360px] sm:w-[400px] h-[340px] rounded-2xl bg-[#090f1e] border-2 border-blue-800/40 shadow-2xl overflow-hidden cursor-crosshair"
        >
          {/* Target Silhouette Guides */}
          {currentSilhouette.targets.map((t) => (
            <div
              key={t.id}
              className="absolute w-8 h-8 rounded-full border border-dashed border-blue-500/30 flex items-center justify-center text-[9px] text-blue-400 font-mono pointer-events-none -translate-x-1/2 -translate-y-1/2"
              style={{ left: t.targetX, top: t.targetY }}
            >
              •
            </div>
          ))}

          {/* SVG Canvas for Tan Pieces */}
          <svg className="w-full h-full pointer-events-none">
            {pieces.map((p) => {
              const isSelected = p.id === selectedPieceId;
              const pointsStr = p.points.map(([px, py]) => `${px},${py}`).join(' ');
              const transformStr = `translate(${p.x}, ${p.y}) rotate(${
                p.rotation * 45
              }) scale(${p.flipped ? -1 : 1}, 1)`;

              return (
                <g key={p.id} transform={transformStr} className="pointer-events-auto">
                  <polygon
                    points={pointsStr}
                    fill={p.color}
                    fillOpacity={0.85}
                    stroke={isSelected ? '#ffffff' : '#0f172a'}
                    strokeWidth={isSelected ? 3 : 1.5}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectPiece(p.id);
                    }}
                    className="cursor-pointer transition-all hover:brightness-125"
                  />
                </g>
              );
            })}
          </svg>

          {/* Victory Overlay */}
          {isWon && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center animate-in fade-in">
              <Trophy className="w-12 h-12 text-amber-400 mb-2 animate-bounce" />
              <h3 className="text-xl font-bold text-white mb-1">
                Silhouette Completed!
              </h3>
              <p className="text-xs text-slate-300 mb-4">
                You perfectly matched {currentSilhouette.name}!
              </p>
              <button
                type="button"
                onClick={() => {
                  setSilhouetteIdx((idx) => (idx + 1) % SILHOUETTES.length);
                  resetGame();
                }}
                className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-semibold text-sm transition-colors cursor-pointer"
              >
                Next Silhouette
              </button>
            </div>
          )}
        </div>

        {/* Piece Manipulation Controls */}
        <div className="flex items-center gap-3 w-full max-w-sm justify-center">
          <button
            type="button"
            disabled={!selectedPieceId}
            onClick={handleRotate}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-950/60 hover:bg-blue-900/60 border border-blue-700/50 text-blue-200 text-xs font-semibold disabled:opacity-40 transition-all cursor-pointer"
          >
            <RotateCw className="w-4 h-4" />
            <span>Rotate 45°</span>
          </button>

          <button
            type="button"
            disabled={!selectedPieceId || selectedPiece?.type !== 'parallelogram'}
            onClick={handleFlip}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-950/60 hover:bg-blue-900/60 border border-blue-700/50 text-blue-200 text-xs font-semibold disabled:opacity-40 transition-all cursor-pointer"
          >
            <FlipHorizontal className="w-4 h-4" />
            <span>Flip</span>
          </button>
        </div>

        {/* Tan Pieces Tray (Click to select) */}
        <div className="flex flex-wrap items-center justify-center gap-2 p-2 rounded-xl bg-[#070b16] border border-blue-900/30 max-w-md">
          {pieces.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleSelectPiece(p.id)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
                p.id === selectedPieceId
                  ? 'bg-blue-600 text-white border-blue-400 ring-2 ring-blue-400/40'
                  : 'bg-blue-950/30 text-slate-300 border-blue-900/30 hover:bg-blue-900/30'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full inline-block mr-1.5" style={{ backgroundColor: p.color }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default TangramGame;
