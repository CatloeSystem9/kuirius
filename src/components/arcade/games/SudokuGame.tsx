import React, { useState, useEffect, useCallback } from 'react';
import { Pencil, Eraser, Undo2, Sparkles, Trophy, Pause, Play } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { DifficultyLevel } from '../types';
import { playHitSound, playSuccessSound, playMoveSound, playGameOverSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

// Pre-generated, verified unique Sudoku puzzles with complete solutions
const PUZZLES: Record<
  DifficultyLevel,
  { puzzle: number[][]; solution: number[][] }
> = {
  easy: {
    puzzle: [
      [5, 3, 0, 0, 7, 0, 0, 0, 0],
      [6, 0, 0, 1, 9, 5, 0, 0, 0],
      [0, 9, 8, 0, 0, 0, 0, 6, 0],
      [8, 0, 0, 0, 6, 0, 0, 0, 3],
      [4, 0, 0, 8, 0, 3, 0, 0, 1],
      [7, 0, 0, 0, 2, 0, 0, 0, 6],
      [0, 6, 0, 0, 0, 0, 2, 8, 0],
      [0, 0, 0, 4, 1, 9, 0, 0, 5],
      [0, 0, 0, 0, 8, 0, 0, 7, 9],
    ],
    solution: [
      [5, 3, 4, 6, 7, 8, 9, 1, 2],
      [6, 7, 2, 1, 9, 5, 3, 4, 8],
      [1, 9, 8, 3, 4, 2, 5, 6, 7],
      [8, 5, 9, 7, 6, 1, 4, 2, 3],
      [4, 2, 6, 8, 5, 3, 7, 9, 1],
      [7, 1, 3, 9, 2, 4, 8, 5, 6],
      [9, 6, 1, 5, 3, 7, 2, 8, 4],
      [2, 8, 7, 4, 1, 9, 6, 3, 5],
      [3, 4, 5, 2, 8, 6, 1, 7, 9],
    ],
  },
  medium: {
    puzzle: [
      [0, 0, 0, 6, 0, 0, 4, 0, 0],
      [7, 0, 0, 0, 0, 3, 6, 0, 0],
      [0, 0, 0, 0, 9, 1, 0, 8, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 5, 0, 1, 8, 0, 0, 0, 3],
      [0, 0, 0, 3, 0, 6, 0, 4, 5],
      [0, 4, 0, 2, 0, 0, 0, 6, 0],
      [9, 0, 3, 0, 0, 0, 0, 0, 0],
      [0, 2, 0, 0, 0, 0, 1, 0, 0],
    ],
    solution: [
      [5, 8, 1, 6, 7, 2, 4, 3, 9],
      [7, 9, 2, 8, 4, 3, 6, 5, 1],
      [3, 6, 4, 5, 9, 1, 7, 8, 2],
      [4, 3, 8, 9, 5, 7, 2, 1, 6],
      [2, 5, 6, 1, 8, 4, 9, 7, 3],
      [1, 7, 9, 3, 2, 6, 8, 4, 5],
      [8, 4, 5, 2, 1, 9, 3, 6, 7],
      [9, 1, 3, 7, 6, 8, 5, 2, 4],
      [6, 2, 7, 4, 3, 5, 1, 9, 8],
    ],
  },
  hard: {
    puzzle: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 3, 0, 8, 5],
      [0, 0, 1, 0, 2, 0, 0, 0, 0],
      [0, 0, 0, 5, 0, 7, 0, 0, 0],
      [0, 0, 4, 0, 0, 0, 1, 0, 0],
      [0, 9, 0, 0, 0, 0, 0, 0, 0],
      [5, 0, 0, 0, 0, 0, 0, 7, 3],
      [0, 0, 2, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 4, 0, 0, 0, 9],
    ],
    solution: [
      [9, 8, 7, 6, 5, 4, 3, 2, 1],
      [2, 4, 6, 1, 7, 3, 9, 8, 5],
      [3, 5, 1, 9, 2, 8, 7, 4, 6],
      [1, 2, 8, 5, 3, 7, 6, 9, 4],
      [6, 3, 4, 8, 9, 2, 1, 5, 7],
      [7, 9, 5, 4, 6, 1, 8, 3, 2],
      [5, 1, 9, 2, 8, 6, 4, 7, 3],
      [4, 7, 2, 3, 1, 9, 5, 6, 8],
      [8, 6, 3, 7, 4, 5, 2, 1, 9],
    ],
  },
};

