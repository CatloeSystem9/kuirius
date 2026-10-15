import React, { useState, Suspense, lazy } from 'react';
import {
  Gamepad2,
  X,
  Search,
  Crown,
  Ship,
  Zap,
  Flame,
  Sparkles,
  Timer,
  Hand,
  Music,
  Shapes,
  Grid3x3,
  Play,
  Volume2,
  VolumeX,
  Trophy,
  Swords,
  ChevronRight,
} from 'lucide-react';
import { GameId, GameCategory, DifficultyLevel } from './types';
import { ARCADE_GAMES } from './arcadeRegistry';
import { getAllArcadeStats } from '../../utils/arcadeStorage';
import { isArcadeMuted, setArcadeMuted } from './arcadeAudio';

// Lazy load each game component to ensure lightweight initial bundle
const ChessGame = lazy(() => import('./games/ChessGame'));
const WordSearchGame = lazy(() => import('./games/WordSearchGame'));
const BattleshipGame = lazy(() => import('./games/BattleshipGame'));
const PlatformerGame = lazy(() => import('./games/PlatformerGame'));
const SnakeGame = lazy(() => import('./games/SnakeGame'));
const WordGuessGame = lazy(() => import('./games/WordGuessGame'));
const ReactionTestGame = lazy(() => import('./games/ReactionTestGame'));
const RockPaperScissorsGame = lazy(() => import('./games/RockPaperScissorsGame'));
const SimonSaysGame = lazy(() => import('./games/SimonSaysGame'));
const TangramGame = lazy(() => import('./games/TangramGame'));
const SudokuGame = lazy(() => import('./games/SudokuGame'));

const GAME_ICONS: Record<string, React.FC<{ className?: string }>> = {
  Crown,
  Search,
  Ship,
  Zap,
  Flame,
  Sparkles,
  Timer,
  Hand,
  Music,
  Shapes,
  Grid3x3,
};

interface ArcadeModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialGameId?: GameId | null;
}

