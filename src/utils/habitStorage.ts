import { DailyHabit, CalendarEvent, HabitCategory, HabitTimeOfDay, HabitFrequency, HabitAction } from '../types';

const HABITS_STORAGE_KEY = 'krisha_daily_habits_v2';
const CALENDAR_STORAGE_KEY = 'krisha_calendar_events_v2';

// High-quality starter habits tailored for productivity, mindfulness, and wellness with Krisha
export const DEFAULT_HABITS: DailyHabit[] = [
  {
    id: 'habit_water',
    title: 'Morning Hydration (2.5L Water)',
    description: 'Drink a glass of water right after waking up and stay hydrated throughout the day.',
    category: 'health',
    timeOfDay: 'morning',
    targetTime: '08:00',
    frequency: 'daily',
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now() - 86400000 * 3,
    reminderEnabled: true,
  },
  {
    id: 'habit_deep_work',
    title: 'Deep Work & Focus Sprint',
    description: 'Undivided focus on core creative or coding priorities without distractions.',
    category: 'productivity',
    timeOfDay: 'morning',
    targetTime: '10:00',
    frequency: 'weekdays',
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now() - 86400000 * 3,
    reminderEnabled: true,
  },
  {
    id: 'habit_walk_fresh_air',
    title: 'Afternoon Walk & Fresh Air',
    description: 'Step away from screens, stretch, and get natural sunlight and fresh air.',
    category: 'fitness',
    timeOfDay: 'afternoon',
    targetTime: '15:30',
    frequency: 'daily',
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now() - 86400000 * 3,
    reminderEnabled: true,
  },
  {
    id: 'habit_reading_learning',
    title: 'Read 20 Pages & Learn Something New',
    description: 'Read an enriching book, technical paper, or learn a skill.',
    category: 'learning',
    timeOfDay: 'evening',
    targetTime: '19:30',
    frequency: 'daily',
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now() - 86400000 * 3,
    reminderEnabled: true,
  },
  {
    id: 'habit_reflection',
    title: 'Evening Gratitude & Reflection with Krisha',
    description: 'Review achievements, unwind your mind, and check in with Krisha before bed.',
    category: 'mindfulness',
    timeOfDay: 'evening',
    targetTime: '22:00',
    frequency: 'daily',
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now() - 86400000 * 3,
    reminderEnabled: true,
  },
];

/** Return YYYY-MM-DD for any date object in local timezone */
export function formatDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Get today's key string */
export function getTodayDateString(): string {
  return formatDateKey(new Date());
}

/** Calculate current streak and best streak based on completed dates list */
export function calculateStreaks(completedDates: string[]): { streak: number; bestStreak: number } {
  if (!completedDates || completedDates.length === 0) {
    return { streak: 0, bestStreak: 0 };
  }

  const sortedDates = Array.from(new Set(completedDates)).sort();
  const dateSet = new Set(sortedDates);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = formatDateKey(today);
  const yesterdayStr = formatDateKey(yesterday);

  // Check if active streak starts from today or yesterday
  let streak = 0;
  let cursor = new Date(today);

  if (!dateSet.has(todayStr)) {
    if (dateSet.has(yesterdayStr)) {
      cursor = new Date(yesterday);
    } else {
      cursor = null as any;
    }
  }

  if (cursor) {
    while (true) {
      const curStr = formatDateKey(cursor);
      if (dateSet.has(curStr)) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }
  }

  // Calculate historic best streak
  let bestStreak = 0;
  let tempStreak = 0;
  let prevDate: Date | null = null;

  for (const dStr of sortedDates) {
    const [y, m, d] = dStr.split('-').map(Number);
    const curDate = new Date(y, m - 1, d);

    if (!prevDate) {
      tempStreak = 1;
    } else {
      const diffMs = curDate.getTime() - prevDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
    }

    if (tempStreak > bestStreak) {
      bestStreak = tempStreak;
    }
    prevDate = curDate;
  }

  return { streak, bestStreak: Math.max(bestStreak, streak) };
}

