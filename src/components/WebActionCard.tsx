import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ExternalLink,
  Search,
  Globe,
  Youtube,
  Github,
  Music,
  BookOpen,
  Flame,
  ShoppingBag,
  Film,
  Tv,
  X,
  Sparkles,
  ArrowUpRight,
} from 'lucide-react';
import { WebAction } from '../types';

interface WebActionCardProps {
  action: WebAction | null;
  onDismiss?: () => void;
  isLightMode?: boolean;
}

export const WebActionCard: React.FC<WebActionCardProps> = ({
  action,
  onDismiss,
  isLightMode = false,
}) => {
  if (!action) return null;

  const renderIcon = () => {
    const iconName = action.icon || 'Globe';
    const props = { className: 'w-4 h-4' };

    switch (iconName.toLowerCase()) {
      case 'youtube':
        return <Youtube {...props} className="w-4 h-4 text-red-500" />;
      case 'github':
        return <Github {...props} className="w-4 h-4 text-purple-400" />;
      case 'music':
      case 'spotify':
        return <Music {...props} className="w-4 h-4 text-emerald-400" />;
      case 'bookopen':
      case 'wikipedia':
        return <BookOpen {...props} className="w-4 h-4 text-slate-300" />;
      case 'flame':
      case 'reddit':
        return <Flame {...props} className="w-4 h-4 text-orange-500" />;
      case 'shoppingbag':
      case 'amazon':
        return <ShoppingBag {...props} className="w-4 h-4 text-amber-400" />;
      case 'film':
      case 'netflix':
        return <Film {...props} className="w-4 h-4 text-rose-500" />;
      case 'tv':
      case 'twitch':
        return <Tv {...props} className="w-4 h-4 text-purple-400" />;
      case 'search':
      case 'google':
        return <Search {...props} className="w-4 h-4 text-blue-400" />;
      default:
        return <Globe {...props} className="w-4 h-4 text-blue-400" />;
    }
  };

  const handleLaunch = () => {
    if (typeof window !== 'undefined' && action.url) {
      window.open(action.url, '_blank', 'noopener,noreferrer');
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
        {/* Left icon & summary */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isLightMode
                ? 'bg-slate-100 border border-slate-200/80 shadow-sm'
                : 'bg-[#101833] border border-blue-500/30'
            }`}
          >
            {renderIcon()}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-medium tracking-wide uppercase flex items-center gap-1 text-blue-400">
                <Sparkles className="w-2.5 h-2.5 text-blue-400 animate-pulse" />
                {action.type === 'search_website' ? `Searching on ${action.siteName}` : `Opening ${action.siteName}`}
              </span>
            </div>

            {action.query ? (
              <p
                className={`text-xs font-semibold truncate mt-0.5 ${
                  isLightMode ? 'text-slate-900' : 'text-blue-50'
                }`}
                title={action.query}
              >
                "{action.query}"
              </p>
            ) : (
              <p
                className={`text-[11px] truncate mt-0.5 ${
                  isLightMode ? 'text-slate-500' : 'text-blue-300/70 font-mono'
                }`}
              >
                {action.url.replace(/^https?:\/\//, '')}
              </p>
            )}
          </div>
        </div>

        {/* Right CTA Button & Dismiss */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <a
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleLaunch}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[11px] font-medium bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md hover:shadow-blue-500/25 transition-all cursor-pointer group"
          >
            <span>Launch</span>
            <ArrowUpRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>

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
