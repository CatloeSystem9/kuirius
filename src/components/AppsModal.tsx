import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Search,
  Play,
  Shield,
  ExternalLink,
  Pin,
  PinOff,
  Folder,
  Terminal,
  FileText,
  Calculator,
  Sliders,
  Crop,
  Palette,
  Image as ImageIcon,
  Camera,
  Clock,
  ShoppingBag,
  Globe,
  Code,
  Sparkles,
  Send,
  FileCode,
  Table,
  Presentation,
  StickyNote,
  Mail,
  Calendar,
  BookOpen,
  Book,
  Layout,
  MessageSquare,
  Hash,
  PhoneCall,
  Video,
  Users,
  Phone,
  Music,
  Film,
  Disc,
  Gamepad2,
  Settings,
  Activity,
  Plus,
  Trash2,
  CheckCircle2,
  ArrowRight,
  AppWindow,
  RotateCcw,
  Sparkle,
} from 'lucide-react';
import {
  LaptopApp,
  getAllLaptopApps,
  searchLaptopApps,
  launchLaptopApp,
  launchCustomExecutable,
  saveCustomLaptopApp,
  deleteCustomLaptopApp,
  togglePinLaptopApp,
  getRecentApps,
} from '../utils/appLauncher';
import { WindowsLogo } from './WindowsLogo';

interface AppsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunchApp?: (app: LaptopApp) => void;
  initialSearchQuery?: string;
}

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  FileText,
  Calculator,
  Folder,
  Terminal,
  Activity,
  Settings,
  Sliders,
  Crop,
  Palette,
  Image: ImageIcon,
  Camera,
  Clock,
  ShoppingBag,
  Shield,
  Globe,
  Code,
  Sparkles,
  Send,
  FileCode,
  Table,
  Presentation,
  StickyNote,
  Mail,
  Calendar,
  BookOpen,
  Book,
  Layout,
  MessageSquare,
  Hash,
  PhoneCall,
  Video,
  Users,
  Phone,
  Music,
  Film,
  Disc,
  Gamepad2,
  AppWindow,
};

