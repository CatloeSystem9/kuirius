import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CalendarCheck,
  CheckCircle2,
  Circle,
  Flame,
  Calendar,
  Sparkles,
  X,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { HabitAction } from '../types';

interface HabitActionCardProps {
  action: HabitAction | null;
  onDismiss: () => void;
  onToggleHabit?: (habitId: string) => void;
  onOpenHabitsModal: () => void;
  onAskKrishaCheckIn?: () => void;
  isLightMode?: boolean;
}

export const HabitActionCard: React.FC<HabitActionCardProps> = ({
  action,
  onDismiss,
  onToggleHabit,
  onOpenHabitsModal,
  onAskKrishaCheckIn,
  isLightMode = false,
}) => {
  if (!action) return null;

  const { todayProgress, habits } = action;
  const isAllCompleted = todayProgress.total > 0 && todayProgress.completed === todayProgress.total;

  const categoryColors: Record<string, string> = {
    health: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    productivity: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
    fitness: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    learning: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30',
    mindfulness: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
    routine: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className={`w-full max-w-xl mb-3 rounded-2xl border p-4 shadow-xl backdrop-blur-md transition-all relative overflow-hidden select-none ${
          isLightMode
            ? 'bg-white/95 border-blue-200/90 shadow-[0_12px_32px_rgba(59,130,246,0.15)] text-slate-800'
            : 'bg-[#080d1e]/95 border-blue-500/30 shadow-[0_10px_35px_rgba(0,0,0,0.7)] text-slate-200'
        }`}
      >
        {/* Subtle decorative glowing background blur */}
        <div className="absolute -top-12 -right-12 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-blue-900/30">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500/20 border border-blue-400/40 flex items-center justify-center text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.3)]">
              <CalendarCheck className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold tracking-wider uppercase text-blue-200">
                  Daily Habits & Goals
                </h3>
                {isAllCompleted && (
                  <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <Sparkles className="w-3 h-3 text-emerald-300" /> Complete!
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {action.summary || `${todayProgress.completed} of ${todayProgress.total} completed today`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenHabitsModal}
              title="Open Habits & Calendar"
              className="p-1.5 rounded-lg text-blue-300 hover:text-blue-100 hover:bg-blue-600/20 transition-all text-xs flex items-center gap-1 border border-blue-500/20 cursor-pointer"
            >
              <Calendar className="w-3.5 h-3.5 text-blue-400" />
              <span className="hidden sm:inline text-[11px]">Calendar</span>
            </button>
            <button
              type="button"
              onClick={onDismiss}
              title="Dismiss card"
              className="p-1 text-slate-400 hover:text-slate-200 hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="text-slate-400 font-medium">Today's Progress</span>
            <span className="text-blue-300 font-semibold">{todayProgress.percentage}%</span>
          </div>
          <div className="w-full h-2 rounded-full bg-blue-950/60 border border-blue-900/40 overflow-hidden p-0.5">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(4, todayProgress.percentage)}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              className={`h-full rounded-full transition-all ${
                isAllCompleted
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_10px_#10b981]'
                  : 'bg-gradient-to-r from-blue-500 to-indigo-500 shadow-[0_0_10px_#3b82f6]'
              }`}
            />
          </div>
        </div>

        {/* Interactive Habits List */}
        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 nav-scrollbar">
          {habits.slice(0, 5).map((habit) => {
            const badgeClass =
              categoryColors[habit.category] || 'text-blue-400 bg-blue-500/10 border-blue-500/30';

            return (
              <div
                key={habit.id}
                onClick={() => onToggleHabit && onToggleHabit(habit.id)}
                className={`group flex items-center justify-between px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                  habit.completed
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-slate-300'
                    : 'bg-[#060a17]/70 hover:bg-blue-950/40 border-blue-900/30 text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onToggleHabit) onToggleHabit(habit.id);
                    }}
                    className="shrink-0 transition-transform active:scale-90"
                  >
                    {habit.completed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 fill-emerald-400/20" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-500 group-hover:text-blue-400 transition-colors" />
                    )}
                  </button>
                  <span
                    className={`text-xs truncate font-medium transition-all ${
                      habit.completed
                        ? 'line-through text-slate-400 decoration-emerald-500/50'
                        : 'text-slate-200'
                    }`}
                  >
                    {habit.title}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {habit.streak > 0 && (
                    <span className="flex items-center gap-0.5 text-[10px] text-amber-300/90 font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                      <Flame className="w-3 h-3 text-amber-400 fill-amber-400" />
                      {habit.streak}d
                    </span>
                  )}
                  <span
                    className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeClass}`}
                  >
                    {habit.timeOfDay}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-blue-900/30 text-[11px]">
          {onAskKrishaCheckIn && (
            <button
              type="button"
              onClick={onAskKrishaCheckIn}
              className="flex items-center gap-1.5 text-blue-300 hover:text-blue-100 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-400" />
              <span>Prompt me on goals</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenHabitsModal}
            className="flex items-center gap-1 text-slate-400 hover:text-blue-300 transition-colors ml-auto cursor-pointer font-medium"
          >
            <span>Manage All Habits & Calendar</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