export const SudokuGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'sudoku')!;
  const [difficulty, setDifficulty] = useState<DifficultyLevel>('easy');

  // 9x9 board state
  const [grid, setGrid] = useState<number[][]>(() =>
    PUZZLES.easy.puzzle.map((r) => [...r])
  );
  // Notes per cell: 9x9 array of Set<number>
  const [notes, setNotes] = useState<number[][][]>(() =>
    Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []))
  );

  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [isPencilMode, setIsPencilMode] = useState(false);
  const [history, setHistory] = useState<{ grid: number[][]; notes: number[][][] }[]>([]);
  const [timer, setTimer] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isWon, setIsWon] = useState(false);

  // Timer interval with cleanup
  useEffect(() => {
    if (isWon || isPaused) return;
    const interval = setInterval(() => {
      setTimer((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isWon, isPaused]);

  const initGame = useCallback((diff: DifficultyLevel) => {
    const p = PUZZLES[diff];
    setGrid(p.puzzle.map((r) => [...r]));
    setNotes(Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [])));
    setSelectedCell(null);
    setHistory([]);
    setTimer(0);
    setIsWon(false);
    setIsPaused(false);
  }, []);

  const initialPuzzle = PUZZLES[difficulty].puzzle;
  const solution = PUZZLES[difficulty].solution;

  // Push history before edit
  const saveHistory = () => {
    setHistory((prev) => [
      ...prev,
      {
        grid: grid.map((r) => [...r]),
        notes: notes.map((r) => r.map((c) => [...c])),
      },
    ]);
  };

  // Undo
  const handleUndo = () => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setGrid(last.grid);
    setNotes(last.notes);
    setHistory((prev) => prev.slice(0, -1));
    playMoveSound();
  };

  // Input number
  const handleInputNumber = useCallback(
    (num: number) => {
      if (!selectedCell || isWon || isPaused) return;
      const [r, c] = selectedCell;
      if (initialPuzzle[r][c] !== 0) return; // cannot alter given numbers

      saveHistory();

      if (isPencilMode) {
        // Toggle note
        const nextNotes = notes.map((row) => row.map((cell) => [...cell]));
        const currentNotes = nextNotes[r][c];
        if (currentNotes.includes(num)) {
          nextNotes[r][c] = currentNotes.filter((n) => n !== num);
        } else {
          nextNotes[r][c] = [...currentNotes, num].sort((a, b) => a - b);
        }
        setNotes(nextNotes);
        playMoveSound();
      } else {
        // Fill number
        const nextGrid = grid.map((row) => [...row]);
        nextGrid[r][c] = num;
        setGrid(nextGrid);
        playHitSound();

        // Check if solved
        let complete = true;
        for (let i = 0; i < 9; i++) {
          for (let j = 0; j < 9; j++) {
            if (nextGrid[i][j] !== solution[i][j]) {
              complete = false;
              break;
            }
          }
          if (!complete) break;
        }

        if (complete) {
          setIsWon(true);
          playSuccessSound();
          recordGameResult('sudoku', {
            won: true,
            score: Math.max(100, 3000 - timer * 5),
            timeSeconds: timer,
          });
        }
      }
    },
    [selectedCell, isWon, isPaused, initialPuzzle, isPencilMode, notes, grid, solution, timer]
  );

  // Erase
  const handleErase = useCallback(() => {
    if (!selectedCell || isWon) return;
    const [r, c] = selectedCell;
    if (initialPuzzle[r][c] !== 0) return;

    saveHistory();
    const nextGrid = grid.map((row) => [...row]);
    nextGrid[r][c] = 0;
    const nextNotes = notes.map((row) => row.map((cell) => [...cell]));
    nextNotes[r][c] = [];

    setGrid(nextGrid);
    setNotes(nextNotes);
    playMoveSound();
  }, [selectedCell, isWon, initialPuzzle, grid, notes]);

  // Hint
  const handleHint = () => {
    if (!selectedCell || isWon) return;
    const [r, c] = selectedCell;
    if (initialPuzzle[r][c] !== 0) return;

    saveHistory();
    const correctVal = solution[r][c];
    const nextGrid = grid.map((row) => [...row]);
    nextGrid[r][c] = correctVal;
    setGrid(nextGrid);
    playHitSound();
  };

  // Keyboard support with cleanup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '9') {
        handleInputNumber(Number(e.key));
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        handleErase();
      } else if (e.key === 'ArrowUp' && selectedCell) {
        setSelectedCell(([r, c]) => [Math.max(0, r - 1), c]);
      } else if (e.key === 'ArrowDown' && selectedCell) {
        setSelectedCell(([r, c]) => [Math.min(8, r + 1), c]);
      } else if (e.key === 'ArrowLeft' && selectedCell) {
        setSelectedCell(([r, c]) => [r, Math.max(0, c - 1)]);
      } else if (e.key === 'ArrowRight' && selectedCell) {
        setSelectedCell(([r, c]) => [r, Math.min(8, c + 1)]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleInputNumber, handleErase, selectedCell]);

  const stats = getArcadeStats('sudoku');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={() => initGame(difficulty)}
      onPauseToggle={setIsPaused}
      isPaused={isPaused}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2">
          {/* Difficulty selector */}
          <div className="flex items-center p-0.5 rounded-lg bg-blue-950/60 border border-blue-900/40 text-xs">
            {(['easy', 'medium', 'hard'] as DifficultyLevel[]).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => {
                  setDifficulty(lvl);
                  initGame(lvl);
                }}
                className={`px-2 py-1 rounded-md capitalize font-medium transition-all cursor-pointer ${
                  difficulty === lvl
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          {/* Timer */}
          <div className="px-2 py-1 rounded-lg bg-blue-950/40 border border-blue-900/30 text-xs font-mono text-emerald-400">
            {Math.floor(timer / 60)}:{(timer % 60).toString().padStart(2, '0')}
          </div>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 max-w-xl w-full mx-auto select-none">
        {/* 9x9 Sudoku Board */}
        <div className="relative p-2 sm:p-3 rounded-2xl bg-[#090e1f] border-2 border-blue-900/50 shadow-2xl">
          <div className="grid grid-cols-9 grid-rows-9 gap-[1px] w-[min(90vw,360px)] h-[min(90vw,360px)] sm:w-[400px] sm:h-[400px] bg-blue-900/60 rounded-lg overflow-hidden">
            {grid.map((row, r) =>
              row.map((val, c) => {
                const isGiven = initialPuzzle[r][c] !== 0;
                const isSelected = selectedCell && selectedCell[0] === r && selectedCell[1] === c;
                const isSameNumber =
                  val !== 0 && selectedCell && grid[selectedCell[0]][selectedCell[1]] === val;
                const cellNotes = notes[r][c];

                // Check conflict
                const isConflict =
                  val !== 0 && !isGiven && val !== solution[r][c];

                // 3x3 block borders
                const borderBottom = (r + 1) % 3 === 0 && r !== 8 ? 'border-b-2 border-blue-600/70' : '';
                const borderRight = (c + 1) % 3 === 0 && c !== 8 ? 'border-r-2 border-blue-600/70' : '';

                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    onClick={() => setSelectedCell([r, c])}
                    className={`flex items-center justify-center relative font-mono transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-blue-600/40 ring-2 ring-inset ring-blue-400 z-10'
                        : isSameNumber
                        ? 'bg-blue-900/40'
                        : isConflict
                        ? 'bg-rose-950/50 text-rose-400'
                        : 'bg-[#0f172a] hover:bg-[#18233c]'
                    } ${borderBottom} ${borderRight}`}
                  >
                    {val !== 0 ? (
                      <span
                        className={`text-lg sm:text-xl font-bold ${
                          isGiven
                            ? 'text-slate-100 font-extrabold'
                            : isConflict
                            ? 'text-rose-400'
                            : 'text-cyan-300'
                        }`}
                      >
                        {val}
                      </span>
                    ) : cellNotes.length > 0 ? (
                      <div className="grid grid-cols-3 gap-0.5 w-full h-full p-0.5 text-[8px] text-slate-400 font-sans pointer-events-none">
                        {Array.from({ length: 9 }).map((_, n) => (
                          <span key={n} className="flex items-center justify-center">
                            {cellNotes.includes(n + 1) ? n + 1 : ''}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          {/* Victory Overlay */}
          {isWon && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-6 text-center animate-in fade-in">
              <Trophy className="w-12 h-12 text-amber-400 mb-2 animate-bounce" />
              <h3 className="text-xl font-bold text-white mb-1">
                Sudoku Solved!
              </h3>
              <p className="text-xs text-slate-300 mb-4">
                Completed {difficulty} puzzle in {Math.floor(timer / 60)}m {timer % 60}s!
              </p>
              <button
                type="button"
                onClick={() => initGame(difficulty)}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors cursor-pointer shadow-lg shadow-blue-600/30"
              >
                Play Another Puzzle
              </button>
            </div>
          )}
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center gap-2 sm:gap-4 w-full justify-center">
          <button
            type="button"
            onClick={() => setIsPencilMode(!isPencilMode)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
              isPencilMode
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-[0_0_10px_rgba(251,191,36,0.2)]'
                : 'bg-blue-950/40 text-slate-400 border-blue-900/40 hover:bg-blue-900/40'
            }`}
          >
            <Pencil className="w-4 h-4" />
            <span>Notes {isPencilMode ? 'ON' : 'OFF'}</span>
          </button>

          <button
            type="button"
            onClick={handleErase}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-950/40 hover:bg-blue-900/40 border border-blue-900/40 text-slate-300 text-xs font-semibold transition-all cursor-pointer"
          >
            <Eraser className="w-4 h-4" />
            <span>Erase</span>
          </button>

          <button
            type="button"
            onClick={handleUndo}
            disabled={history.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-950/40 hover:bg-blue-900/40 border border-blue-900/40 text-slate-300 text-xs font-semibold disabled:opacity-40 transition-all cursor-pointer"
          >
            <Undo2 className="w-4 h-4" />
            <span>Undo</span>
          </button>

          <button
            type="button"
            onClick={handleHint}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-950/40 hover:bg-cyan-900/40 border border-cyan-800/40 text-cyan-300 text-xs font-semibold transition-all cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>Hint</span>
          </button>
        </div>

        {/* Number Keypad 1-9 */}
        <div className="grid grid-cols-9 gap-1.5 w-full max-w-sm">
          {Array.from({ length: 9 }).map((_, i) => (
            <button
              key={i + 1}
              type="button"
              onClick={() => handleInputNumber(i + 1)}
              className="py-3 rounded-xl bg-blue-950/60 hover:bg-blue-600/50 border border-blue-800/40 font-mono font-bold text-sm sm:text-base text-slate-100 transition-all cursor-pointer active:scale-95"
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default SudokuGame;
