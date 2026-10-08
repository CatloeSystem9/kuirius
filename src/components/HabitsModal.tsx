import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  CalendarCheck,
  CheckCircle2,
  Circle,
  Plus,
  Flame,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  TrendingUp,
  Clock,
  Trash2,
  Edit2,
  AlertCircle,
  Sun,
  Sunset,
  Moon,
  Compass,
  Award,
  CalendarPlus,
} from 'lucide-react';
import { DailyHabit, CalendarEvent, HabitCategory, HabitTimeOfDay, HabitFrequency } from '../types';
import {
  formatDateKey,
  getTodayDateString,
  getTodayHabitSummary,
  calculateStreaks,
} from '../utils/habitStorage';

interface HabitsModalProps {
  isOpen: boolean;
  onClose: () => void;
  habits: DailyHabit[];
  calendarEvents: CalendarEvent[];
  onToggleHabit: (habitId: string, dateStr?: string) => void;
  onAddHabit: (
    habit: Omit<DailyHabit, 'id' | 'completedDates' | 'streak' | 'bestStreak' | 'createdAt'>
  ) => void;
  onDeleteHabit: (habitId: string) => void;
  onAddCalendarEvent: (event: Omit<CalendarEvent, 'id'>) => void;
  onDeleteCalendarEvent: (eventId: string) => void;
  onToggleCalendarEvent: (eventId: string) => void;
  onCheckInWithKrisha: () => void;
}

