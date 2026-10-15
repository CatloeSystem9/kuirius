import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, HelpCircle, RefreshCw, Trophy, Check } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playSuccessSound, playMoveSound, playHitSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

interface WordTheme {
  name: string;
  words: string[];
}

const THEMES: WordTheme[] = [
  {
    name: 'AI & Intelligence',
    words: ['KRISHA', 'NEURAL', 'SYNAPSE', 'MATRIX', 'AVATAR', 'MEMORY', 'CYBER', 'VISION'],
  },
  {
    name: 'Cosmic Voyage',
    words: ['GALAXY', 'NEBULA', 'ORBIT', 'PULSAR', 'QUASAR', 'STELLAR', 'COSMOS', 'COMET'],
  },
  {
    name: 'Nature & Earth',
    words: ['AURORA', 'CANYON', 'GLACIER', 'LAGOON', 'VALLEY', 'OCEAN', 'BREEZE', 'FOREST'],
  },
];

const GRID_SIZE = 10;
const DIRS = [
  [0, 1],   // right
  [1, 0],   // down
  [1, 1],   // down-right
  [-1, 1],  // up-right
  [0, -1],  // left
  [-1, 0],  // up
  [-1, -1], // up-left
  [1, -1],  // down-left
];

function generateWordSearch(words: string[]): {
  grid: string[][];
  placedWords: { word: string; cells: [number, number][] }[];
} {
  const grid: string[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill('')
  );
  const placedWords: { word: string; cells: [number, number][] }[] = [];

  // Sort words longest first
  const sorted = [...words].sort((a, b) => b.length - a.length);

  for (const word of sorted) {
    let placed = false;
    let attempts = 0;

    while (!placed && attempts < 150) {
      attempts++;
      const dir = DIRS[Math.floor(Math.random() * DIRS.length)];
      const dr = dir[0];
      const dc = dir[1];

      const minR = dr < 0 ? word.length - 1 : 0;
      const maxR = dr > 0 ? GRID_SIZE - word.length : GRID_SIZE - 1;
      const minC = dc < 0 ? word.length - 1 : 0;
      const maxC = dc > 0 ? GRID_SIZE - word.length : GRID_SIZE - 1;

      if (minR > maxR || minC > maxC) continue;

      const r = Math.floor(Math.random() * (maxR - minR + 1)) + minR;
      const c = Math.floor(Math.random() * (maxC - minC + 1)) + minC;

      // Check collision
      let canPlace = true;
      const cells: [number, number][] = [];
      for (let i = 0; i < word.length; i++) {
        const nr = r + i * dr;
        const nc = c + i * dc;
        if (grid[nr][nc] !== '' && grid[nr][nc] !== word[i]) {
          canPlace = false;
          break;
        }
        cells.push([nr, nc]);
      }

      if (canPlace) {
        for (let i = 0; i < word.length; i++) {
          const [nr, nc] = cells[i];
          grid[nr][nc] = word[i];
        }
        placedWords.push({ word, cells });
        placed = true;
      }
    }
  }

  // Fill remaining blanks
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (!grid[r][c]) {
        grid[r][c] = letters[Math.floor(Math.random() * letters.length)];
      }
    }
  }

  return { grid, placedWords };
}

const HIGHLIGHT_COLORS = [
  'bg-emerald-500/30 text-emerald-300 ring-1 ring-emerald-400',
  'bg-indigo-500/30 text-indigo-300 ring-1 ring-indigo-400',
  'bg-amber-500/30 text-amber-300 ring-1 ring-amber-400',
  'bg-rose-500/30 text-rose-300 ring-1 ring-rose-400',
  'bg-cyan-500/30 text-cyan-300 ring-1 ring-cyan-400',
  'bg-fuchsia-500/30 text-fuchsia-300 ring-1 ring-fuchsia-400',
  'bg-sky-500/30 text-sky-300 ring-1 ring-sky-400',
  'bg-teal-500/30 text-teal-300 ring-1 ring-teal-400',
];

