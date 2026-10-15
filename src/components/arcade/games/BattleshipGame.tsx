import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RotateCw,
  Shuffle,
  Crosshair,
  Shield,
  Trophy,
  Flame,
  Droplet,
  Check,
} from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import {
  playHitSound,
  playMissSound,
  playSuccessSound,
  playGameOverSound,
  playMoveSound,
} from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

interface ShipDef {
  name: string;
  size: number;
}

const SHIP_TYPES: ShipDef[] = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

const BOARD_SIZE = 10;

type CellState = 'empty' | 'ship' | 'hit' | 'miss';

interface PlacedShip {
  name: string;
  size: number;
  cells: [number, number][];
  hits: number;
}

function createEmptyGrid(): CellState[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill('empty')
  );
}

function canPlaceShip(
  grid: CellState[][],
  r: number,
  c: number,
  size: number,
  horizontal: boolean
): boolean {
  if (horizontal) {
    if (c + size > BOARD_SIZE) return false;
    for (let i = 0; i < size; i++) {
      if (grid[r][c + i] !== 'empty') return false;
    }
  } else {
    if (r + size > BOARD_SIZE) return false;
    for (let i = 0; i < size; i++) {
      if (grid[r + i][c] !== 'empty') return false;
    }
  }
  return true;
}

function placeShipRandomly(
  grid: CellState[][],
  ship: ShipDef
): PlacedShip | null {
  let attempts = 0;
  while (attempts < 100) {
    attempts++;
    const horizontal = Math.random() < 0.5;
    const r = Math.floor(Math.random() * BOARD_SIZE);
    const c = Math.floor(Math.random() * BOARD_SIZE);

    if (canPlaceShip(grid, r, c, ship.size, horizontal)) {
      const cells: [number, number][] = [];
      for (let i = 0; i < ship.size; i++) {
        const cr = horizontal ? r : r + i;
        const cc = horizontal ? c + i : c;
        grid[cr][cc] = 'ship';
        cells.push([cr, cc]);
      }
      return { name: ship.name, size: ship.size, cells, hits: 0 };
    }
  }
  return null;
}

function autoDeployFleet(): { grid: CellState[][]; ships: PlacedShip[] } {
  const grid = createEmptyGrid();
  const ships: PlacedShip[] = [];
  for (const s of SHIP_TYPES) {
    const placed = placeShipRandomly(grid, s);
    if (placed) ships.push(placed);
  }
  return { grid, ships };
}