export const ArcadeModal: React.FC<ArcadeModalProps> = ({
  isOpen,
  onClose,
  initialGameId = null,
}) => {
  const [activeGameId, setActiveGameId] = useState<GameId | null>(initialGameId);
  const [chessDifficulty, setChessDifficulty] = useState<DifficultyLevel>('medium');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<GameCategory>('all');
  const [isMuted, setIsMutedState] = useState(isArcadeMuted);

  const stats = getAllArcadeStats();

  if (!isOpen) return null;

  const toggleSound = () => {
    const next = !isMuted;
    setIsMutedState(next);
    setArcadeMuted(next);
  };

  const filteredGames = ARCADE_GAMES.filter((g) => {
    const matchesSearch =
      g.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.shortDescription.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      selectedCategory === 'all' ||
      (selectedCategory === 'featured' && g.isFeatured) ||
      g.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const featuredChess = ARCADE_GAMES.find((g) => g.id === 'chess')!;
  const chessStats = stats['chess'] || { timesPlayed: 0, wins: 0 };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/85 backdrop-blur-md animate-in fade-in duration-200 overflow-hidden select-none">
      <div className="w-full max-w-5xl h-[92vh] max-h-[860px] bg-[#070b16] border border-blue-900/40 rounded-3xl shadow-2xl flex flex-col overflow-hidden text-slate-100 relative">
        {/* If a game is actively running, render it inside lazy Suspense */}
        {activeGameId ? (
          <Suspense
            fallback={
              <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-[#050810] text-slate-300">
                <Gamepad2 className="w-10 h-10 text-indigo-400 animate-spin" />
                <span className="text-sm font-medium">Launching {activeGameId}...</span>
              </div>
            }
          >
            {activeGameId === 'chess' && (
              <ChessGame
                onBack={() => setActiveGameId(null)}
                initialDifficulty={chessDifficulty}
              />
            )}
            {activeGameId === 'word_search' && (
              <WordSearchGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'battleship' && (
              <BattleshipGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'platformer' && (
              <PlatformerGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'snake' && (
              <SnakeGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'word_guess' && (
              <WordGuessGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'reaction_test' && (
              <ReactionTestGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'rps' && (
              <RockPaperScissorsGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'simon_says' && (
              <SimonSaysGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'tangram' && (
              <TangramGame onBack={() => setActiveGameId(null)} />
            )}
            {activeGameId === 'sudoku' && (
              <SudokuGame onBack={() => setActiveGameId(null)} />
            )}
          </Suspense>
        ) : (
          /* Arcade Selection Screen */
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Header */}
            <header className="shrink-0 flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-blue-900/30 bg-[#050810]/95 backdrop-blur-md z-10">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.3)]">
                  <Gamepad2 className="w-5 h-5" />
                </div>
                <div>
                  <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
                    Krix Arcade
                    <span className="text-[11px] font-normal text-slate-400 font-mono">
                      (11 Games)
                    </span>
                  </h1>
                </div>
              </div>

              {/* Controls (Search, Sound, Close) */}
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-950/40 border border-blue-900/30 text-xs text-slate-300">
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search games..."
                    className="bg-transparent border-none outline-none text-xs text-slate-200 placeholder-slate-500 w-28 md:w-36"
                  />
                </div>

                <button
                  type="button"
                  onClick={toggleSound}
                  className="p-2 rounded-xl text-slate-400 hover:text-slate-200 bg-blue-950/30 hover:bg-blue-900/40 border border-blue-900/30 transition-colors cursor-pointer"
                  title={isMuted ? 'Unmute Sound' : 'Mute Sound'}
                >
                  {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-xl text-slate-400 hover:text-white bg-blue-950/40 hover:bg-blue-900/50 border border-blue-800/40 transition-colors cursor-pointer"
                  title="Close Arcade (Return to Krisha)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </header>

            {/* Category Filter Bar */}
            <div className="shrink-0 flex items-center gap-1.5 px-4 sm:px-6 py-2.5 border-b border-blue-950 bg-[#060a16] overflow-x-auto nav-scrollbar">
              {[
                { id: 'all', label: 'All Games (11)' },
                { id: 'strategy', label: 'Strategy' },
                { id: 'word_logic', label: 'Word & Logic' },
                { id: 'action_reflex', label: 'Action & Reflex' },
              ].map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id as GameCategory)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                    selectedCategory === cat.id
                      ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/40'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Scrollable Games Catalog */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-6">
              {/* 1. SPECIAL FEATURED CHESS SECTION (Section 3 Requirement) */}
              {selectedCategory === 'all' && searchQuery === '' && (
                <section className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#0b1329] via-[#0d1633] to-[#0a1024] border-2 border-indigo-500/40 shadow-xl shadow-indigo-950/30 p-4 sm:p-6">
                  <div className="flex flex-col md:flex-row items-center justify-between gap-5">
                    {/* Left details */}
                    <div className="space-y-3 max-w-lg">
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded-md bg-indigo-500/25 border border-indigo-400/40 text-indigo-300 text-[10px] font-bold uppercase tracking-wider">
                          Featured Masterpiece
                        </span>
                        <span className="text-xs text-slate-400">Tournament Rules · Local AI</span>
                      </div>

                      <div>
                        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                          Chess with Krisha
                        </h2>
                        <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed">
                          Challenge Krisha in a timeless game of strategy. Test your tactical mind against an intelligent local opponent with legal move validation, castling, and pawn promotion.
                        </p>
                      </div>

                      {/* Difficulty Selection */}
                      <div className="flex items-center gap-2 pt-1">
                        <span className="text-xs text-slate-400 font-medium">Strength:</span>
                        <div className="flex items-center p-0.5 rounded-lg bg-blue-950/80 border border-blue-900/60 text-xs">
                          {(['easy', 'medium', 'hard'] as DifficultyLevel[]).map((lvl) => (
                            <button
                              key={lvl}
                              type="button"
                              onClick={() => setChessDifficulty(lvl)}
                              className={`px-3 py-1 rounded-md capitalize font-semibold transition-all cursor-pointer ${
                                chessDifficulty === lvl
                                  ? 'bg-indigo-600 text-white shadow-sm'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {lvl}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Play Button */}
                      <div className="flex items-center gap-3 pt-2">
                        <button
                          type="button"
                          onClick={() => setActiveGameId('chess')}
                          className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition-all shadow-lg shadow-indigo-600/30 hover:scale-[1.02] active:scale-95 cursor-pointer"
                        >
                          <Play className="w-4 h-4 fill-white" />
                          <span>Play Chess</span>
                        </button>

                        {chessStats.timesPlayed > 0 && (
                          <div className="text-xs text-slate-400 font-mono">
                            {chessStats.wins} Wins / {chessStats.timesPlayed} Matches
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right visual preview board */}
                    <div
                      onClick={() => setActiveGameId('chess')}
                      className="shrink-0 p-3 rounded-xl bg-[#090e1f] border border-indigo-500/30 shadow-lg cursor-pointer group hover:border-indigo-400 transition-all"
                      title="Click to play Chess"
                    >
                      <div className="grid grid-cols-4 grid-rows-4 w-32 h-32 sm:w-36 sm:h-36 rounded-lg overflow-hidden border border-indigo-900/40">
                        {['♜', '♞', '♝', '♛', '♟', '♟', '♟', '♟', '.', '.', '♘', '.', '♙', '♙', '♙', '♔'].map(
                          (piece, i) => {
                            const isLight = (Math.floor(i / 4) + (i % 4)) % 2 === 0;
                            return (
                              <div
                                key={i}
                                className={`flex items-center justify-center text-lg sm:text-xl font-serif ${
                                  isLight ? 'bg-[#1b253b]' : 'bg-[#0f172a]'
                                } ${piece !== '.' ? 'text-indigo-300' : 'text-transparent'}`}
                              >
                                {piece}
                              </div>
                            );
                          }
                        )}
                      </div>
                      <span className="block text-center text-[10px] text-indigo-300 mt-2 font-mono group-hover:text-white transition-colors">
                        Launch Chess Board →
                      </span>
                    </div>
                  </div>
                </section>
              )}

              {/* 2. COMPLETE GAMES GRID (All 11 Games) */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs uppercase font-bold tracking-wider text-slate-400">
                    Arcade Collection ({filteredGames.length})
                  </h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  {filteredGames.map((game) => {
                    const IconComponent = GAME_ICONS[game.iconName] || Gamepad2;
                    const gameStat = stats[game.id];

                    return (
                      <div
                        key={game.id}
                        className="group flex flex-col justify-between p-4 rounded-2xl bg-[#090e1d] border border-blue-900/30 hover:border-blue-700/60 hover:bg-[#0c1326] transition-all shadow-md hover:shadow-xl hover:-translate-y-0.5"
                      >
                        <div className="space-y-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="w-10 h-10 rounded-xl bg-blue-950/60 border border-blue-800/40 flex items-center justify-center text-blue-400 group-hover:text-white group-hover:bg-blue-600 transition-all shadow-sm">
                              <IconComponent className="w-5 h-5" />
                            </div>

                            <span className="text-[10px] font-medium text-slate-400 capitalize">
                              {game.category.replace('_', ' ')}
                            </span>
                          </div>

                          <div>
                            <h4 className="text-sm sm:text-base font-bold text-white group-hover:text-blue-300 transition-colors">
                              {game.title}
                            </h4>
                            <p className="text-xs text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                              {game.shortDescription}
                            </p>
                          </div>
                        </div>

                        {/* Bottom stats & play trigger */}
                        <div className="pt-3 mt-3 border-t border-blue-950 flex items-center justify-between">
                          <div className="text-[11px] text-slate-500 font-mono">
                            {gameStat?.highScore ? (
                              <span className="text-amber-400 font-semibold">
                                Best: {gameStat.highScore}
                              </span>
                            ) : gameStat?.wins ? (
                              <span className="text-emerald-400 font-semibold">
                                {gameStat.wins} Wins
                              </span>
                            ) : (
                              <span>Ready to play</span>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setActiveGameId(game.id)}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-950/70 hover:bg-blue-600 text-blue-200 hover:text-white border border-blue-800/40 text-xs font-semibold transition-all cursor-pointer group-hover:border-blue-500"
                          >
                            <span>Play</span>
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
export default ArcadeModal;
