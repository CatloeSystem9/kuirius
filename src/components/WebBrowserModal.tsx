import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Globe,
  X,
  Search,
  ExternalLink,
  Youtube,
  Music,
  Tv,
  Film,
  Sparkles,
  BookOpen,
  Github,
  Flame,
  ShoppingBag,
  Camera,
  Play,
  Copy,
  Check,
  Compass,
} from 'lucide-react';
import { SUPPORTED_PLATFORMS, WebPlatformInfo, openExternalUrl } from '../utils/webActions';
import { WebAction } from '../types';

interface WebBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeAction?: WebAction | null;
  onLaunchWebsite?: (action: WebAction) => void;
  isLightMode?: boolean;
}

export const WebBrowserModal: React.FC<WebBrowserModalProps> = ({
  isOpen,
  onClose,
  activeAction,
  onLaunchWebsite,
  isLightMode = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [activeEmbedUrl, setActiveEmbedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (activeAction?.url) {
      if (activeAction.siteName.toLowerCase().includes('youtube')) {
        const query = activeAction.query || 'lofi hip hop anime';
        setActiveEmbedUrl(`https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(query)}`);
      } else {
        setActiveEmbedUrl(null);
      }
    }
  }, [activeAction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const categories = [
    { id: 'all', label: 'All Services' },
    { id: 'video', label: 'Video & Streaming' },
    { id: 'music', label: 'Music & Audio' },
    { id: 'search', label: 'Search & AI' },
    { id: 'social', label: 'Social & Discussion' },
    { id: 'knowledge', label: 'Knowledge & Code' },
  ];

  const filteredPlatforms = SUPPORTED_PLATFORMS.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.aliases.some((a) => a.includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;
    if (selectedCategory === 'all') return true;
    if (selectedCategory === 'video') return p.category === 'video' || p.category === 'streaming';
    if (selectedCategory === 'music') return p.category === 'music';
    if (selectedCategory === 'search') return p.category === 'search' || p.category === 'ai';
    if (selectedCategory === 'social') return p.category === 'social';
    if (selectedCategory === 'knowledge') return p.category === 'knowledge' || p.category === 'code';
    return true;
  });

  const handleOpenPlatform = (platform: WebPlatformInfo) => {
    const url = platform.baseUrl;
    const action: WebAction = {
      type: 'open_website',
      siteName: platform.name,
      url,
      icon: platform.icon,
      category: platform.category,
    };
    openExternalUrl(url);
    if (onLaunchWebsite) onLaunchWebsite(action);
  };

  const handleCustomLaunch = (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    let targetUrl = query;
    let siteName = 'Custom Website';

    if (/^https?:\/\//i.test(query)) {
      targetUrl = query;
      try {
        siteName = new URL(query).hostname.replace(/^www\./, '');
      } catch {
        siteName = 'Website';
      }
    } else if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/i.test(query)) {
      targetUrl = `https://${query}`;
      siteName = query.split('.')[0];
    } else {
      // Default to Google search or YouTube search if query mentions video/music
      const isVideo = /\b(video|song|music|watch|youtube|trailer|stream)\b/i.test(query);
      if (isVideo) {
        targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        siteName = 'YouTube';
      } else {
        targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        siteName = 'Google';
      }
    }

    const action: WebAction = {
      type: 'open_website',
      siteName: siteName.charAt(0).toUpperCase() + siteName.slice(1),
      url: targetUrl,
      icon: 'Globe',
    };

    openExternalUrl(targetUrl);
    if (onLaunchWebsite) onLaunchWebsite(action);
  };

  const handleCopyLink = (url: string) => {
    navigator.clipboard?.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const renderPlatformIcon = (iconName: string, color?: string) => {
    const props = { className: 'w-5 h-5' };
    switch (iconName.toLowerCase()) {
      case 'youtube':
        return <Youtube {...props} className="w-5 h-5 text-red-500" />;
      case 'spotify':
      case 'music':
        return <Music {...props} className="w-5 h-5 text-emerald-400" />;
      case 'github':
        return <Github {...props} className="w-5 h-5 text-purple-400" />;
      case 'search':
        return <Search {...props} className="w-5 h-5 text-blue-400" />;
      case 'bookopen':
        return <BookOpen {...props} className="w-5 h-5 text-slate-300" />;
      case 'flame':
        return <Flame {...props} className="w-5 h-5 text-orange-500" />;
      case 'film':
        return <Film {...props} className="w-5 h-5 text-rose-500" />;
      case 'tv':
        return <Tv {...props} className="w-5 h-5 text-purple-400" />;
      case 'sparkles':
        return <Sparkles {...props} className="w-5 h-5 text-emerald-400" />;
      case 'camera':
        return <Camera {...props} className="w-5 h-5 text-pink-500" />;
      case 'shoppingbag':
        return <ShoppingBag {...props} className="w-5 h-5 text-amber-400" />;
      default:
        return <Globe {...props} className="w-5 h-5 text-blue-400" />;
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/75 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={`w-full max-w-3xl max-h-[90vh] flex flex-col rounded-3xl border shadow-2xl overflow-hidden backdrop-blur-xl ${
            isLightMode
              ? 'bg-white/95 border-slate-200 text-slate-900 shadow-[0_25px_60px_rgba(0,0,0,0.15)]'
              : 'bg-[#080d1e]/95 border-blue-500/30 text-slate-100 shadow-[0_0_50px_rgba(30,58,138,0.4)]'
          }`}
        >
          {/* Header */}
          <div
            className={`px-5 py-4 flex items-center justify-between border-b ${
              isLightMode ? 'border-slate-200/80 bg-slate-50/50' : 'border-blue-900/30 bg-[#060a16]/60'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-2xl flex items-center justify-center border shadow-sm ${
                  isLightMode
                    ? 'bg-red-50 border-red-200 text-red-600'
                    : 'bg-red-500/15 border-red-500/30 text-red-400'
                }`}
              >
                <Youtube className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold tracking-tight">Web & Media Launcher</h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30">
                    Direct Launch
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Open YouTube, streaming sites, search engines, or any custom URL
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                isLightMode
                  ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search & URL Input Bar */}
          <div className="p-4 border-b border-blue-900/20">
            <form onSubmit={handleCustomLaunch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Enter website (e.g. youtube.com, google.com) or search term..."
                  className={`w-full pl-10 pr-4 py-2.5 rounded-2xl text-xs sm:text-sm border outline-none transition-all ${
                    isLightMode
                      ? 'bg-slate-100 border-slate-200 text-slate-900 focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'
                      : 'bg-[#0e162f] border-blue-500/30 text-slate-100 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20'
                  }`}
                />
              </div>

              <button
                type="submit"
                className="px-4 py-2.5 rounded-2xl text-xs sm:text-sm font-medium bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md hover:shadow-blue-500/25 flex items-center gap-1.5 transition-all cursor-pointer shrink-0"
              >
                <span>Launch</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </form>

            {/* Category Filter Pills */}
            <div className="flex items-center gap-1.5 mt-3 overflow-x-auto pb-1 scrollbar-none">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                    selectedCategory === cat.id
                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40 shadow-sm'
                      : isLightMode
                      ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-transparent'
                      : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
            {/* Active / Featured YouTube Player Preview */}
            <div
              className={`p-4 rounded-2xl border ${
                isLightMode
                  ? 'bg-gradient-to-br from-red-50/70 to-slate-50 border-red-200/60'
                  : 'bg-gradient-to-br from-red-950/25 to-[#0b1022] border-red-500/30 shadow-lg'
              }`}
            >
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-red-500 flex items-center justify-center text-white shadow-md shadow-red-500/30">
                    <Play className="w-3.5 h-3.5 fill-white" />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-red-400 uppercase tracking-wider">
                      YouTube Integration
                    </h4>
                    <p className="text-xs font-medium text-slate-200">
                      {activeAction?.query
                        ? `Search Results for: "${activeAction.query}"`
                        : 'Watch and listen to videos, music, or streams'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={
                      activeAction?.siteName.toLowerCase().includes('youtube') && activeAction.url
                        ? activeAction.url
                        : 'https://www.youtube.com'
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-xl text-xs font-medium bg-red-600 hover:bg-red-500 text-white shadow-md shadow-red-600/30 flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <span>Open YouTube</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              {/* Embedded Player */}
              <div className="rounded-xl overflow-hidden border border-red-500/30 shadow-inner bg-black h-48 sm:h-64 w-full">
                <iframe
                  title="YouTube Player Preview"
                  src={
                    activeEmbedUrl ||
                    'https://www.youtube-nocookie.com/embed?listType=search&list=lofi%20hip%20hop%20radio'
                  }
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>

              <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
                <span className="flex items-center gap-1 text-slate-400">
                  <Compass className="w-3 h-3 text-red-400" />
                  Direct video search & playback embedded safely
                </span>
                <span className="text-red-400/80 font-mono">youtube.com</span>
              </div>
            </div>

            {/* Popular Websites & Platforms Grid */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Available Websites & Services ({filteredPlatforms.length})
                </h4>
                <span className="text-[11px] text-slate-500">Click any card to launch</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {filteredPlatforms.map((platform) => (
                  <div
                    key={platform.id}
                    className={`group p-3 rounded-2xl border transition-all flex flex-col justify-between ${
                      isLightMode
                        ? 'bg-slate-50/80 hover:bg-white border-slate-200/80 hover:border-blue-400 hover:shadow-md'
                        : 'bg-[#0b1022]/80 hover:bg-[#111936] border-blue-900/30 hover:border-blue-500/50 hover:shadow-[0_0_20px_rgba(59,130,246,0.15)]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                              isLightMode
                                ? 'bg-white border border-slate-200 shadow-sm'
                                : 'bg-[#141f3d] border border-blue-500/30'
                            }`}
                          >
                            {renderPlatformIcon(platform.icon, platform.color)}
                          </div>
                          <div className="min-w-0">
                            <h5 className="text-xs font-semibold truncate group-hover:text-blue-400 transition-colors">
                              {platform.name}
                            </h5>
                            <span className="text-[10px] text-slate-400 font-mono block truncate">
                              {platform.baseUrl.replace(/^https?:\/\//, '')}
                            </span>
                          </div>
                        </div>

                        <button
                          onClick={() => handleCopyLink(platform.baseUrl)}
                          className="p-1 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors cursor-pointer"
                          title="Copy Link"
                        >
                          {copiedUrl === platform.baseUrl ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-3">
                        {platform.description}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 pt-2 border-t border-white/5">
                      <a
                        href={platform.baseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => handleOpenPlatform(platform)}
                        className="flex-1 py-1.5 px-3 rounded-xl text-xs font-medium text-center bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      >
                        <span>Open {platform.name}</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer Info */}
          <div
            className={`px-5 py-3 border-t text-[11px] flex items-center justify-between ${
              isLightMode
                ? 'border-slate-200 bg-slate-50 text-slate-500'
                : 'border-blue-900/30 bg-[#060a16] text-slate-400'
            }`}
          >
            <span>You can ask Krisha: "Open YouTube", "Search lofi on YouTube", or "Open Google"</span>
            <button
              onClick={onClose}
              className="px-3 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
