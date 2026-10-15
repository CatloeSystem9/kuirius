import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, Trophy, Delete, CornerDownLeft } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playGameOverSound, playMoveSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

const WORD_BANK = [
  'BRAIN', 'CLOUD', 'DREAM', 'EARTH', 'FLASH', 'GHOST', 'HEART', 'LIGHT',
  'MAGIC', 'NIGHT', 'OCEAN', 'PEACE', 'QUEST', 'ROBOT', 'SPACE', 'STORM',
  'TIGER', 'VOICE', 'WATER', 'YOUTH', 'CYBER', 'LOGIC', 'PULSE', 'SHINE',
  'SPARK', 'ALPHA', 'BEAST', 'CHARM', 'DRIVE', 'FLAME', 'GLORY', 'HONOR',
  'LUNAR', 'NEURA', 'ORBIT', 'PIXEL', 'RADAR', 'SOLAR', 'TITAN', 'VIBES',
];

const KEYBOARD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACK'],
];

export const WordGuessGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'word_guess')!;
  const [targetWord, setTargetWord] = useState(() =>
    WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)]
  );
  const [guesses, setGuesses] = useState<string[]>([]);
  const [currentGuess, setCurrentGuess] = useState('');
  const [isGameOver, setIsGameOver] = useState(false);
  const [isWon, setIsWon] = useState(false);
  const [revealedHint, setRevealedHint] = useState<string | null>(null);

  const resetGame = useCallback(() => {
    const next = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
    setTargetWord(next);
    setGuesses([]);
    setCurrentGuess('');
    setIsGameOver(false);
    setIsWon(false);
    setRevealedHint(null);
  }, []);

  const handleChar = useCallback(
    (char: string) => {
      if (isGameOver) return;
      if (currentGuess.length < 5) {
        setCurrentGuess((prev) => prev + char);
        playMoveSound();
      }
    },
    [isGameOver, currentGuess.length]
  );

  const handleDelete = useCallback(() => {
    if (isGameOver) return;
    setCurrentGuess((prev) => prev.slice(0, -1));
  }, [isGameOver]);

  const handleSubmit = useCallback(() => {
    if (isGameOver) return;
    if (currentGuess.length !== 5) return;

    const nextGuesses = [...guesses, currentGuess];
    setGuesses(nextGuesses);
    playHitSound();

    if (currentGuess === targetWord) {
      setIsWon(true);
      setIsGameOver(true);
      playSuccessSound();
      recordGameResult('word_guess', {
        won: true,
        score: (7 - nextGuesses.length) * 150,
      });
    } else if (nextGuesses.length >= 6) {
      setIsWon(false);
      setIsGameOver(true);
      playGameOverSound();
      recordGameResult('word_guess', { loss: true });
    }

    setCurrentGuess('');
  }, [isGameOver, currentGuess, targetWord, guesses]);

  // Physical keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Backspace') {
        handleDelete();
      } else {
        const char = e.key.toUpperCase();
        if (/^[A-Z]$/.test(char)) {
          handleChar(char);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleChar, handleDelete, handleSubmit]);

  // Calculate keyboard letter states (correct, present, absent)
  const letterStatuses: Record<string, 'correct' | 'present' | 'absent'> = {};
  for (const g of guesses) {
    for (let i = 0; i < 5; i++) {
      const letter = g[i];
      if (targetWord[i] === letter) {
        letterStatuses[letter] = 'correct';
      } else if (targetWord.includes(letter)) {
        if (letterStatuses[letter] !== 'correct') {
          letterStatuses[letter] = 'present';
        }
      } else {
        if (!letterStatuses[letter]) {
          letterStatuses[letter] = 'absent';
        }
      }
    }
  }

  const giveHint = () => {
    if (revealedHint || isGameOver) return;
    const remainingLetters = targetWord.split('').filter((c) => !guesses.some((g) => g.includes(c)));
    if (remainingLetters.length > 0) {
      setRevealedHint(`Word contains letter: ${remainingLetters[0]}`);
    } else {
      setRevealedHint(`Starts with: ${targetWord[0]}`);
    }
    playHitSound();
  };

  const stats = getArcadeStats('word_guess');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={resetGame}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={giveHint}
            disabled={!!revealedHint || isGameOver}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-950/40 border border-violet-800/40 text-xs text-violet-300 hover:bg-violet-900/40 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Hint</span>
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 max-w-md w-full mx-auto select-none">
        {revealedHint && (
          <div className="px-3 py-1 rounded-lg bg-violet-900/40 border border-violet-700/50 text-xs text-violet-200">
            {revealedHint}
          </div>
        )}

        {/* 6x5 Letter Tile Grid */}
        <div className="grid grid-rows-6 gap-1.5 p-3 rounded-2xl bg-[#090e1c] border border-blue-900/40 shadow-2xl">
          {Array.from({ length: 6 }).map((_, rowIdx) => {
            const guess = guesses[rowIdx];
            const isCurrent = rowIdx === guesses.length;

            return (
              <div key={rowIdx} className="grid grid-cols-5 gap-1.5">
                {Array.from({ length: 5 }).map((_, colIdx) => {
                  let char = '';
                  let status = 'empty';

                  if (guess) {
                    char = guess[colIdx];
                    if (targetWord[colIdx] === char) status = 'correct';
                    else if (targetWord.includes(char)) status = 'present';
                    else status = 'absent';
                  } else if (isCurrent) {
                    char = currentGuess[colIdx] || '';
                  }

                  return (
                    <div
                      key={colIdx}
                      className={`w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center font-bold text-lg sm:text-xl font-mono uppercase transition-all ${
                        status === 'correct'
                          ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/40'
                          : status === 'present'
                          ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/40'
                          : status === 'absent'
                          ? 'bg-[#141b2d] text-slate-500 border border-slate-800'
                          : char
                          ? 'bg-[#1b253d] text-slate-100 border border-blue-500/60 scale-105'
                          : 'bg-[#101726] border border-blue-900/30 text-slate-400'
                      }`}
                    >
                      {char}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Virtual Keyboard */}
        <div className="flex flex-col gap-1.5 w-full mt-2">
          {KEYBOARD_ROWS.map((row, rIdx) => (
            <div key={rIdx} className="flex justify-center gap-1 sm:gap-1.5">
              {row.map((key) => {
                const status = letterStatuses[key];
                const isSpecial = key === 'ENTER' || key === 'BACK';

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (key === 'ENTER') handleSubmit();
                      else if (key === 'BACK') handleDelete();
                      else handleChar(key);
                    }}
                    className={`h-11 sm:h-12 rounded-lg font-bold text-xs sm:text-sm transition-all cursor-pointer select-none active:scale-95 ${
                      isSpecial
                        ? 'px-3 sm:px-4 bg-blue-900/40 hover:bg-blue-800 text-blue-200 border border-blue-700/50'
                        : status === 'correct'
                        ? 'flex-1 bg-emerald-600 text-white'
                        : status === 'present'
                        ? 'flex-1 bg-amber-500 text-white'
                        : status === 'absent'
                        ? 'flex-1 bg-[#121828] text-slate-600'
                        : 'flex-1 bg-[#1a233a] hover:bg-[#253252] text-slate-200'
                    }`}
                  >
                    {key === 'ENTER' ? (
                      <span className="flex items-center gap-1">
                        <CornerDownLeft className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Enter</span>
                      </span>
                    ) : key === 'BACK' ? (
                      <Delete className="w-4 h-4" />
                    ) : (
                      key
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Game Over Modal */}
        {isGameOver && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-[#0b1122] border border-violet-600/50 rounded-2xl p-6 text-center max-w-sm w-full shadow-2xl">
              <Trophy
                className={`w-12 h-12 mx-auto mb-3 ${
                  isWon ? 'text-amber-400 animate-bounce' : 'text-slate-500'
                }`}
              />
              <h3 className="text-xl font-bold text-white mb-1">
                {isWon ? 'Magnificent Deduction!' : 'Out of Attempts'}
              </h3>
              <p className="text-xs text-slate-300 mb-2">
                The secret word was:{' '}
                <span className="font-mono font-bold text-emerald-400 text-base">
                  {targetWord}
                </span>
              </p>
              <button
                type="button"
                onClick={resetGame}
                className="w-full py-2.5 mt-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors cursor-pointer shadow-lg shadow-violet-600/30"
              >
                Play Next Word
              </button>
            </div>
          </div>
        )}
      </div>
    </ArcadeGameShell>
  );
};
export default WordGuessGame;