export const WordSearchGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'word_search')!;
  const [themeIdx, setThemeIdx] = useState(0);
  const [boardData, setBoardData] = useState(() =>
    generateWordSearch(THEMES[0].words)
  );
  const [foundWords, setFoundWords] = useState<string[]>([]);
  const [selectingCells, setSelectingCells] = useState<[number, number][]>([]);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [startCell, setStartCell] = useState<[number, number] | null>(null);
  const [hintCell, setHintCell] = useState<[number, number] | null>(null);
  const [timer, setTimer] = useState(0);
  const [isWon, setIsWon] = useState(false);

  // Timer interval with cleanup
  useEffect(() => {
    if (isWon) return;
    const interval = setInterval(() => {
      setTimer((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isWon]);

  const initGame = useCallback((idx = themeIdx) => {
    const data = generateWordSearch(THEMES[idx].words);
    setBoardData(data);
    setFoundWords([]);
    setSelectingCells([]);
    setIsPointerDown(false);
    setStartCell(null);
    setHintCell(null);
    setTimer(0);
    setIsWon(false);
  }, [themeIdx]);

  // Pointer gesture handlers
  const handleCellDown = (r: number, c: number) => {
    setIsPointerDown(true);
    setStartCell([r, c]);
    setSelectingCells([[r, c]]);
  };

  const handleCellEnter = (r: number, c: number) => {
    if (!isPointerDown || !startCell) return;
    const [sr, sc] = startCell;
    const dr = r - sr;
    const dc = c - sc;

    // Check if movement is strictly horizontal, vertical, or 45-deg diagonal
    const isHorizontal = dr === 0;
    const isVertical = dc === 0;
    const isDiagonal = Math.abs(dr) === Math.abs(dc);

    if (isHorizontal || isVertical || isDiagonal) {
      const steps = Math.max(Math.abs(dr), Math.abs(dc));
      const stepR = dr === 0 ? 0 : dr / steps;
      const stepC = dc === 0 ? 0 : dc / steps;

      const newCells: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        newCells.push([sr + i * stepR, sc + i * stepC]);
      }
      setSelectingCells(newCells);
    }
  };

  const handlePointerUp = () => {
    if (!isPointerDown) return;
    setIsPointerDown(false);

    if (selectingCells.length > 1) {
      // Form candidate string forwards and backwards
      const forwardStr = selectingCells
        .map(([r, c]) => boardData.grid[r][c])
        .join('');
      const backwardStr = forwardStr.split('').reverse().join('');

      const matched = boardData.placedWords.find(
        (pw) =>
          !foundWords.includes(pw.word) &&
          (pw.word === forwardStr || pw.word === backwardStr)
      );

      if (matched) {
        const nextFound = [...foundWords, matched.word];
        setFoundWords(nextFound);
        playHitSound();

        if (nextFound.length === boardData.placedWords.length) {
          setIsWon(true);
          playSuccessSound();
          recordGameResult('word_search', {
            won: true,
            timeSeconds: timer,
            score: Math.max(100, 1000 - timer * 10),
          });
        }
      }
    }
    setSelectingCells([]);
    setStartCell(null);
  };

  const giveHint = () => {
    const remaining = boardData.placedWords.filter((w) => !foundWords.includes(w.word));
    if (remaining.length === 0) return;
    const target = remaining[0];
    const firstCell = target.cells[0];
    setHintCell(firstCell);
    playMoveSound();
    setTimeout(() => setHintCell(null), 2500);
  };

  const stats = getArcadeStats('word_search');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={() => initGame(themeIdx)}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2">
          {/* Theme selector */}
          <select
            value={themeIdx}
            onChange={(e) => {
              const idx = Number(e.target.value);
              setThemeIdx(idx);
              initGame(idx);
            }}
            className="px-2 py-1 rounded-lg bg-blue-950/60 border border-blue-900/40 text-xs text-slate-200 outline-none cursor-pointer"
          >
            {THEMES.map((t, idx) => (
              <option key={idx} value={idx}>
                {t.name}
              </option>
            ))}
          </select>

          {/* Timer */}
          <div className="px-2 py-1 rounded-lg bg-blue-950/40 border border-blue-900/30 text-xs font-mono text-emerald-400">
            {Math.floor(timer / 60)}:{(timer % 60).toString().padStart(2, '0')}
          </div>

          {/* Hint */}
          <button
            type="button"
            onClick={giveHint}
            className="p-1.5 rounded-lg text-amber-300 hover:text-amber-200 bg-amber-950/30 border border-amber-800/40 transition-colors cursor-pointer"
            title="Hint"
          >
            <Sparkles className="w-4 h-4" />
          </button>
        </div>
      }
    >
      <div
        className="flex flex-col md:flex-row items-center justify-center gap-5 w-full max-w-4xl mx-auto select-none"
        onPointerUp={handlePointerUp}
      >
        {/* Word Grid */}
        <div className="p-2 sm:p-3 rounded-2xl bg-[#0c1220] border-2 border-blue-900/40 shadow-2xl relative">
          <div
            className="grid grid-cols-10 grid-rows-10 gap-1 w-[min(90vw,380px)] h-[min(90vw,380px)] sm:w-[420px] sm:h-[420px]"
            style={{ touchAction: 'none' }}
          >
            {boardData.grid.map((row, r) =>
              row.map((letter, c) => {
                const isSelected = selectingCells.some(
                  ([cr, cc]) => cr === r && cc === c
                );
                // Check if belongs to any found word
                const foundIndex = boardData.placedWords.findIndex(
                  (pw) =>
                    foundWords.includes(pw.word) &&
                    pw.cells.some(([cr, cc]) => cr === r && cc === c)
                );
                const isFound = foundIndex !== -1;
                const isHint = hintCell && hintCell[0] === r && hintCell[1] === c;

                return (
                  <div
                    key={`${r}-${c}`}
                    onPointerDown={() => handleCellDown(r, c)}
                    onPointerEnter={() => handleCellEnter(r, c)}
                    className={`flex items-center justify-center text-sm sm:text-base font-bold font-mono rounded-lg transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/50 scale-105 z-10'
                        : isFound
                        ? HIGHLIGHT_COLORS[foundIndex % HIGHLIGHT_COLORS.length]
                        : isHint
                        ? 'bg-amber-400 text-black animate-bounce ring-2 ring-amber-300'
                        : 'bg-[#131b2e] text-slate-300 hover:bg-[#1e2a47]'
                    }`}
                  >
                    {letter}
                  </div>
                );
              })
            )}
          </div>

          {/* Victory Overlay */}
          {isWon && (
            <div className="absolute inset-0 z-30 bg-black/85 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-6 text-center animate-in fade-in">
              <Trophy className="w-12 h-12 text-amber-400 mb-2 animate-bounce" />
              <h3 className="text-xl font-bold text-white mb-1">
                Puzzle Cleared!
              </h3>
              <p className="text-sm text-slate-300 mb-4">
                You discovered all words in {Math.floor(timer / 60)}m {timer % 60}s!
              </p>
              <button
                type="button"
                onClick={() => initGame((themeIdx + 1) % THEMES.length)}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-600/30 cursor-pointer"
              >
                Next Word Search
              </button>
            </div>
          )}
        </div>

        {/* Word Checklist */}
        <div className="w-full md:w-64 bg-[#0a0f1d] border border-blue-900/30 rounded-2xl p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between pb-2 border-b border-blue-900/20">
            <h4 className="text-xs uppercase font-bold tracking-wider text-slate-400">
              Word List ({foundWords.length}/{boardData.placedWords.length})
            </h4>
            <span className="text-xs font-mono text-emerald-400">
              {Math.round((foundWords.length / boardData.placedWords.length) * 100)}%
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-1 gap-2 overflow-y-auto max-h-[300px]">
            {boardData.placedWords.map((pw, idx) => {
              const isFound = foundWords.includes(pw.word);
              return (
                <div
                  key={pw.word}
                  className={`flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs font-mono transition-all ${
                    isFound
                      ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-400 line-through'
                      : 'bg-blue-950/20 border-blue-900/20 text-slate-300'
                  }`}
                >
                  <span>{pw.word}</span>
                  {isFound && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default WordSearchGame;