/** Load habits from localStorage */
export function loadHabits(): DailyHabit[] {
  try {
    const raw = localStorage.getItem(HABITS_STORAGE_KEY);
    if (!raw) {
      // Seed initial sample completion for yesterday so user sees a live streak right away
      const initialHabits = [...DEFAULT_HABITS];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = formatDateKey(yesterday);

      // Seed 2 completed habits yesterday for an active 1-day streak demo
      initialHabits[0].completedDates = [yesterdayStr];
      initialHabits[0].streak = 1;
      initialHabits[0].bestStreak = 1;
      initialHabits[1].completedDates = [yesterdayStr];
      initialHabits[1].streak = 1;
      initialHabits[1].bestStreak = 1;

      saveHabits(initialHabits);
      return initialHabits;
    }
    const parsed: DailyHabit[] = JSON.parse(raw);
    // Recalculate streaks dynamically to stay accurate with current date
    return parsed.map((h) => {
      const { streak, bestStreak } = calculateStreaks(h.completedDates || []);
      return {
        ...h,
        streak,
        bestStreak: Math.max(h.bestStreak || 0, bestStreak),
      };
    });
  } catch (err) {
    console.warn('Failed to load habits from localStorage:', err);
    return DEFAULT_HABITS;
  }
}

/** Save habits to localStorage */
export function saveHabits(habits: DailyHabit[]): void {
  try {
    localStorage.setItem(HABITS_STORAGE_KEY, JSON.stringify(habits));
  } catch (err) {
    console.warn('Failed to save habits to localStorage:', err);
  }
}

/** Toggle completion of a habit for a given date (defaults to today) */
export function toggleHabitCompletion(
  id: string,
  targetDateStr: string = getTodayDateString(),
  habitsList?: DailyHabit[]
): {
  habits: DailyHabit[];
  updatedHabit: DailyHabit | null;
  wasCompleted: boolean;
} {
  const current = habitsList || loadHabits();
  let wasCompleted = false;
  let updatedHabit: DailyHabit | null = null;

  const nextHabits = current.map((h) => {
    if (h.id !== id) return h;

    const dates = new Set(h.completedDates || []);
    if (dates.has(targetDateStr)) {
      dates.delete(targetDateStr);
      wasCompleted = false;
    } else {
      dates.add(targetDateStr);
      wasCompleted = true;
    }

    const updatedDates = Array.from(dates);
    const { streak, bestStreak } = calculateStreaks(updatedDates);

    updatedHabit = {
      ...h,
      completedDates: updatedDates,
      streak,
      bestStreak: Math.max(h.bestStreak || 0, bestStreak),
    };
    return updatedHabit;
  });

  saveHabits(nextHabits);
  return { habits: nextHabits, updatedHabit, wasCompleted };
}