export const AppsModal: React.FC<AppsModalProps> = ({
  isOpen,
  onClose,
  onLaunchApp,
  initialSearchQuery = '',
}) => {
  const [apps, setApps] = useState<LaptopApp[]>([]);
  const [recentApps, setRecentApps] = useState<LaptopApp[]>([]);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'info' } | null>(null);

  // Custom App Form Fields
  const [customName, setCustomName] = useState('');
  const [customCategory, setCustomCategory] = useState<LaptopApp['category']>('dev');
  const [customProtocol, setCustomProtocol] = useState('');
  const [customFallbackUrl, setCustomFallbackUrl] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customExe, setCustomExe] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reload apps when modal opens or initial search changes
  useEffect(() => {
    if (isOpen) {
      const all = getAllLaptopApps();
      setApps(all);
      setRecentApps(getRecentApps());
      setSearchQuery(initialSearchQuery || '');
      setSelectedIndex(0);

      // Auto-focus search bar immediately on open
      setTimeout(() => {
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          if (initialSearchQuery) {
            searchInputRef.current.select();
          }
        }
      }, 50);
    }
  }, [isOpen, initialSearchQuery]);

  const filteredApps = useMemo(() => {
    return searchLaptopApps(searchQuery, selectedCategory === 'ALL' ? undefined : selectedCategory);
  }, [apps, searchQuery, selectedCategory]);

  // Keep selectedIndex in bounds when filteredApps changes
  useEffect(() => {
    if (selectedIndex >= filteredApps.length) {
      setSelectedIndex(Math.max(0, filteredApps.length - 1));
    }
  }, [filteredApps.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const selectedApp = filteredApps[selectedIndex] || filteredApps[0] || null;

  const showToast = (message: string, type: 'success' | 'info' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3800);
  };

  const handleLaunch = useCallback(
    (app: LaptopApp, asAdmin = false, taskParam?: string) => {
      launchLaptopApp(app, { asAdmin, taskParam });
      setRecentApps(getRecentApps());
      showToast(
        asAdmin
          ? `Opening ${app.name} as Administrator on your laptop...`
          : `Opening ${app.name} on your laptop...`
      );
      if (onLaunchApp) onLaunchApp(app);
    },
    [onLaunchApp]
  );

  const handleLaunchCustom = useCallback(
    (query: string, asAdmin = false) => {
      const res = launchCustomExecutable(query, asAdmin);
      showToast(
        asAdmin
          ? `Launching ${res.name} as Administrator...`
          : `Launching ${res.name} on your laptop...`
      );
    },
    []
  );

  const handleTogglePin = (appId: string) => {
    togglePinLaptopApp(appId);
    setApps(getAllLaptopApps());
    showToast('Updated Windows Start pin status', 'info');
  };

  // Keyboard navigation: ArrowUp, ArrowDown, Enter, Ctrl+Shift+Enter, Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // Arrow Down
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < filteredApps.length - 1 ? prev + 1 : 0));
        return;
      }

      // Arrow Up
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, filteredApps.length - 1)));
        return;
      }

      // Enter to open
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedApp) {
          const asAdmin = e.ctrlKey && e.shiftKey;
          handleLaunch(selectedApp, asAdmin);
        } else if (searchQuery.trim()) {
          const asAdmin = e.ctrlKey && e.shiftKey;
          handleLaunchCustom(searchQuery.trim(), asAdmin);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filteredApps.length, selectedApp, searchQuery, handleLaunch, handleLaunchCustom, onClose]);

  const handleCreateCustomApp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim() || (!customProtocol.trim() && !customExe.trim())) return;

    let proto = customProtocol.trim();
    if (proto && !proto.includes(':')) {
      proto = `${proto}:`;
    }

    const updated = saveCustomLaptopApp({
      name: customName.trim(),
      category: customCategory,
      protocol: proto || `${customName.trim().toLowerCase()}:`,
      executableName: customExe.trim() || undefined,
      fallbackUrl: customFallbackUrl.trim() || undefined,
      description: customDesc.trim() || 'Custom registered laptop app',
      iconName: 'AppWindow',
      aliases: [customName.trim().toLowerCase()],
      publisher: 'User Registered Application',
    });

    setApps([...updated]);
    setShowAddForm(false);
    setCustomName('');
    setCustomProtocol('');
    setCustomExe('');
    setCustomDesc('');
    setCustomFallbackUrl('');
    showToast(`Registered ${customName.trim()} to Windows Start!`);
  };

  const handleDeleteApp = (id: string, name: string) => {
    const updated = deleteCustomLaptopApp(id);
    setApps([...updated]);
    showToast(`Removed ${name} from custom apps`);
  };

  if (!isOpen) return null;

  const renderIcon = (iconName: string, className = 'w-5 h-5') => {
    const Comp = ICON_MAP[iconName] || AppWindow;
    return <Comp className={className} />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/80 backdrop-blur-md animate-in fade-in duration-200 select-none">
      <div className="w-full max-w-5xl h-[92vh] max-h-[850px] bg-[#080d1a]/95 border border-blue-500/35 rounded-3xl shadow-[0_0_80px_rgba(0,0,0,0.9)] flex flex-col overflow-hidden text-slate-100 relative">
        {/* Windows Start Header */}
        <header className="shrink-0 flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-blue-900/35 bg-[#060a14]/90 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-400/40 flex items-center justify-center shadow-[0_0_15px_rgba(0,120,215,0.35)]">
              <WindowsLogo className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
                  Windows Start
                </h1>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Laptop OS Bridge
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Click Windows option • Search any app on your laptop • Navigate with keyboard or mouse to open
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddForm(true)}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/40 transition-colors cursor-pointer"
              title="Add a custom laptop executable or custom application"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Custom App</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Close Windows Start (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Windows Search Bar Section */}
        <div className="shrink-0 px-4 sm:px-6 pt-4 pb-3 bg-[#070b16]/90 border-b border-blue-900/25">
          <div className="relative flex items-center">
            <div className="absolute left-3.5 pointer-events-none text-blue-400">
              <Search className="w-5 h-5" />
            </div>
            <input
              ref={searchInputRef}
              type="text"
              id="windows-search-bar"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Type here to search apps on your laptop (e.g. Chrome, Notepad, Calculator, VS Code, Word, Spotify)..."
              className="w-full bg-[#0d1428] border border-blue-500/40 focus:border-blue-400 rounded-2xl pl-11 pr-24 py-3 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all shadow-inner"
              autoComplete="off"
              spellCheck={false}
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSelectedIndex(0);
                  searchInputRef.current?.focus();
                }}
                className="absolute right-12 p-1.5 text-slate-400 hover:text-white transition-colors cursor-pointer"
                title="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <div className="absolute right-3 hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-950/60 border border-blue-500/30 text-[10px] text-blue-300 font-mono">
              <span>Enter ↵</span>
            </div>
          </div>

          {/* Windows Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pt-3 pb-1 text-xs no-scrollbar">
            {[
              { id: 'ALL', label: 'All' },
              { id: 'pinned', label: 'Pinned to Start' },
              { id: 'system', label: 'System & Tools' },
              { id: 'dev', label: 'Developer & Code' },
              { id: 'productivity', label: 'Productivity & Office' },
              { id: 'social', label: 'Social & Chat' },
              { id: 'media', label: 'Media & Audio' },
              { id: 'gaming', label: 'Gaming' },
            ].map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  setSelectedCategory(cat.id);
                  setSelectedIndex(0);
                }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                  selectedCategory === cat.id
                    ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(37,99,235,0.5)]'
                    : 'bg-[#0f172a] text-slate-400 hover:text-slate-200 hover:bg-[#1e293b]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Two-Column Windows Start Content */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Left Column: Search Results / Best Match List */}
          <div
            ref={listContainerRef}
            className="w-full md:w-[52%] lg:w-[48%] border-b md:border-b-0 md:border-r border-blue-900/30 overflow-y-auto p-3 sm:p-4 space-y-2"
          >
            {/* When search bar is empty, show Pinned & Recents */}
            {!searchQuery.trim() && selectedCategory === 'ALL' && recentApps.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center justify-between px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <span>Recent Apps</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {recentApps.slice(0, 4).map((app) => (
                    <button
                      key={`recent_${app.id}`}
                      onClick={() => handleLaunch(app)}
                      className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-[#0c1326] hover:bg-blue-950/50 border border-blue-900/30 hover:border-blue-500/40 transition-all text-center group cursor-pointer"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                        {renderIcon(app.iconName, 'w-4 h-4')}
                      </div>
                      <span className="text-xs font-medium text-slate-200 truncate w-full">
                        {app.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Results Header */}
            <div className="flex items-center justify-between px-2 py-1 text-xs text-slate-400">
              <span className="font-semibold uppercase tracking-wider text-[11px] text-blue-300">
                {searchQuery ? `Best Matches (${filteredApps.length})` : 'All Applications'}
              </span>
              <span className="text-[11px] text-slate-500 hidden sm:inline">
                Use ↑ / ↓ to navigate
              </span>
            </div>

            {/* App List */}
            {filteredApps.length > 0 ? (
              filteredApps.map((app, index) => {
                const isSelected = selectedApp?.id === app.id;
                return (
                  <button
                    key={app.id}
                    ref={(el) => (itemRefs.current[index] = el)}
                    onClick={() => {
                      setSelectedIndex(index);
                    }}
                    onDoubleClick={() => handleLaunch(app)}
                    className={`w-full flex items-center gap-3 p-2.5 sm:p-3 rounded-2xl text-left transition-all cursor-pointer relative group ${
                      isSelected
                        ? 'bg-blue-600/25 border border-blue-500/70 shadow-[0_0_20px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/40 text-white'
                        : 'bg-[#0a0f20]/70 hover:bg-[#0f1730] border border-blue-950 hover:border-blue-900 text-slate-300'
                    }`}
                  >
                    {/* App Icon */}
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105 ${
                        isSelected
                          ? 'bg-blue-600/30 text-blue-200 border border-blue-400/40'
                          : 'bg-[#101833] text-blue-400 border border-blue-500/20'
                      }`}
                    >
                      {renderIcon(app.iconName, 'w-5 h-5')}
                    </div>

                    {/* App Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{app.name}</span>
                        {app.isPinned && (
                          <Pin className="w-3 h-3 text-blue-400 flex-shrink-0" />
                        )}
                        {app.isCustom && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                            Custom
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 truncate">{app.description}</p>
                    </div>

                    {/* Right Enter / Category indicator */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isSelected ? (
                        <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-500/20 border border-blue-400/40 text-[10px] text-blue-300 font-mono animate-in fade-in">
                          <span>Open</span>
                          <span>↵</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-500 capitalize hidden sm:inline">
                          {app.category}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            ) : (
              /* No matching preset apps -> Offer to launch arbitrary app on laptop */
              <div className="p-6 text-center rounded-2xl bg-[#0a0f20] border border-blue-900/30">
                <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-3 text-blue-400">
                  <Search className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-semibold text-slate-200 mb-1">
                  No preset found for &quot;{searchQuery}&quot;
                </h3>
                <p className="text-xs text-slate-400 mb-4 max-w-sm mx-auto">
                  You can launch &quot;{searchQuery}&quot; directly on your laptop as a Windows protocol or system executable!
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
                  <button
                    onClick={() => handleLaunchCustom(searchQuery)}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/30 transition-all cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Launch &quot;{searchQuery}&quot; on Laptop</span>
                  </button>
                  <button
                    onClick={() => {
                      setCustomName(searchQuery);
                      setCustomExe(searchQuery.endsWith('.exe') ? searchQuery : `${searchQuery}.exe`);
                      setCustomProtocol(`${searchQuery.toLowerCase()}:`);
                      setShowAddForm(true);
                    }}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 border border-blue-900/40 text-xs font-medium transition-all cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Register as App</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Windows App Action & Detail Pane */}
          <div className="flex-1 bg-[#060a14]/95 p-4 sm:p-6 flex flex-col justify-between overflow-y-auto">
            {selectedApp ? (
              <div className="space-y-5">
                {/* Hero Header */}
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-blue-600/30 to-indigo-600/15 border border-blue-400/40 flex items-center justify-center text-blue-300 shadow-[0_0_30px_rgba(59,130,246,0.3)] flex-shrink-0">
                    {renderIcon(selectedApp.iconName, 'w-8 h-8 sm:w-10 sm:h-10')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                        {selectedApp.name}
                      </h2>
                      <button
                        onClick={() => handleTogglePin(selectedApp.id)}
                        className={`p-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                          selectedApp.isPinned
                            ? 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30'
                            : 'bg-white/5 text-slate-400 hover:text-white'
                        }`}
                        title={selectedApp.isPinned ? 'Unpin from Windows Start' : 'Pin to Windows Start'}
                      >
                        {selectedApp.isPinned ? (
                          <PinOff className="w-4 h-4" />
                        ) : (
                          <Pin className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-blue-400 mt-0.5">
                      {selectedApp.publisher || 'Desktop Application'} • Windows OS
                    </p>
                    <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                      {selectedApp.description}
                    </p>
                  </div>
                </div>

                {/* Primary Action Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
                  <button
                    onClick={() => handleLaunch(selectedApp)}
                    id="btn-windows-open-app"
                    className="flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm shadow-[0_0_25px_rgba(37,99,235,0.4)] transition-all cursor-pointer group hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Play className="w-4 h-4 fill-white transition-transform group-hover:scale-110" />
                    <span>Open</span>
                    <span className="text-[11px] opacity-75 font-mono ml-1">[Enter ↵]</span>
                  </button>

                  <button
                    onClick={() => handleLaunch(selectedApp, true)}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[#0e162d] hover:bg-[#162142] text-blue-300 hover:text-blue-200 border border-blue-500/30 hover:border-blue-500/50 text-xs font-semibold transition-all cursor-pointer"
                    title="Launch app with elevated administrator privileges"
                  >
                    <Shield className="w-4 h-4 text-amber-400" />
                    <span>Run as administrator</span>
                  </button>
                </div>

                {/* Secondary Quick Action Details */}
                <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                  <button
                    onClick={() => handleTogglePin(selectedApp.id)}
                    className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0c1326] hover:bg-[#121c38] border border-blue-900/30 text-slate-300 transition-colors text-left cursor-pointer"
                  >
                    <Pin className="w-3.5 h-3.5 text-blue-400" />
                    <span>{selectedApp.isPinned ? 'Unpin from Start' : 'Pin to Start'}</span>
                  </button>

                  {selectedApp.fallbackUrl ? (
                    <a
                      href={selectedApp.fallbackUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0c1326] hover:bg-[#121c38] border border-blue-900/30 text-slate-300 transition-colors text-left"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="truncate">Open Web Page</span>
                    </a>
                  ) : (
                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0c1326]/50 border border-blue-900/20 text-slate-400">
                      <Folder className="w-3.5 h-3.5 text-slate-500" />
                      <span className="truncate">{selectedApp.executableName || 'System Service'}</span>
                    </div>
                  )}
                </div>

                {/* Quick Jump Tasks */}
                {selectedApp.quickTasks && selectedApp.quickTasks.length > 0 && (
                  <div className="pt-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                      Tasks & Shortcuts
                    </h4>
                    <div className="space-y-1.5">
                      {selectedApp.quickTasks.map((task) => (
                        <button
                          key={task.id}
                          onClick={() => handleLaunch(selectedApp, false, task.actionParam)}
                          className="w-full flex items-center justify-between p-2.5 rounded-xl bg-[#090f22] hover:bg-blue-950/40 border border-blue-900/20 hover:border-blue-500/40 text-xs text-slate-200 transition-all text-left cursor-pointer group"
                        >
                          <span className="group-hover:text-white transition-colors">{task.label}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-blue-400 group-hover:translate-x-0.5 transition-transform" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Technical Launch Spec / Protocol */}
                <div className="p-3 rounded-2xl bg-[#080d1e] border border-blue-900/30 text-[11px] text-slate-400 font-mono space-y-1">
                  <div className="flex items-center justify-between text-slate-500">
                    <span>Protocol:</span>
                    <span className="text-blue-300">{selectedApp.protocol}</span>
                  </div>
                  {selectedApp.executableName && (
                    <div className="flex items-center justify-between text-slate-500">
                      <span>Executable:</span>
                      <span className="text-slate-300">{selectedApp.executableName}</span>
                    </div>
                  )}
                </div>

                {selectedApp.isCustom && (
                  <div className="pt-2">
                    <button
                      onClick={() => handleDeleteApp(selectedApp.id, selectedApp.name)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs text-red-400 hover:text-red-300 bg-red-950/20 hover:bg-red-950/40 border border-red-500/30 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove Custom App</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                <WindowsLogo className="w-12 h-12 mb-3 opacity-40" />
                <p className="text-sm">Select an application to view details & open</p>
              </div>
            )}

            {/* Bottom Keyboard Navigation Hint Bar */}
            <div className="pt-4 border-t border-blue-900/30 mt-4 flex items-center justify-between text-[11px] text-slate-400 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/40 font-mono text-[10px]">↑/↓</kbd>
                  Navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/40 font-mono text-[10px]">Enter ↵</kbd>
                  Open App
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/40 font-mono text-[10px]">Esc</kbd>
                  Close
                </span>
              </div>
              <button
                onClick={() => setShowAddForm(true)}
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer"
              >
                + Add another app
              </button>
            </div>
          </div>
        </div>

        {/* Success Toast Notification */}
        <AnimatePresence>
          {notification && (
            <motion.div
              initial={{ opacity: 0, y: 14, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 px-4 py-2.5 rounded-2xl bg-blue-600 text-white text-xs font-semibold shadow-2xl flex items-center gap-2 border border-blue-400/40"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-300" />
              <span>{notification.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Add Custom Application Modal Overlay */}
        <AnimatePresence>
          {showAddForm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-40 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
            >
              <motion.form
                initial={{ scale: 0.95, y: 10 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 10 }}
                onSubmit={handleCreateCustomApp}
                className="w-full max-w-lg bg-[#0a1024] border border-blue-500/40 rounded-3xl p-6 shadow-2xl space-y-4 text-slate-100"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Plus className="w-5 h-5 text-blue-400" />
                    <h3 className="text-base font-bold text-white">Add Custom Laptop App</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <p className="text-xs text-slate-400">
                  Register any software installed on your laptop so you can search and open it from Windows Start.
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      App Name *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., Blender, AutoCAD, PyCharm, Audacity"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Category
                      </label>
                      <select
                        value={customCategory}
                        onChange={(e) => setCustomCategory(e.target.value as any)}
                        className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                      >
                        <option value="dev">Developer & Code</option>
                        <option value="productivity">Productivity</option>
                        <option value="media">Media & Creative</option>
                        <option value="social">Social & Chat</option>
                        <option value="gaming">Gaming</option>
                        <option value="system">System Utility</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Executable (.exe)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g., blender.exe"
                        value={customExe}
                        onChange={(e) => setCustomExe(e.target.value)}
                        className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Protocol Scheme (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g., blender:, customapp:"
                      value={customProtocol}
                      onChange={(e) => setCustomProtocol(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Web Fallback URL (Optional)
                    </label>
                    <input
                      type="url"
                      placeholder="https://..."
                      value={customFallbackUrl}
                      onChange={(e) => setCustomFallbackUrl(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      placeholder="Short description of this application"
                      value={customDesc}
                      onChange={(e) => setCustomDesc(e.target.value)}
                      className="w-full bg-[#050812] border border-blue-900/60 focus:border-blue-400 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-lg shadow-blue-600/30 cursor-pointer"
                  >
                    Save & Pin to Start
                  </button>
                </div>
              </motion.form>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
