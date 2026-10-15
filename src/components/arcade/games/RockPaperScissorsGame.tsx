import React, { useState, useCallback } from 'react';
import { Trophy, Flame, Swords, RotateCcw } from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { playHitSound, playSuccessSound, playGameOverSound, playMoveSound } from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

type Choice = 'rock' | 'paper' | 'scissors';

const CHOICES: { id: Choice; label: string; icon: string; beats: Choice }[] = [
  { id: 'rock', label: 'Rock', icon: '✊', beats: 'scissors' },
  { id: 'paper', label: 'Paper', icon: '✋', beats: 'rock' },
  { id: 'scissors', label: 'Scissors', icon: '✌️', beats: 'paper' },
];

const KRISHA_QUIPS = {
  win: [
    'Impressive timing, darling!',
    'You saw right through my strategy!',
    'A masterful move!',
    'Touché! You outsmarted me there.',
  ],
  loss: [
    'Hehe, anticipated your instinct!',
    'Krisha takes this round!',
    'Predictable, but I adore your confidence!',
    'My neural weights were one step ahead!',
  ],
  tie: [
    'Great minds truly think alike.',
    'A perfect synchronization!',
    'Evenly matched!',
  ],
};

export const RockPaperScissorsGame: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'rps')!;
  const [playerChoice, setPlayerChoice] = useState<Choice | null>(null);
  const [krishaChoice, setKrishaChoice] = useState<Choice | null>(null);
  const [result, setResult] = useState<'win' | 'loss' | 'tie' | null>(null);
  const [krishaQuip, setKrishaQuip] = useState("Let's see if you can out-predict me!");

  const [playerWins, setPlayerWins] = useState(0);
  const [krishaWins, setKrishaWins] = useState(0);
  const [streak, setStreak] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  // History to allow Krisha's AI to adapt
  const [history, setHistory] = useState<Choice[]>([]);

  const handleChoose = (choice: Choice) => {
    if (isAnimating) return;
    setIsAnimating(true);
    setPlayerChoice(choice);
    playMoveSound();

    // AI choice: 60% probability counter-choice to player's most frequent past move
    let aiPick: Choice;
    if (history.length > 2 && Math.random() < 0.55) {
      const counts: Record<Choice, number> = { rock: 0, paper: 0, scissors: 0 };
      history.forEach((h) => counts[h]++);
      // Player favorite
      const favorite = (Object.keys(counts) as Choice[]).reduce((a, b) =>
        counts[a] > counts[b] ? a : b
      );
      // AI chooses what beats player's favorite
      aiPick = favorite === 'rock' ? 'paper' : favorite === 'paper' ? 'scissors' : 'rock';
    } else {
      aiPick = CHOICES[Math.floor(Math.random() * CHOICES.length)].id;
    }

    setTimeout(() => {
      setKrishaChoice(aiPick);
      setHistory((prev) => [...prev, choice]);

      if (choice === aiPick) {
        setResult('tie');
        playHitSound();
        const quip = KRISHA_QUIPS.tie[Math.floor(Math.random() * KRISHA_QUIPS.tie.length)];
        setKrishaQuip(quip);
        recordGameResult('rps', { draw: true });
      } else if (
        (choice === 'rock' && aiPick === 'scissors') ||
        (choice === 'paper' && aiPick === 'rock') ||
        (choice === 'scissors' && aiPick === 'paper')
      ) {
        setResult('win');
        playSuccessSound();
        setPlayerWins((w) => w + 1);
        setStreak((s) => s + 1);
        const quip = KRISHA_QUIPS.win[Math.floor(Math.random() * KRISHA_QUIPS.win.length)];
        setKrishaQuip(quip);
        recordGameResult('rps', { won: true });
      } else {
        setResult('loss');
        playGameOverSound();
        setKrishaWins((w) => w + 1);
        setStreak(0);
        const quip = KRISHA_QUIPS.loss[Math.floor(Math.random() * KRISHA_QUIPS.loss.length)];
        setKrishaQuip(quip);
        recordGameResult('rps', { loss: true });
      }

      setIsAnimating(false);
    }, 450);
  };

  const handleReset = () => {
    setPlayerChoice(null);
    setKrishaChoice(null);
    setResult(null);
    setPlayerWins(0);
    setKrishaWins(0);
    setStreak(0);
    setHistory([]);
    setKrishaQuip("Reset! Let's start fresh.");
  };

  const stats = getArcadeStats('rps');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={handleReset}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-3 text-xs">
          <span className="font-mono text-emerald-400">You: {playerWins}</span>
          <span className="text-slate-500">|</span>
          <span className="font-mono text-indigo-400">Krisha: {krishaWins}</span>
          {streak > 0 && (
            <div className="flex items-center gap-1 text-amber-400 font-bold">
              <Flame className="w-3.5 h-3.5 fill-amber-400" />
              <span>{streak}</span>
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center gap-6 max-w-xl w-full mx-auto select-none">
        {/* Dialogue Quip Card */}
        <div className="w-full p-4 rounded-2xl bg-[#090e1f] border border-blue-900/30 text-center shadow-lg">
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_6px_#818cf8]" />
            <span className="text-xs uppercase font-bold tracking-wider text-indigo-300">
              Krisha's Presence
            </span>
          </div>
          <p className="text-sm font-medium text-slate-200 italic">
            "{krishaQuip}"
          </p>
        </div>

        {/* Duel Arena */}
        <div className="grid grid-cols-2 gap-4 sm:gap-8 w-full max-w-md">
          {/* Player Hand Card */}
          <div className="flex flex-col items-center gap-2 p-4 rounded-2xl bg-[#0e172e] border-2 border-blue-700/50 shadow-xl">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              You
            </span>
            <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-[#14203d] border border-blue-600/40 flex items-center justify-center text-5xl sm:text-6xl shadow-inner">
              {playerChoice ? (
                CHOICES.find((c) => c.id === playerChoice)?.icon
              ) : (
                <span className="text-slate-600 text-3xl">?</span>
              )}
            </div>
            <span className="text-xs font-mono text-blue-300 capitalize">
              {playerChoice || 'Choose Below'}
            </span>
          </div>

          {/* Krisha Hand Card */}
          <div className="flex flex-col items-center gap-2 p-4 rounded-2xl bg-[#0e172e] border-2 border-indigo-700/50 shadow-xl">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Krisha
            </span>
            <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-[#14203d] border border-indigo-600/40 flex items-center justify-center text-5xl sm:text-6xl shadow-inner">
              {isAnimating ? (
                <span className="text-3xl animate-spin text-indigo-400">🌀</span>
              ) : krishaChoice ? (
                CHOICES.find((c) => c.id === krishaChoice)?.icon
              ) : (
                <span className="text-slate-600 text-3xl">?</span>
              )}
            </div>
            <span className="text-xs font-mono text-indigo-300 capitalize">
              {krishaChoice || 'Thinking...'}
            </span>
          </div>
        </div>

        {/* Outcome Alert */}
        {result && (
          <div
            className={`px-6 py-2 rounded-xl text-sm font-bold border tracking-wide uppercase shadow-lg ${
              result === 'win'
                ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300 shadow-emerald-500/20'
                : result === 'loss'
                ? 'bg-rose-950/60 border-rose-500/60 text-rose-300 shadow-rose-500/20'
                : 'bg-amber-950/60 border-amber-500/60 text-amber-300 shadow-amber-500/20'
            }`}
          >
            {result === 'win' ? 'Victory!' : result === 'loss' ? 'Defeat!' : 'Draw!'}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex justify-center gap-3 w-full max-w-sm mt-2">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={isAnimating}
              onClick={() => handleChoose(c.id)}
              className="flex-1 py-3 px-2 rounded-2xl bg-blue-950/60 hover:bg-blue-900/60 border border-blue-700/50 hover:border-blue-500 flex flex-col items-center gap-1 transition-all cursor-pointer hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              <span className="text-3xl">{c.icon}</span>
              <span className="text-xs font-semibold text-slate-200">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default RockPaperScissorsGame;