/** Add a new habit */
export function addHabit(
  habitInput: Omit<DailyHabit, 'id' | 'completedDates' | 'streak' | 'bestStreak' | 'createdAt'>,
  currentHabits?: DailyHabit[]
): { habits: DailyHabit[]; newHabit: DailyHabit } {
  const current = currentHabits || loadHabits();
  const newHabit: DailyHabit = {
    ...habitInput,
    id: `habit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    completedDates: [],
    streak: 0,
    bestStreak: 0,
    createdAt: Date.now(),
  };

  const updated = [newHabit, ...current];
  saveHabits(updated);
  return { habits: updated, newHabit };
}

/** Delete a habit by ID */
export function deleteHabit(id: string, currentHabits?: DailyHabit[]): DailyHabit[] {
  const current = currentHabits || loadHabits();
  const updated = current.filter((h) => h.id !== id);
  saveHabits(updated);
  return updated;
}

/** Update an existing habit */
export function updateHabit(
  id: string,
  patch: Partial<DailyHabit>,
  currentHabits?: DailyHabit[]
): DailyHabit[] {
  const current = currentHabits || loadHabits();
  const updated = current.map((h) => (h.id === id ? { ...h, ...patch } : h));
  saveHabits(updated);
  return updated;
}

/** Load calendar events */
export function loadCalendarEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(CALENDAR_STORAGE_KEY);
    if (!raw) {
      const todayStr = getTodayDateString();
      const defaultEvents: CalendarEvent[] = [
        {
          id: 'evt_sample_1',
          title: 'Daily Habits Review & Krisha Sync',
          date: todayStr,
          time: '18:00',
          category: 'mindfulness',
          completed: false,
          notes: 'Take 5 minutes to review habit consistency and celebrate wins.',
        },
      ];
      saveCalendarEvents(defaultEvents);
      return defaultEvents;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to load calendar events:', err);
    return [];
  }
}

/** Save calendar events */
export function saveCalendarEvents(events: CalendarEvent[]): void {
  try {
    localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(events));
  } catch (err) {
    console.warn('Failed to save calendar events:', err);
  }
}

/** Add a calendar event */
export function addCalendarEvent(
  eventInput: Omit<CalendarEvent, 'id'>,
  currentEvents?: CalendarEvent[]
): CalendarEvent[] {
  const current = currentEvents || loadCalendarEvents();
  const newEvt: CalendarEvent = {
    ...eventInput,
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
  const updated = [...current, newEvt];
  saveCalendarEvents(updated);
  return updated;
}

/** Delete a calendar event */
export function deleteCalendarEvent(id: string, currentEvents?: CalendarEvent[]): CalendarEvent[] {
  const current = currentEvents || loadCalendarEvents();
  const updated = current.filter((e) => e.id !== id);
  saveCalendarEvents(updated);
  return updated;
}

/** Toggle calendar event completed status */
export function toggleCalendarEvent(id: string, currentEvents?: CalendarEvent[]): CalendarEvent[] {
  const current = currentEvents || loadCalendarEvents();
  const updated = current.map((e) => (e.id === id ? { ...e, completed: !e.completed } : e));
  saveCalendarEvents(updated);
  return updated;
}

/** Get a clean structured summary of today's habits */
export function getTodayHabitSummary(
  habits: DailyHabit[],
  todayStr: string = getTodayDateString()
): {
  total: number;
  completed: number;
  pending: number;
  percentage: number;
  completedList: DailyHabit[];
  pendingList: DailyHabit[];
  highestStreak: number;
} {
  const total = habits.length;
  const completedList: DailyHabit[] = [];
  const pendingList: DailyHabit[] = [];

  let highestStreak = 0;

  for (const h of habits) {
    if (h.streak > highestStreak) highestStreak = h.streak;
    const isDone = (h.completedDates || []).includes(todayStr);
    if (isDone) {
      completedList.push(h);
    } else {
      pendingList.push(h);
    }
  }

  const completed = completedList.length;
  const pending = pendingList.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    total,
    completed,
    pending,
    percentage,
    completedList,
    pendingList,
    highestStreak,
  };
}

/** Build HabitAction object for chat cards */
export function buildHabitAction(
  habits: DailyHabit[],
  type: HabitAction['type'] = 'check_in',
  targetHabit?: DailyHabit,
  customSummary?: string
): HabitAction {
  const todayStr = getTodayDateString();
  const summary = getTodayHabitSummary(habits, todayStr);

  return {
    type,
    habitId: targetHabit?.id,
    habitTitle: targetHabit?.title,
    summary:
      customSummary ||
      `Today's Progress: ${summary.completed}/${summary.total} completed (${summary.percentage}%)`,
    todayProgress: {
      completed: summary.completed,
      total: summary.total,
      percentage: summary.percentage,
    },
    habits: habits.map((h) => ({
      id: h.id,
      title: h.title,
      category: h.category,
      timeOfDay: h.timeOfDay,
      targetTime: h.targetTime,
      completed: (h.completedDates || []).includes(todayStr),
      streak: h.streak,
    })),
  };
}

/**
 * Format a rich, concise prompt string for Gemini context so Krisha is fully
 * aware of the user's daily goals, progress today, and upcoming schedule.
 */
export function formatHabitContextForPrompt(
  habits: DailyHabit[],
  events: CalendarEvent[] = []
): string {
  const todayStr = getTodayDateString();
  const now = new Date();
  const hours = now.getHours();
  const timeOfDayGreeting = hours < 12 ? 'morning' : hours < 17 ? 'afternoon' : 'evening';

  const summary = getTodayHabitSummary(habits, todayStr);

  const completedNames =
    summary.completedList.length > 0
      ? summary.completedList.map((h) => `• ${h.title} (🔥 ${h.streak}d streak)`).join('\n  ')
      : 'None completed yet today.';

  const pendingNames =
    summary.pendingList.length > 0
      ? summary.pendingList
          .map((h) => `• ${h.title} [Target: ${h.targetTime || h.timeOfDay}]`)
          .join('\n  ')
      : 'All goals for today completed! 🎉';

  // Events for today or tomorrow
  const todayEvents = events.filter((e) => e.date === todayStr);

  const eventsSummary =
    todayEvents.length > 0
      ? todayEvents.map((e) => `• ${e.time ? `[${e.time}] ` : ''}${e.title}${e.completed ? ' (Completed)' : ''}`).join('\n  ')
      : 'No scheduled events for today.';

  return `Current Date: ${todayStr} (Time of day: ${timeOfDayGreeting}, ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
Overall Progress: ${summary.completed} of ${summary.total} completed (${summary.percentage}%)
Completed Habits Today:
  ${completedNames}
Pending Habits Today:
  ${pendingNames}
Calendar Events for Today:
  ${eventsSummary}
Highest Active Streak: ${summary.highestStreak} consecutive days`;
}

