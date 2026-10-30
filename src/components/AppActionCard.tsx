import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AppWindow,
  ExternalLink,
  X,
  Sparkles,
  Play,
  Layers,
  Code,
  BookOpen,
  MessageSquare,
  Music,
  Gamepad2,
  Settings,
  Terminal,
} from 'lucide-react';
import { LaptopAppAction } from '../types';
import { getAllLaptopApps, launchLaptopApp } from '../utils/appLauncher';
import { WindowsLogo } from './WindowsLogo';

interface AppActionCardProps {
  action: LaptopAppAction | null;
  onDismiss?: () => void;
  onOpenAppsModal?: () => void;
  isLightMode?: boolean;
}

export const AppActionCard: React.FC<AppActionCardProps> = ({
  action,
  onDismiss,
  onOpenAppsModal,
  isLightMode = false,
}) => {
  if (!action) return null;

  const allApps = getAllLaptopApps();
  const matchedApp = allApps.find(
    (a) =>
      a.name.toLowerCase() === action.appName.toLowerCase() ||
      a.aliases.some((al) => al.toLowerCase() === action.appName.toLowerCase())
  );

  const getCategoryIcon = (category?: string) => {
    switch (category) {
      case 'dev':
        return <Code className="w-4 h-4 text-emerald-400" />;
      case 'productivity':
        return <BookOpen className="w-4 h-4 text-blue-400" />;
      case 'social':
        return <MessageSquare className="w-4 h-4 text-indigo-400" />;
      case 'media':
        return <Music className="w-4 h-4 text-purple-400" />;
      case 'gaming':
        return <Gamepad2 className="w-4 h-4 text-amber-400" />;
      case 'system':
        return <Settings className="w-4 h-4 text-cyan-400" />;
      default:
        return <AppWindow className="w-4 h-4 text-blue-400" />;
    }
  };

  const handleTriggerLaunch = () => {
    if (matchedApp) {
      launchLaptopApp(matchedApp);
    } else if (action.protocol) {
      const anchor = document.createElement('a');
      anchor.href = action.protocol;
      anchor.click();
    } else if (onOpenAppsModal) {
      onOpenAppsModal();
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.96 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={`w-full max-w-xl mx-auto mb-2.5 px-3.5 py-2.5 rounded-2xl backdrop-blur-xl border flex items-center justify-between gap-3 shadow-xl pointer-events-auto transition-all ${
          isLightMode
            ? 'bg-white/95 border-slate-200 text-slate-800 shadow-[0_10px_30px_rgba(0,0,0,0.08)]'
            : 'bg-[#090e1f]/95 border-blue-500/35 text-slate-200 shadow-[0_0_35px_rgba(30,58,138,0.35)]'
        }`}
      >
        {/* Left icon & info */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isLightMode
                ? 'bg-slate-100 border border-slate-200/80 shadow-sm'
                : 'bg-[#101833] border border-blue-500/30'
            }`}
          >
            {getCategoryIcon(matchedApp?.category || action.category)}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-medium tracking-wide uppercase flex items-center gap-1 text-blue-400">
                <Sparkles className="w-2.5 h-2.5 text-blue-400 animate-pulse" />
                {action.type === 'list_apps'
                  ? 'Laptop App Launcher'
                  : `Launching App on Laptop`}
              </span>
            </div>

            <div className="flex items-center gap-2 mt-0.5">
              <p
                className={`text-xs font-semibold truncate ${
                  isLightMode ? 'text-slate-900' : 'text-blue-50'
                }`}
              >
                {matchedApp ? matchedApp.name : action.appName || 'Downloaded App'}
              </p>
              {matchedApp && (
                <span className="text-[10px] text-slate-400 font-mono px-1.5 py-0.2 rounded bg-blue-950/60 border border-blue-800/30">
                  {matchedApp.protocol}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={handleTriggerLaunch}
            id="btn-launch-app-action"
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-[11px] font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md hover:shadow-blue-500/30 transition-all cursor-pointer"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Launch App</span>
          </button>

          {onOpenAppsModal && (
            <button
              type="button"
              onClick={onOpenAppsModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-medium bg-blue-950/60 hover:bg-blue-900/40 text-blue-300 border border-blue-800/30 transition-all cursor-pointer"
              title="Open Windows Start & search apps"
            >
              <WindowsLogo className="w-3.5 h-3.5" />
              <span>Windows Start</span>
            </button>
          )}

          {onDismiss && (
            <button
              onClick={onDismiss}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isLightMode
                  ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/50'
              }`}
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