export const BattleshipGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'battleship')!;
  const [phase, setPhase] = useState<'deploy' | 'battle' | 'ended'>('deploy');

  // Player Fleet
  const [playerGrid, setPlayerGrid] = useState<CellState[][]>(createEmptyGrid);
  const [playerShips, setPlayerShips] = useState<PlacedShip[]>([]);
  const [deployingShipIndex, setDeployingShipIndex] = useState(0);
  const [isHorizontal, setIsHorizontal] = useState(true);

  // AI Fleet
  const [aiGrid, setAiGrid] = useState<CellState[][]>(createEmptyGrid);
  const [aiShips, setAiShips] = useState<PlacedShip[]>([]);

  // Battle State
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [battleMessage, setBattleMessage] = useState('Position your warships to begin.');
  const [winner, setWinner] = useState<'player' | 'ai' | null>(null);

  // Stats
  const [playerShots, setPlayerShots] = useState(0);
  const [playerHits, setPlayerHits] = useState(0);

  // AI Hunt-and-Target State
  const aiTargetQueueRef = useRef<[number, number][]>([]);
  const aiFiredSetRef = useRef<Set<string>>(new Set());

  // Initialize fresh match
  const startNewGame = useCallback(() => {
    setPlayerGrid(createEmptyGrid());
    setPlayerShips([]);
    setDeployingShipIndex(0);
    setIsHorizontal(true);

    const enemy = autoDeployFleet();
    setAiGrid(enemy.grid);
    setAiShips(enemy.ships);

    setPhase('deploy');
    setIsPlayerTurn(true);
    setWinner(null);
    setPlayerShots(0);
    setPlayerHits(0);
    setBattleMessage('Place your Carrier (5 cells) or tap Auto-Deploy.');
    aiTargetQueueRef.current = [];
    aiFiredSetRef.current = new Set();
  }, []);

  useEffect(() => {
    startNewGame();
  }, [startNewGame]);

  // Quick Auto Deploy
  const handleAutoDeploy = () => {
    const deployed = autoDeployFleet();
    setPlayerGrid(deployed.grid);
    setPlayerShips(deployed.ships);
    setPhase('battle');
    setBattleMessage('War has begun! Click enemy waters to strike.');
    playMoveSound();
  };

  // Manual Ship Placement Click
  const handlePlaceCell = (r: number, c: number) => {
    if (phase !== 'deploy') return;
    if (deployingShipIndex >= SHIP_TYPES.length) return;

    const shipDef = SHIP_TYPES[deployingShipIndex];
    if (canPlaceShip(playerGrid, r, c, shipDef.size, isHorizontal)) {
      const nextGrid = playerGrid.map((row) => [...row]);
      const cells: [number, number][] = [];
      for (let i = 0; i < shipDef.size; i++) {
        const cr = isHorizontal ? r : r + i;
        const cc = isHorizontal ? c + i : c;
        nextGrid[cr][cc] = 'ship';
        cells.push([cr, cc]);
      }

      const newShips = [
        ...playerShips,
        { name: shipDef.name, size: shipDef.size, cells, hits: 0 },
      ];

      setPlayerGrid(nextGrid);
      setPlayerShips(newShips);
      playMoveSound();

      if (deployingShipIndex + 1 < SHIP_TYPES.length) {
        setDeployingShipIndex(deployingShipIndex + 1);
        setBattleMessage(
          `Place your ${SHIP_TYPES[deployingShipIndex + 1].name} (${
            SHIP_TYPES[deployingShipIndex + 1].size
          } cells)`
        );
      } else {
        setPhase('battle');
        setBattleMessage('Fleet ready! Click on enemy coordinates to fire.');
      }
    }
  };

  // AI Turn Logic (Hunt and Target algorithm)
  const triggerAiTurn = useCallback(() => {
    if (winner || phase !== 'battle') return;

    setTimeout(() => {
      let r = 0;
      let c = 0;
      let found = false;

      // 1. If we have targets queued from prior hits
      while (aiTargetQueueRef.current.length > 0) {
        const candidate = aiTargetQueueRef.current.shift()!;
        const key = `${candidate[0]},${candidate[1]}`;
        if (
          candidate[0] >= 0 &&
          candidate[0] < BOARD_SIZE &&
          candidate[1] >= 0 &&
          candidate[1] < BOARD_SIZE &&
          !aiFiredSetRef.current.has(key)
        ) {
          r = candidate[0];
          c = candidate[1];
          found = true;
          break;
        }
      }

      // 2. Parity / Random hunt
      if (!found) {
        let attempts = 0;
        while (attempts < 200) {
          attempts++;
          const tr = Math.floor(Math.random() * BOARD_SIZE);
          const tc = Math.floor(Math.random() * BOARD_SIZE);
          const key = `${tr},${tc}`;
          // Checkerboard parity preference
          if (!aiFiredSetRef.current.has(key) && (tr + tc) % 2 === 0) {
            r = tr;
            c = tc;
            found = true;
            break;
          }
        }
        // Fallback any empty
        if (!found) {
          for (let i = 0; i < BOARD_SIZE && !found; i++) {
            for (let j = 0; j < BOARD_SIZE; j++) {
              if (!aiFiredSetRef.current.has(`${i},${j}`)) {
                r = i;
                c = j;
                found = true;
                break;
              }
            }
          }
        }
      }

      aiFiredSetRef.current.add(`${r},${c}`);
      const nextGrid = playerGrid.map((row) => [...row]);
      const isHit = nextGrid[r][c] === 'ship';

      if (isHit) {
        nextGrid[r][c] = 'hit';
        playHitSound();

        // Enqueue adjacent orthogonal cells for targeting
        aiTargetQueueRef.current.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);

        // Update ship hit counters
        const updatedShips = playerShips.map((s) => {
          if (s.cells.some(([sr, sc]) => sr === r && sc === c)) {
            const hits = s.hits + 1;
            if (hits === s.size) {
              setBattleMessage(`Krisha sank your ${s.name}!`);
            }
            return { ...s, hits };
          }
          return s;
        });
        setPlayerShips(updatedShips);

        // Check if AI won
        if (updatedShips.every((s) => s.hits === s.size)) {
          setWinner('ai');
          setPhase('ended');
          playGameOverSound();
          recordGameResult('battleship', { loss: true });
        }
      } else {
        nextGrid[r][c] = 'miss';
        playMissSound();
      }

      setPlayerGrid(nextGrid);
      setIsPlayerTurn(true);
    }, 450);
  }, [playerGrid, playerShips, winner, phase]);

  // Player Fires at AI Grid
  const handleFireStrike = (r: number, c: number) => {
    if (!isPlayerTurn || phase !== 'battle' || winner) return;
    if (aiGrid[r][c] === 'hit' || aiGrid[r][c] === 'miss') return;

    setPlayerShots((s) => s + 1);
    const nextGrid = aiGrid.map((row) => [...row]);
    const isHit = nextGrid[r][c] === 'ship';

    if (isHit) {
      nextGrid[r][c] = 'hit';
      setPlayerHits((h) => h + 1);
      playHitSound();

      let sunkName = '';
      const updatedShips = aiShips.map((s) => {
        if (s.cells.some(([sr, sc]) => sr === r && sc === c)) {
          const hits = s.hits + 1;
          if (hits === s.size) {
            sunkName = s.name;
          }
          return { ...s, hits };
        }
        return s;
      });
      setAiShips(updatedShips);

      if (sunkName) {
        setBattleMessage(`DIRECT HIT! You sank Krisha's ${sunkName}!`);
      } else {
        setBattleMessage('Direct Hit on enemy vessel!');
      }

      // Check if Player won
      if (updatedShips.every((s) => s.hits === s.size)) {
        setWinner('player');
        setPhase('ended');
        playSuccessSound();
        const accuracy = Math.round(((playerHits + 1) / (playerShots + 1)) * 100);
        recordGameResult('battleship', {
          won: true,
          score: Math.max(100, 2000 - playerShots * 20 + accuracy * 5),
        });
        return;
      }
    } else {
      nextGrid[r][c] = 'miss';
      playMissSound();
      setBattleMessage('Miss! Radar reports open water.');
    }

    setAiGrid(nextGrid);
    setIsPlayerTurn(false);
    triggerAiTurn();
  };

  const stats = getArcadeStats('battleship');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={startNewGame}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2">
          {phase === 'deploy' && (
            <>
              <button
                type="button"
                onClick={() => setIsHorizontal(!isHorizontal)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-950/60 border border-blue-800/40 text-xs text-blue-200 hover:bg-blue-900/40 transition-colors cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>{isHorizontal ? 'Horizontal' : 'Vertical'}</span>
              </button>

              <button
                type="button"
                onClick={handleAutoDeploy}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600/40 border border-indigo-500/50 text-xs text-indigo-200 hover:bg-indigo-600/60 transition-colors cursor-pointer"
              >
                <Shuffle className="w-3.5 h-3.5" />
                <span>Auto-Deploy</span>
              </button>
            </>
          )}

          {phase === 'battle' && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Shots: {playerShots}</span>
              <span className="text-emerald-400">Hits: {playerHits}</span>
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 max-w-5xl w-full mx-auto select-none">
        {/* Battle Announcement Banner */}
        <div className="w-full max-w-2xl px-4 py-2 rounded-xl bg-blue-950/40 border border-blue-900/30 flex items-center justify-between text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-cyan-400 animate-spin" />
            <span className="text-slate-200 font-medium">{battleMessage}</span>
          </div>
          {phase === 'battle' && (
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                isPlayerTurn
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
              }`}
            >
              {isPlayerTurn ? 'Your Turn' : "Krisha's Turn"}
            </span>
          )}
        </div>

        {/* Grids Display */}
        <div className="flex flex-col md:flex-row items-center justify-center gap-6 w-full">
          {/* Player Grid */}
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-slate-300">
              <Shield className="w-4 h-4 text-blue-400" />
              <span>Your Ocean Fleet</span>
            </div>
            <div className="p-2 rounded-2xl bg-[#0c1424] border border-blue-900/40 shadow-xl">
              <div className="grid grid-cols-10 grid-rows-10 gap-0.5 w-[min(88vw,280px)] h-[min(88vw,280px)] sm:w-[300px] sm:h-[300px]">
                {playerGrid.map((row, r) =>
                  row.map((cell, c) => (
                    <button
                      key={`p-${r}-${c}`}
                      type="button"
                      onClick={() => handlePlaceCell(r, c)}
                      className={`flex items-center justify-center rounded-sm transition-all text-xs font-mono ${
                        cell === 'ship'
                          ? 'bg-blue-600/70 border border-blue-400'
                          : cell === 'hit'
                          ? 'bg-rose-600 text-white animate-pulse'
                          : cell === 'miss'
                          ? 'bg-slate-700/50 text-slate-400'
                          : 'bg-[#101b30] hover:bg-[#192b4d]'
                      }`}
                    >
                      {cell === 'hit' && <Flame className="w-3.5 h-3.5 text-amber-300" />}
                      {cell === 'miss' && <Droplet className="w-3 h-3 text-cyan-300" />}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* AI Grid (Only active during Battle phase) */}
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-slate-300">
              <Crosshair className="w-4 h-4 text-cyan-400" />
              <span>Enemy Waters (Target Radar)</span>
            </div>
            <div className="p-2 rounded-2xl bg-[#08101e] border-2 border-cyan-900/50 shadow-2xl relative">
              <div className="grid grid-cols-10 grid-rows-10 gap-0.5 w-[min(88vw,280px)] h-[min(88vw,280px)] sm:w-[300px] sm:h-[300px]">
                {aiGrid.map((row, r) =>
                  row.map((cell, c) => {
                    const isFired = cell === 'hit' || cell === 'miss';
                    return (
                      <button
                        key={`ai-${r}-${c}`}
                        type="button"
                        disabled={phase !== 'battle' || !isPlayerTurn || isFired}
                        onClick={() => handleFireStrike(r, c)}
                        className={`flex items-center justify-center rounded-sm transition-all text-xs font-mono cursor-pointer disabled:cursor-default ${
                          cell === 'hit'
                            ? 'bg-rose-600/90 text-white shadow-md shadow-rose-600/40'
                            : cell === 'miss'
                            ? 'bg-slate-800/80 text-cyan-300'
                            : 'bg-[#0f1d33] hover:bg-cyan-950/60 hover:ring-1 hover:ring-cyan-400/50'
                        }`}
                      >
                        {cell === 'hit' && <Flame className="w-4 h-4 text-amber-200 animate-pulse" />}
                        {cell === 'miss' && <Droplet className="w-3 h-3 text-cyan-400" />}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Fog Overlay during Deployment */}
              {phase === 'deploy' && (
                <div className="absolute inset-0 bg-black/70 backdrop-blur-xs rounded-2xl flex items-center justify-center p-4 text-center">
                  <span className="text-xs text-slate-400">
                    Deploy your fleet on the left grid first.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Fleet Damage Status Cards */}
        <div className="w-full max-w-2xl grid grid-cols-2 gap-4 text-xs">
          <div className="p-3 rounded-xl bg-blue-950/30 border border-blue-900/30">
            <span className="font-bold text-slate-300 block mb-2 uppercase tracking-wider text-[10px]">
              Your Warships
            </span>
            <div className="space-y-1">
              {playerShips.map((s) => (
                <div key={s.name} className="flex items-center justify-between">
                  <span className={s.hits === s.size ? 'line-through text-rose-400' : 'text-slate-300'}>
                    {s.name} ({s.size})
                  </span>
                  <div className="flex gap-1">
                    {Array.from({ length: s.size }).map((_, i) => (
                      <span
                        key={i}
                        className={`w-2 h-2 rounded-full ${
                          i < s.hits ? 'bg-rose-500' : 'bg-blue-400'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-blue-950/30 border border-blue-900/30">
            <span className="font-bold text-slate-300 block mb-2 uppercase tracking-wider text-[10px]">
              Enemy Fleet Status
            </span>
            <div className="space-y-1">
              {aiShips.map((s) => (
                <div key={s.name} className="flex items-center justify-between">
                  <span className={s.hits === s.size ? 'line-through text-emerald-400' : 'text-slate-400'}>
                    {s.name} ({s.size})
                  </span>
                  <div className="flex gap-1">
                    {Array.from({ length: s.size }).map((_, i) => (
                      <span
                        key={i}
                        className={`w-2 h-2 rounded-full ${
                          i < s.hits ? 'bg-rose-500' : 'bg-slate-700'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Game Over Modal */}
        {winner && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-[#0b1220] border border-blue-600/50 rounded-2xl p-6 text-center max-w-sm w-full shadow-2xl">
              <Trophy
                className={`w-12 h-12 mx-auto mb-3 ${
                  winner === 'player' ? 'text-amber-400 animate-bounce' : 'text-slate-500'
                }`}
              />
              <h3 className="text-xl font-bold text-white mb-1">
                {winner === 'player' ? 'Naval Victory!' : 'Fleet Defeated'}
              </h3>
              <p className="text-xs text-slate-300 mb-4">
                {winner === 'player'
                  ? `You sank all 5 enemy vessels in ${playerShots} shots (${Math.round(
                      (playerHits / playerShots) * 100
                    )}% accuracy)!`
                  : 'Krisha conquered the seas this round.'}
              </p>
              <button
                type="button"
                onClick={startNewGame}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors cursor-pointer"
              >
                Play Again
              </button>
            </div>
          </div>
        )}
      </div>
    </ArcadeGameShell>
  );
};
export default BattleshipGame;
