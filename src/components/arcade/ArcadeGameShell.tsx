import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  RotateCcw,
  Volume2,
  VolumeX,
  HelpCircle,
  Pause,
  Play,
  Trophy,
  X,
} from 'lucide-react';
import { GameMetadata, ArcadeGameStats } from './types';
import { isArcadeMuted, setArcadeMuted, stopAllArcadeAudio } from './arcadeAudio';
import { getArcadeStats } from '../../utils/arcadeStorage';

interface ArcadeGameShellProps {
  metadata: GameMetadata;
  onBack: () => void;
  onRestart: () => void;
  onPauseToggle?: (isPaused: boolean) => void;
  isPaused?: boolean;
  score?: number | string;
  stats?: ArcadeGameStats;
  children: React.ReactNode;
  headerExtras?: React.ReactNode;
}

export const ArcadeGameShell: React.FC<ArcadeGameShellProps> = ({
  metadata,
  onBack,
  onRestart,
  onPauseToggle,
  isPaused = false,
  score,
  stats,
  children,
  headerExtras,
}) => {
  const [muted, setMuted] = useState(isArcadeMuted);
  const [showHelp, setShowHelp] = useState(false);
  const currentStats = stats || getArcadeStats(metadata.id);

  // Stop any audio on unmount
  useEffect(() => {
    return () => {
      stopAllArcadeAudio();
    };
  }, []);

  const toggleSound = () => {
    const next = !muted;
    setMuted(next);
    setArcadeMuted(next);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#070b14] text-slate-100 overflow-hidden relative select-none">
      {/* Top Universal Control Bar */}
      <header className="shrink-0 flex items-center justify-between px-3 sm:px-6 py-2.5 sm:py-3 border-b border-blue-900/30 bg-[#050810]/95 backdrop-blur-md z-30">
        {/* Left: Back & Game Info */}
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <button
            type="button"
            onClick={() => {
              stopAllArcadeAudio();
              onBack();
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs sm:text-sm font-medium text-slate-300 hover:text-white bg-blue-950/40 hover:bg-blue-900/50 border border-blue-800/40 transition-all cursor-pointer group"
            title="Back to Arcade Hub"
          >
            <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" />
            <span className="hidden sm:inline">Hub</span>
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-slate-100 truncate tracking-wide">
              {metadata.title}
            </h2>
            {metadata.badge && (
              <span className="hidden md:inline-flex text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                {metadata.badge}
              </span>
            )}
          </div>
        </div>

        {/* Center: Score / High Score or Custom Extras */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          {headerExtras}

          {score !== undefined && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-950/50 border border-blue-800/30 text-xs sm:text-sm">
              <span className="text-slate-400 font-mono">Score:</span>
              <span className="font-bold text-amber-400 font-mono">{score}</span>
            </div>
          )}

          {currentStats.highScore ? (
            <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-400">
              <Trophy className="w-3.5 h-3.5 text-amber-400" />
              <span>{currentStats.highScore}</span>
            </div>
          ) : null}
        </div>

        {/* Right: Actions (Pause, Restart, Sound, Help) */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {onPauseToggle && (
            <button
              type="button"
              onClick={() => onPauseToggle(!isPaused)}
              className={`p-1.5 sm:p-2 rounded-xl border transition-all cursor-pointer ${
                isPaused
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : 'text-slate-400 hover:text-slate-200 bg-blue-950/30 hover:bg-blue-900/40 border-blue-900/30'
              }`}
              title={isPaused ? 'Resume Game' : 'Pause Game'}
            >
              {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          <button
            type="button"
            onClick={onRestart}
            className="p-1.5 sm:p-2 rounded-xl text-slate-400 hover:text-slate-200 bg-blue-950/30 hover:bg-blue-900/40 border border-blue-900/30 transition-all cursor-pointer group"
            title="Restart Game (R)"
          >
            <RotateCcw className="w-4 h-4 transition-transform group-hover:-rotate-90 duration-300" />
          </button>

          <button
            type="button"
            onClick={toggleSound}
            className={`p-1.5 sm:p-2 rounded-xl border transition-all cursor-pointer ${
              muted
                ? 'text-rose-400 bg-rose-950/30 border-rose-900/40'
                : 'text-slate-400 hover:text-slate-200 bg-blue-950/30 hover:bg-blue-900/40 border-blue-900/30'
            }`}
            title={muted ? 'Unmute Sound' : 'Mute Sound'}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => setShowHelp(true)}
            className="p-1.5 sm:p-2 rounded-xl text-slate-400 hover:text-blue-300 bg-blue-950/30 hover:bg-blue-900/40 border border-blue-900/30 transition-all cursor-pointer"
            title="How to Play"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Game Stage */}
      <main className="flex-1 w-full relative overflow-y-auto overflow-x-hidden flex items-center justify-center p-2 sm:p-4">
        {children}
      </main>

      {/* Instructions Modal Overlay */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md bg-[#0a0f1d] border border-blue-800/40 rounded-2xl shadow-2xl p-5 text-slate-200 relative overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-blue-900/30">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-5 h-5 text-blue-400" />
                <h3 className="font-semibold text-slate-100 text-base">
                  How to Play: {metadata.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-blue-900/30 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-4 space-y-4 max-h-[65vh] overflow-y-auto pr-1 text-sm text-slate-300">
              <div>
                <h4 className="text-xs uppercase tracking-wider font-semibold text-blue-400 mb-2">
                  Rules & Objectives
                </h4>
                <ul className="space-y-1.5">
                  {metadata.instructions.map((step, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-xs sm:text-sm">
                      <span className="w-5 h-5 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center text-[11px] font-mono shrink-0 text-blue-300">
                        {idx + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h4 className="text-xs uppercase tracking-wider font-semibold text-indigo-400 mb-2">
                  Controls
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {metadata.controls.map((ctrl, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 rounded-md bg-blue-950/60 border border-blue-800/30 text-xs text-blue-200"
                    >
                      {ctrl}
                    </span>
                  ))}
                </div>
              </div>

              {currentStats.timesPlayed > 0 && (
                <div className="pt-2 border-t border-blue-900/20 text-xs text-slate-400 flex items-center justify-between">
                  <span>Sessions: {currentStats.timesPlayed}</span>
                  {currentStats.wins !== undefined && (
                    <span>Wins: {currentStats.wins}</span>
                  )}
                  {currentStats.highScore !== undefined && (
                    <span>Best Score: {currentStats.highScore}</span>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors cursor-pointer shadow-lg shadow-blue-600/30"
            >
              Got it, let's play!
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