export const HabitsModal: React.FC<HabitsModalProps> = ({
  isOpen,
  onClose,
  habits,
  calendarEvents,
  onToggleHabit,
  onAddHabit,
  onDeleteHabit,
  onAddCalendarEvent,
  onDeleteCalendarEvent,
  onToggleCalendarEvent,
  onCheckInWithKrisha,
}) => {
  const [activeTab, setActiveTab] = useState<'habits' | 'calendar' | 'streaks'>('habits');
  const [timeFilter, setTimeFilter] = useState<'all' | HabitTimeOfDay>('all');
  const [isAddHabitOpen, setIsAddHabitOpen] = useState(false);
  const [isAddEventOpen, setIsAddEventOpen] = useState(false);

  // Calendar navigation state
  const todayDate = useMemo(() => new Date(), []);
  const [calendarMonth, setCalendarMonth] = useState<Date>(
    new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)
  );
  const [selectedDateStr, setSelectedDateStr] = useState<string>(getTodayDateString());
  const selectedDateObj = useMemo(() => {
    const [y, m, d] = selectedDateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }, [selectedDateStr]);

  // Form states for New Habit
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategory, setNewCategory] = useState<HabitCategory>('productivity');
  const [newTimeOfDay, setNewTimeOfDay] = useState<HabitTimeOfDay>('morning');
  const [newTargetTime, setNewTargetTime] = useState('09:00');
  const [newFrequency, setNewFrequency] = useState<HabitFrequency>('daily');

  // Form states for New Calendar Event
  const [eventTitle, setEventTitle] = useState('');
  const [eventTime, setEventTime] = useState('14:00');
  const [eventNotes, setEventNotes] = useState('');
  const [eventCategory, setEventCategory] = useState<HabitCategory | 'general'>('general');

  const todayStr = getTodayDateString();
  const todaySummary = getTodayHabitSummary(habits, todayStr);

  const categoryStyles: Record<
    HabitCategory,
    { label: string; text: string; bg: string; border: string }
  > = {
    health: {
      label: 'Health & Vitality',
      text: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/30',
    },
    productivity: {
      label: 'Productivity',
      text: 'text-blue-400',
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/30',
    },
    fitness: {
      label: 'Fitness & Activity',
      text: 'text-amber-400',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/30',
    },
    learning: {
      label: 'Learning & Growth',
      text: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/30',
    },
    mindfulness: {
      label: 'Mindfulness',
      text: 'text-purple-400',
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/30',
    },
    routine: {
      label: 'Daily Routine',
      text: 'text-cyan-400',
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/30',
    },
  };

  // Filter habits for Tab 1
  const filteredHabits = habits.filter((h) => {
    if (timeFilter === 'all') return true;
    return h.timeOfDay === timeFilter;
  });

  // Calendar computations
  const currentYear = calendarMonth.getFullYear();
  const currentMonthIdx = calendarMonth.getMonth();
  const monthName = calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

  // First day of month and number of days
  const firstDayOfWeek = new Date(currentYear, currentMonthIdx, 1).getDay(); // 0 is Sunday
  const daysInCurrentMonth = new Date(currentYear, currentMonthIdx + 1, 0).getDate();

  const handlePrevMonth = () => {
    setCalendarMonth(new Date(currentYear, currentMonthIdx - 1, 1));
  };

  const handleNextMonth = () => {
    setCalendarMonth(new Date(currentYear, currentMonthIdx + 1, 1));
  };

  const handleResetToToday = () => {
    setCalendarMonth(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
    setSelectedDateStr(todayStr);
  };

  // Build calendar matrix
  const calendarCells = [];
  // Empty padding cells before 1st day
  for (let i = 0; i < firstDayOfWeek; i++) {
    calendarCells.push(null);
  }
  for (let day = 1; day <= daysInCurrentMonth; day++) {
    const dStr = `${currentYear}-${String(currentMonthIdx + 1).padStart(2, '0')}-${String(
      day
    ).padStart(2, '0')}`;
    calendarCells.push({ day, dateStr: dStr });
  }

  // Selected date details
  const selectedDateHabits = habits.map((h) => ({
    ...h,
    isCompletedOnDate: (h.completedDates || []).includes(selectedDateStr),
  }));

  const selectedDateEvents = calendarEvents.filter((e) => e.date === selectedDateStr);

  const selectedDateFormatted = selectedDateObj.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const handleCreateHabitSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    onAddHabit({
      title: newTitle.trim(),
      description: newDescription.trim() || undefined,
      category: newCategory,
      timeOfDay: newTimeOfDay,
      targetTime: newTargetTime,
      frequency: newFrequency,
      reminderEnabled: true,
    });

    setNewTitle('');
    setNewDescription('');
    setIsAddHabitOpen(false);
  };

  const handleCreateEventSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventTitle.trim()) return;

    onAddCalendarEvent({
      title: eventTitle.trim(),
      date: selectedDateStr,
      time: eventTime,
      category: eventCategory,
      notes: eventNotes.trim() || undefined,
      completed: false,
    });

    setEventTitle('');
    setEventNotes('');
    setIsAddEventOpen(false);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 overflow-hidden">
          {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#020409]/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 14 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="relative w-full max-w-4xl bg-[#060a17] border border-blue-900/40 rounded-3xl shadow-[0_0_60px_rgba(0,0,0,0.85)] flex flex-col max-h-[90vh] z-10 text-slate-200 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/30 bg-[#080d1e]/90 backdrop-blur-md shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                <CalendarCheck className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-wider uppercase text-blue-100">
                    Daily Habits & Calendar
                  </h2>
                  <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                    Interactive
                  </span>
                </div>
                <p className="text-xs text-blue-300/60 mt-0.5">
                  Track routines, maintain streaks, and sync daily goals with Krisha
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCheckInWithKrisha}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-200 border border-blue-500/40 text-xs font-medium transition-all shadow-[0_0_15px_rgba(59,130,246,0.2)] cursor-pointer group"
                title="Krisha will prompt and review your daily goals in chat"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-400 group-hover:scale-110 transition-transform" />
                <span>Check in with Krisha</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                id="close-habits-modal"
                className="p-2 text-slate-400 hover:text-blue-200 hover:bg-blue-950/50 rounded-xl transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Navigation Tabs Bar */}
          <div className="flex items-center justify-between px-6 py-2.5 border-b border-blue-900/20 bg-[#040712] shrink-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('habits')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  activeTab === 'habits'
                    ? 'bg-blue-600/25 text-blue-200 border border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.25)]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/30'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Today's Habits</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-950 text-blue-300 border border-blue-800/40">
                  {todaySummary.completed}/{todaySummary.total}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('calendar')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  activeTab === 'calendar'
                    ? 'bg-blue-600/25 text-blue-200 border border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.25)]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/30'
                }`}
              >
                <CalendarIcon className="w-3.5 h-3.5" />
                <span>Calendar & Schedule</span>
                {selectedDateEvents.length > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('streaks')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  activeTab === 'streaks'
                    ? 'bg-blue-600/25 text-blue-200 border border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.25)]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/30'
                }`}
              >
                <Flame className="w-3.5 h-3.5 text-amber-400" />
                <span>Streaks & Stats</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsAddHabitOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs font-medium transition-all cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Habit</span>
            </button>
          </div>

          {/* Modal Body Container */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5 nav-scrollbar">
            {/* ============================================================== */}
            {/* TAB 1: TODAY'S HABITS */}
            {/* ============================================================== */}
            {activeTab === 'habits' && (
              <div className="space-y-5">
                {/* Daily Progress Banner */}
                <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-blue-950/40 via-indigo-950/20 to-blue-950/30 border border-blue-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                        Today's Progress
                      </span>
                      <span className="text-xs font-semibold text-blue-300">
                        {todaySummary.percentage}%
                      </span>
                    </div>
                    <p className="text-lg font-semibold text-slate-100">
                      {todaySummary.completed === todaySummary.total && todaySummary.total > 0
                        ? '🎉 Incredible! All daily goals completed!'
                        : `${todaySummary.completed} of ${todaySummary.total} completed • ${todaySummary.pending} remaining`}
                    </p>
                    <p className="text-xs text-blue-300/60">
                      Krisha monitors your schedule and can prompt you throughout the day.
                    </p>
                  </div>

                  {/* Progress bar container */}
                  <div className="w-full sm:w-64 space-y-2 shrink-0">
                    <div className="h-2.5 rounded-full bg-slate-900/80 border border-blue-900/40 overflow-hidden p-0.5">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.max(4, todaySummary.percentage)}%` }}
                        transition={{ duration: 0.6, ease: 'easeOut' }}
                        className={`h-full rounded-full transition-all ${
                          todaySummary.percentage === 100
                            ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_#10b981]'
                            : 'bg-gradient-to-r from-blue-500 to-indigo-500 shadow-[0_0_12px_#3b82f6]'
                        }`}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>Streak: 🔥 {todaySummary.highestStreak}d</span>
                      <span>Target: 100%</span>
                    </div>
                  </div>
                </div>

                {/* Time of Day Filter Pills */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {[
                    { id: 'all', label: 'All Goals', icon: Compass },
                    { id: 'morning', label: 'Morning', icon: Sun },
                    { id: 'afternoon', label: 'Afternoon', icon: Sunset },
                    { id: 'evening', label: 'Evening', icon: Moon },
                  ].map((filter) => {
                    const Icon = filter.icon;
                    const isSelected = timeFilter === filter.id;
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        onClick={() => setTimeFilter(filter.id as any)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                          isSelected
                            ? 'bg-blue-600/30 text-blue-100 border border-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.25)]'
                            : 'bg-blue-950/20 text-slate-400 hover:text-slate-200 border border-blue-900/30'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{filter.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Habit Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredHabits.map((habit) => {
                    const isDoneToday = (habit.completedDates || []).includes(todayStr);
                    const catStyle = categoryStyles[habit.category] || categoryStyles.productivity;

                    return (
                      <motion.div
                        key={habit.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`p-4 rounded-2xl border transition-all relative overflow-hidden group select-none ${
                          isDoneToday
                            ? 'bg-emerald-950/20 border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.08)]'
                            : 'bg-[#080d1e]/80 hover:bg-[#0b1228] border-blue-900/30 hover:border-blue-700/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          {/* Checkbox & Details */}
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => onToggleHabit(habit.id, todayStr)}
                              className="mt-0.5 shrink-0 transition-transform active:scale-90 cursor-pointer"
                              title={isDoneToday ? 'Mark incomplete' : 'Mark completed today'}
                            >
                              {isDoneToday ? (
                                <CheckCircle2 className="w-5 h-5 text-emerald-400 fill-emerald-400/20 shadow-[0_0_8px_#10b981]" />
                              ) : (
                                <Circle className="w-5 h-5 text-slate-500 group-hover:text-blue-400 transition-colors" />
                              )}
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span
                                  className={`text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${catStyle.text} ${catStyle.bg} ${catStyle.border}`}
                                >
                                  {catStyle.label}
                                </span>
                                {habit.targetTime && (
                                  <span className="flex items-center gap-1 text-[10px] text-slate-400">
                                    <Clock className="w-3 h-3 text-slate-500" />
                                    {habit.targetTime}
                                  </span>
                                )}
                              </div>

                              <h3
                                className={`text-sm font-semibold transition-all ${
                                  isDoneToday
                                    ? 'line-through text-slate-400 decoration-emerald-500/60'
                                    : 'text-slate-100'
                                }`}
                              >
                                {habit.title}
                              </h3>

                              {habit.description && (
                                <p className="text-xs text-slate-400/80 mt-1 line-clamp-2">
                                  {habit.description}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Streak & Delete */}
                          <div className="flex flex-col items-end gap-2 shrink-0">
                            {habit.streak > 0 && (
                              <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                <Flame className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                                {habit.streak}d
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => onDeleteHabit(habit.id)}
                              className="p-1 text-slate-600 hover:text-rose-400 rounded-lg transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                              title="Delete habit"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Bottom Info Bar */}
                        <div className="mt-3 pt-2.5 border-t border-blue-900/20 flex items-center justify-between text-[11px] text-slate-500">
                          <span className="capitalize">{habit.frequency}</span>
                          <span>
                            Best streak: <span className="text-slate-300 font-medium">{habit.bestStreak}d</span>
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>

                {filteredHabits.length === 0 && (
                  <div className="text-center py-12 border border-dashed border-blue-900/30 rounded-2xl bg-blue-950/10">
                    <CalendarCheck className="w-10 h-10 text-slate-600 mx-auto mb-2" />
                    <p className="text-sm text-slate-400 font-medium">No habits in this category</p>
                    <button
                      type="button"
                      onClick={() => setIsAddHabitOpen(true)}
                      className="mt-3 px-4 py-2 rounded-xl bg-blue-600/30 text-blue-200 border border-blue-500/40 text-xs font-medium cursor-pointer"
                    >
                      Create a Habit
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ============================================================== */}
            {/* TAB 2: INTERACTIVE CALENDAR & SCHEDULE */}
            {/* ============================================================== */}
            {activeTab === 'calendar' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left Column: Full Month Interactive Calendar */}
                  <div className="lg:col-span-7 bg-[#080d1e]/80 border border-blue-900/30 rounded-2xl p-4 sm:p-5 space-y-4">
                    {/* Month Navigator Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CalendarIcon className="w-4 h-4 text-blue-400" />
                        <h3 className="text-sm font-semibold text-slate-100">{monthName}</h3>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handleResetToToday}
                          className="px-2 py-1 rounded-lg text-xs text-blue-300 hover:bg-blue-950/50 border border-blue-900/40 cursor-pointer"
                        >
                          Today
                        </button>
                        <button
                          type="button"
                          onClick={handlePrevMonth}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-blue-950/50 cursor-pointer"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={handleNextMonth}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-blue-950/50 cursor-pointer"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Day-of-Week headers */}
                    <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-slate-500 uppercase tracking-wider">
                      <span>Sun</span>
                      <span>Mon</span>
                      <span>Tue</span>
                      <span>Wed</span>
                      <span>Thu</span>
                      <span>Fri</span>
                      <span>Sat</span>
                    </div>

                    {/* Calendar Days Matrix */}
                    <div className="grid grid-cols-7 gap-1.5">
                      {calendarCells.map((cell, idx) => {
                        if (!cell) {
                          return <div key={`empty_${idx}`} className="h-10 rounded-xl" />;
                        }

                        const isSelected = cell.dateStr === selectedDateStr;
                        const isToday = cell.dateStr === todayStr;

                        // Check habit completions on this date
                        const completedCount = habits.filter((h) =>
                          (h.completedDates || []).includes(cell.dateStr)
                        ).length;
                        const hasCompletions = completedCount > 0;
                        const allDone = hasCompletions && completedCount >= habits.length;

                        // Check calendar events on this date
                        const hasEvents = calendarEvents.some((e) => e.date === cell.dateStr);

                        return (
                          <button
                            key={cell.dateStr}
                            type="button"
                            onClick={() => setSelectedDateStr(cell.dateStr)}
                            className={`h-11 rounded-xl flex flex-col items-center justify-between p-1 transition-all cursor-pointer relative ${
                              isSelected
                                ? 'bg-blue-600/30 border-2 border-blue-400 text-blue-100 shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                                : isToday
                                ? 'bg-blue-950/40 border border-blue-500/50 text-blue-200'
                                : 'bg-[#050812] hover:bg-blue-950/30 border border-blue-900/20 text-slate-300'
                            }`}
                          >
                            <span
                              className={`text-xs font-semibold ${
                                isSelected ? 'text-blue-100' : isToday ? 'text-blue-300' : 'text-slate-300'
                              }`}
                            >
                              {cell.day}
                            </span>

                            {/* Habit & event dots */}
                            <div className="flex items-center gap-1">
                              {hasCompletions && (
                                <span
                                  title={`${completedCount} habits completed`}
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    allDone ? 'bg-emerald-400 shadow-[0_0_5px_#34d399]' : 'bg-blue-400'
                                  }`}
                                />
                              )}
                              {hasEvents && (
                                <span
                                  title="Scheduled event"
                                  className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_4px_#22d3ee]"
                                />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="pt-2 border-t border-blue-900/20 flex items-center justify-between text-[11px] text-slate-500">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          <span>All goals</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-blue-400" />
                          <span>Partial goals</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-cyan-400" />
                          <span>Events</span>
                        </span>
                      </div>
                      <span>Click any date to inspect & log</span>
                    </div>
                  </div>

                  {/* Right Column: Selected Date Log & Schedule Events */}
                  <div className="lg:col-span-5 space-y-4">
                    {/* Selected Date Header */}
                    <div className="bg-[#080d1e]/80 border border-blue-900/30 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[11px] text-blue-400 font-semibold uppercase tracking-wider">
                            Selected Date
                          </p>
                          <h4 className="text-sm font-bold text-slate-100">{selectedDateFormatted}</h4>
                        </div>
                        <button
                          type="button"
                          onClick={() => setIsAddEventOpen(true)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-medium transition-all cursor-pointer"
                        >
                          <CalendarPlus className="w-3.5 h-3.5" />
                          <span>Add Event</span>
                        </button>
                      </div>

                      {/* Habits Log on Selected Date */}
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 nav-scrollbar">
                        <p className="text-[11px] text-slate-400 font-medium">Habits on this day:</p>
                        {selectedDateHabits.map((habit) => (
                          <div
                            key={habit.id}
                            onClick={() => onToggleHabit(habit.id, selectedDateStr)}
                            className={`flex items-center justify-between p-2 rounded-xl border text-xs cursor-pointer transition-all ${
                              habit.isCompletedOnDate
                                ? 'bg-emerald-950/20 border-emerald-500/30 text-slate-200'
                                : 'bg-[#050812] border-blue-900/20 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              {habit.isCompletedOnDate ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              ) : (
                                <Circle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                              )}
                              <span
                                className={`truncate ${
                                  habit.isCompletedOnDate ? 'line-through text-slate-400' : ''
                                }`}
                              >
                                {habit.title}
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-500 shrink-0 ml-2">
                              {habit.targetTime || habit.timeOfDay}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Calendar Events / Schedule Timeline */}
                      <div className="pt-2 border-t border-blue-900/20 space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-400 font-medium">Schedule & Reminders:</span>
                          <span className="text-cyan-400 font-semibold">
                            {selectedDateEvents.length} event{selectedDateEvents.length === 1 ? '' : 's'}
                          </span>
                        </div>

                        {selectedDateEvents.length === 0 ? (
                          <p className="text-xs text-slate-500 italic py-2 text-center">
                            No events scheduled for this date.
                          </p>
                        ) : (
                          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1 nav-scrollbar">
                            {selectedDateEvents.map((evt) => (
                              <div
                                key={evt.id}
                                className={`flex items-start justify-between p-2.5 rounded-xl border text-xs transition-all ${
                                  evt.completed
                                    ? 'bg-blue-950/20 border-blue-900/30 text-slate-400'
                                    : 'bg-[#050812] border-cyan-900/30 text-slate-200'
                                }`}
                              >
                                <div className="flex items-start gap-2 flex-1 min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => onToggleCalendarEvent(evt.id)}
                                    className="mt-0.5 cursor-pointer text-cyan-400"
                                  >
                                    {evt.completed ? (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Circle className="w-3.5 h-3.5 text-slate-500" />
                                    )}
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      {evt.time && (
                                        <span className="text-[10px] text-cyan-300 font-mono bg-cyan-950/40 px-1 rounded border border-cyan-800/30">
                                          {evt.time}
                                        </span>
                                      )}
                                      <span
                                        className={`font-semibold truncate ${
                                          evt.completed ? 'line-through text-slate-500' : ''
                                        }`}
                                      >
                                        {evt.title}
                                      </span>
                                    </div>
                                    {evt.notes && (
                                      <p className="text-[11px] text-slate-400 mt-0.5">{evt.notes}</p>
                                    )}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => onDeleteCalendarEvent(evt.id)}
                                  className="text-slate-600 hover:text-rose-400 p-1 transition-colors cursor-pointer"
                                  title="Delete event"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* TAB 3: STREAKS & INSIGHTS */}
            {/* ============================================================== */}
            {activeTab === 'streaks' && (
              <div className="space-y-6">
                {/* Stats grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                  <div className="p-4 rounded-2xl bg-[#080d1e]/80 border border-blue-900/30 space-y-1">
                    <div className="flex items-center gap-1.5 text-amber-400 text-xs font-medium">
                      <Flame className="w-4 h-4 fill-amber-400" />
                      <span>Best Streak</span>
                    </div>
                    <p className="text-2xl font-bold text-slate-100">
                      {Math.max(...habits.map((h) => h.bestStreak || 0), 0)}
                      <span className="text-xs font-normal text-slate-400 ml-1">days</span>
                    </p>
                    <p className="text-[11px] text-slate-500">Continuous dedication</p>
                  </div>

                  <div className="p-4 rounded-2xl bg-[#080d1e]/80 border border-blue-900/30 space-y-1">
                    <div className="flex items-center gap-1.5 text-blue-400 text-xs font-medium">
                      <TrendingUp className="w-4 h-4" />
                      <span>Today Completion</span>
                    </div>
                    <p className="text-2xl font-bold text-slate-100">{todaySummary.percentage}%</p>
                    <p className="text-[11px] text-slate-500">
                      {todaySummary.completed} of {todaySummary.total} done
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-[#080d1e]/80 border border-blue-900/30 space-y-1">
                    <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-medium">
                      <Award className="w-4 h-4" />
                      <span>Active Habits</span>
                    </div>
                    <p className="text-2xl font-bold text-slate-100">{habits.length}</p>
                    <p className="text-[11px] text-slate-500">Monitored by Krisha</p>
                  </div>

                  <div className="p-4 rounded-2xl bg-[#080d1e]/80 border border-blue-900/30 space-y-1">
                    <div className="flex items-center gap-1.5 text-indigo-400 text-xs font-medium">
                      <CalendarIcon className="w-4 h-4" />
                      <span>Total Check-ins</span>
                    </div>
                    <p className="text-2xl font-bold text-slate-100">
                      {habits.reduce((acc, h) => acc + (h.completedDates?.length || 0), 0)}
                    </p>
                    <p className="text-[11px] text-slate-500">Logged historically</p>
                  </div>
                </div>

                {/* Per-habit streak table */}
                <div className="bg-[#080d1e]/80 border border-blue-900/30 rounded-2xl p-4 sm:p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-100">Consistency Leaderboard</h3>
                  <div className="space-y-2">
                    {habits.map((habit) => {
                      const totalLogged = habit.completedDates?.length || 0;
                      return (
                        <div
                          key={habit.id}
                          className="flex items-center justify-between p-3 rounded-xl bg-[#050812] border border-blue-900/20 text-xs"
                        >
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                              <CalendarCheck className="w-4 h-4" />
                            </div>
                            <div>
                              <p className="font-semibold text-slate-200">{habit.title}</p>
                              <p className="text-[11px] text-slate-400 capitalize">
                                {habit.category} • {habit.frequency}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-4 text-right">
                            <div>
                              <p className="font-semibold text-amber-300 flex items-center justify-end gap-1">
                                <Flame className="w-3.5 h-3.5 fill-amber-400" />
                                {habit.streak}d active
                              </p>
                              <p className="text-[10px] text-slate-500">Best: {habit.bestStreak}d</p>
                            </div>
                            <div className="w-16 text-right">
                              <span className="px-2 py-1 rounded-md bg-blue-950/40 text-blue-300 font-mono text-[11px] border border-blue-900/30">
                                {totalLogged} logs
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ============================================================== */}
          {/* DIALOG: CREATE NEW HABIT */}
          {/* ============================================================== */}
          {isAddHabitOpen && (
            <div className="absolute inset-0 z-20 bg-[#020409]/90 backdrop-blur-md flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-lg bg-[#080d1e] border border-blue-800/40 rounded-2xl p-6 shadow-2xl space-y-4"
              >
                <div className="flex items-center justify-between border-b border-blue-900/30 pb-3">
                  <h3 className="text-sm font-semibold text-blue-100 uppercase tracking-wider">
                    Create New Daily Habit
                  </h3>
                  <button
                    type="button"
                    onClick={() => setIsAddHabitOpen(false)}
                    className="p-1 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleCreateHabitSubmit} className="space-y-3.5 text-xs">
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">Habit Title *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. 30 Minutes of Japanese Practice"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 font-medium mb-1">
                      Description (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="Brief note or motivational prompt"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Category</label>
                      <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value as HabitCategory)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500/50"
                      >
                        <option value="productivity">Productivity</option>
                        <option value="health">Health & Hydration</option>
                        <option value="fitness">Fitness & Exercise</option>
                        <option value="learning">Learning & Books</option>
                        <option value="mindfulness">Mindfulness</option>
                        <option value="routine">Routine</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Time of Day</label>
                      <select
                        value={newTimeOfDay}
                        onChange={(e) => setNewTimeOfDay(e.target.value as HabitTimeOfDay)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500/50"
                      >
                        <option value="morning">Morning (☀️)</option>
                        <option value="afternoon">Afternoon (🌤️)</option>
                        <option value="evening">Evening (🌙)</option>
                        <option value="anytime">Anytime</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Target Time</label>
                      <input
                        type="time"
                        value={newTargetTime}
                        onChange={(e) => setNewTargetTime(e.target.value)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500/50"
                      >
                      </input>
                    </div>

                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Frequency</label>
                      <select
                        value={newFrequency}
                        onChange={(e) => setNewFrequency(e.target.value as HabitFrequency)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500/50"
                      >
                        <option value="daily">Every Day</option>
                        <option value="weekdays">Weekdays Only</option>
                        <option value="weekends">Weekends Only</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-blue-900/30">
                    <button
                      type="button"
                      onClick={() => setIsAddHabitOpen(false)}
                      className="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-[0_0_12px_rgba(59,130,246,0.3)] cursor-pointer"
                    >
                      Save Habit
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}

          {/* ============================================================== */}
          {/* DIALOG: CREATE CALENDAR EVENT */}
          {/* ============================================================== */}
          {isAddEventOpen && (
            <div className="absolute inset-0 z-20 bg-[#020409]/90 backdrop-blur-md flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-lg bg-[#080d1e] border border-cyan-800/40 rounded-2xl p-6 shadow-2xl space-y-4"
              >
                <div className="flex items-center justify-between border-b border-blue-900/30 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-cyan-200 uppercase tracking-wider">
                      Schedule Event / Reminder
                    </h3>
                    <p className="text-[11px] text-slate-400">{selectedDateFormatted}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsAddEventOpen(false)}
                    className="p-1 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleCreateEventSubmit} className="space-y-3.5 text-xs">
                  <div>
                    <label className="block text-slate-400 font-medium mb-1">Event Title *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Afternoon Sync / Focus Session"
                      value={eventTitle}
                      onChange={(e) => setEventTitle(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Time</label>
                      <input
                        type="time"
                        value={eventTime}
                        onChange={(e) => setEventTime(e.target.value)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 font-medium mb-1">Category</label>
                      <select
                        value={eventCategory}
                        onChange={(e) => setEventCategory(e.target.value as any)}
                        className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500/50"
                      >
                        <option value="general">General</option>
                        <option value="productivity">Productivity</option>
                        <option value="health">Health</option>
                        <option value="mindfulness">Mindfulness</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 font-medium mb-1">Notes</label>
                    <input
                      type="text"
                      placeholder="Optional notes or reminder text"
                      value={eventNotes}
                      onChange={(e) => setEventNotes(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/40 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-blue-900/30">
                    <button
                      type="button"
                      onClick={() => setIsAddEventOpen(false)}
                      className="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-medium shadow-[0_0_12px_rgba(6,182,212,0.3)] cursor-pointer"
                    >
                      Save Event
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </motion.div>
      </div>
      )}
    </AnimatePresence>
  );
};
