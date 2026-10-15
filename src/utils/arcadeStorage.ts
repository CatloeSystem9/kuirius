import { GameId, ArcadeGameStats, ArcadeScoresState } from '../components/arcade/types';

const ARCADE_STORAGE_KEY = 'krisha_arcade_stats_v1';

export function getAllArcadeStats(): ArcadeScoresState {
  try {
    const raw = localStorage.getItem(ARCADE_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ArcadeScoresState;
  } catch {
    return {};
  }
}

export function getArcadeStats(gameId: GameId): ArcadeGameStats {
  const all = getAllArcadeStats();
  return (
    all[gameId] || {
      timesPlayed: 0,
      highScore: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      streak: 0,
      bestStreak: 0,
    }
  );
}

export function recordGameResult(
  gameId: GameId,
  updates: {
    won?: boolean;
    loss?: boolean;
    draw?: boolean;
    score?: number;
    timeSeconds?: number;
  }
): ArcadeGameStats {
  const all = getAllArcadeStats();
  const current = all[gameId] || {
    timesPlayed: 0,
    highScore: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
    bestStreak: 0,
  };

  const updated: ArcadeGameStats = {
    ...current,
    timesPlayed: (current.timesPlayed || 0) + 1,
    lastPlayed: Date.now(),
  };

  if (updates.won) {
    updated.wins = (updated.wins || 0) + 1;
    updated.streak = (updated.streak || 0) + 1;
    if (updated.streak > (updated.bestStreak || 0)) {
      updated.bestStreak = updated.streak;
    }
  } else if (updates.loss) {
    updated.losses = (updated.losses || 0) + 1;
    updated.streak = 0;
  } else if (updates.draw) {
    updated.draws = (updated.draws || 0) + 1;
  }

  if (updates.score !== undefined) {
    if (updates.score > (updated.highScore || 0)) {
      updated.highScore = updates.score;
    }
  }

  if (updates.timeSeconds !== undefined) {
    if (
      !updated.bestTimeSeconds ||
      updates.timeSeconds < updated.bestTimeSeconds
    ) {
      updated.bestTimeSeconds = updates.timeSeconds;
    }
  }

  all[gameId] = updated;

  try {
    localStorage.setItem(ARCADE_STORAGE_KEY, JSON.stringify(all));
  } catch (e) {
    console.error('Failed to save arcade stats:', e);
  }

  return updated;
}