/**
 * Fuzzy match user speech or text against habits.
 * E.g. "I drank water" -> matches "Morning Hydration (2.5L Water)"
 * "did my deep work" -> matches "Deep Work & Focus Sprint"
 * "went for a walk" -> matches "Afternoon Walk & Fresh Air"
 */
export function matchHabitInText(text: string, habits: DailyHabit[]): DailyHabit | null {
  const lower = text.toLowerCase();

  // Keyword rules for common habit phrasing
  const keywordsMap: { pattern: RegExp; keywords: string[] }[] = [
    {
      pattern: /\b(drank|drink|drinking|water|hydrate|hydration|2\.5l|glass of water)\b/i,
      keywords: ['water', 'hydration', 'hydrate'],
    },
    {
      pattern: /\b(deep\s*work|coding|focus|programming|study|studied|sprint)\b/i,
      keywords: ['deep work', 'focus', 'sprint'],
    },
    {
      pattern: /\b(walk|walked|walking|steps|fresh air|stroll|jog|run|workout|gym)\b/i,
      keywords: ['walk', 'fresh air', 'fitness'],
    },
    {
      pattern: /\b(read|reading|book|pages|learn|learned|learning|study)\b/i,
      keywords: ['read', 'learning', 'book'],
    },
    {
      pattern: /\b(reflection|reflect|gratitude|meditation|meditate|mindfulness|unwind)\b/i,
      keywords: ['reflection', 'gratitude', 'meditation'],
    },
  ];

  // 1. Direct title containment check
  for (const h of habits) {
    const hTitleLower = h.title.toLowerCase();
    if (lower.includes(hTitleLower)) return h;

    // Check keywords from title
    const titleWords = hTitleLower.split(/[\s()]+/);
    const significantWords = titleWords.filter((w) => w.length > 3);
    for (const w of significantWords) {
      if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) {
        return h;
      }
    }
  }

  // 2. Pattern map check
  for (const item of keywordsMap) {
    if (item.pattern.test(lower)) {
      const match = habits.find((h) => {
        const hTitle = h.title.toLowerCase();
        return item.keywords.some((kw) => hTitle.includes(kw));
      });
      if (match) return match;
    }
  }

  return null;
}

/** Check if user text indicates asking about habits or goal tracking */
export function isHabitIntent(text: string): boolean {
  return /\b(habits?|daily\s+goals?|daily\s+habits?|goals?|streak|check[\s-]*in|prompt\s+me|track\s+(?:my\s+)?habits?|what\s+are\s+my\s+goals|my\s+routine|routine|habit\s+tracker|how\s+am\s+i\s+doing\s+(?:on\s+my\s+)?(?:goals?|habits?)|progress\s+today)\b/i.test(
    text
  );
}

/** Check if user text indicates calendar intent */
export function isCalendarIntent(text: string): boolean {
  return /\b(calendar|schedule|agenda|events?|what(?:'s|\s+is)\s+scheduled|my\s+calendar|open\s+calendar|show\s+calendar|month\s+view)\b/i.test(
    text
  );
}

/** Check if user is reporting completion of a habit */
export function isHabitCompletionReport(text: string): boolean {
  return (
    /\b(done\s+with|finished|completed|checked\s+off|mark\s+as\s+done|mark\s+done|i\s+did|i\s+drank|i\s+read|i\s+walked|i\s+meditated|i\s+finished|just\s+did|checked)\b/i.test(
      text
    ) &&
    /\b(water|hydration|deep\s+work|coding|walk|steps|reading|book|pages|reflection|meditation|gratitude|habit|goal)\b/i.test(
      text
    )
  );
}
