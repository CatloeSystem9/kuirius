export type GameId =
  | 'chess'
  | 'word_search'
  | 'battleship'
  | 'platformer'
  | 'snake'
  | 'word_guess'
  | 'reaction_test'
  | 'rps'
  | 'simon_says'
  | 'tangram'
  | 'sudoku';

export type GameCategory = 'all' | 'featured' | 'strategy' | 'word_logic' | 'action_reflex';

export type DifficultyLevel = 'easy' | 'medium' | 'hard';

export interface GameMetadata {
  id: GameId;
  title: string;
  category: 'strategy' | 'word_logic' | 'action_reflex';
  badge?: string;
  shortDescription: string;
  fullDescription: string;
  instructions: string[];
  controls: string[];
  iconName: string;
  accentColor: string; // Tailwind color class or hex
  isFeatured?: boolean;
}

export interface ArcadeGameStats {
  timesPlayed: number;
  highScore?: number;
  bestTimeSeconds?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  streak?: number;
  bestStreak?: number;
  lastPlayed?: number;
}

export interface ArcadeScoresState {
  [gameId: string]: ArcadeGameStats;
}
