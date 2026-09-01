import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  AppWindow,
  Search,
  Plus,
  Play,
  ExternalLink,
  Code,
  BookOpen,
  MessageSquare,
  Music,
  Gamepad2,
  Settings,
  Sparkles,
  CheckCircle2,
  Trash2,
  Terminal,
  Layers,
  Laptop,
} from 'lucide-react';
import {
  LaptopApp,
  getAllLaptopApps,
  searchLaptopApps,
  launchLaptopApp,
  saveCustomLaptopApp,
  deleteCustomLaptopApp,
} from '../utils/appLauncher';

interface AppsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunchApp?: (app: LaptopApp) => void;
  initialSearchQuery?: string;
}

export const AppsModal: React.FC<AppsModalProps> = ({
  isOpen,
  onClose,
  onLaunchApp,
  initialSearchQuery = '',
}) => {
  const [apps, setApps] = useState<LaptopApp[]>([]);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [showAddForm, setShowAddForm] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Custom App Form Fields
  const [customName, setCustomName] = useState('');
  const [customCategory, setCustomCategory] = useState<LaptopApp['category']>('dev');
  const [customProtocol, setCustomProtocol] = useState('');
  const [customFallbackUrl, setCustomFallbackUrl] = useState('');
  const [customDesc, setCustomDesc] = useState('');

  useEffect(() => {
    if (isOpen) {
      setApps(getAllLaptopApps());
      if (initialSearchQuery) setSearchQuery(initialSearchQuery);
    }
  }, [isOpen, initialSearchQuery]);

  if (!isOpen) return null;

  const filteredApps = searchLaptopApps(searchQuery, selectedCategory === 'ALL' ? undefined : selectedCategory);

  const handleLaunch = (app: LaptopApp) => {
    const res = launchLaptopApp(app);
    showNotification(`Sent launch command for ${app.name} to your laptop.`);
    if (onLaunchApp) onLaunchApp(app);
  };

  const showNotification = (msg: string) => {
    setSuccessNotice(msg);
    setTimeout(() => setSuccessNotice(null), 3500);
  };

  const handleCreateCustomApp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim() || !customProtocol.trim()) return;

    let proto = customProtocol.trim();
    if (!proto.includes(':')) {
      proto = `${proto}:`;
    }

    const updated = saveCustomLaptopApp({
      name: customName.trim(),
      category: customCategory,
      protocol: proto,
      fallbackUrl: customFallbackUrl.trim() || undefined,
      description: customDesc.trim() || 'Custom registered laptop app',
      iconName: 'AppWindow',
      aliases: [customName.trim().toLowerCase()],
    });

    setApps([...updated]);
    setShowAddForm(false);
    setCustomName('');
    setCustomProtocol('');
    setCustomFallbackUrl('');
    setCustomDesc('');
    showNotification(`Registered "${customName}" to your laptop app library.`);
  };

  const handleDeleteCustomApp = (id: string, name: string) => {
    const updated = deleteCustomLaptopApp(id);
    setApps([...updated]);
    showNotification(`Removed "${name}".`);
  };

  const getCategoryIcon = (category: string) => {
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

  const categories = [
    { id: 'ALL', label: 'All Apps' },
    { id: 'dev', label: 'Coding & Dev' },
    { id: 'productivity', label: 'Productivity' },
    { id: 'social', label: 'Chat & Social' },
    { id: 'media', label: 'Media & Music' },
    { id: 'gaming', label: 'Gaming & Design' },
    { id: 'system', label: 'System Tools' },
  ];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#02040a]/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          transition={{ duration: 0.22 }}
          className="relative w-full max-w-3xl bg-[#050810] border border-blue-900/40 rounded-2xl shadow-[0_0_60px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col max-h-[90vh] z-10 text-slate-200"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/20 bg-[#080d1a]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <Laptop className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90 flex items-center gap-2">
                  <span>Downloaded Laptop Apps & Software</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-mono">
                    {apps.length} apps available
                  </span>
                </h2>
                <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                  Ask Krisha to launch any installed app on your laptop or click Launch below
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              id="close-apps-modal"
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Action Bar & Search */}
          <div className="p-4 border-b border-blue-900/20 flex flex-wrap items-center justify-between gap-3 bg-[#03060d]">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[220px] flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search downloaded apps (e.g. VS Code, Spotify, Discord, Calculator)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#070b16] border border-blue-900/30 rounded-xl pl-9 pr-3.5 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors"
              />
            </div>

            {/* Add Custom App Button */}
            <button
              type="button"
              onClick={() => setShowAddForm(!showAddForm)}
              id="btn-toggle-add-custom-app"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-950/80 hover:bg-blue-900/60 border border-blue-700/40 text-blue-200 text-xs font-semibold tracking-wider uppercase transition-all shadow-[0_0_15px_rgba(37,99,235,0.2)] cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-blue-400" />
              <span>{showAddForm ? 'Cancel' : 'Add Custom App'}</span>
            </button>
          </div>

          {/* Category Tabs */}
          <div className="px-4 py-2 border-b border-blue-900/20 bg-[#060a14] flex items-center gap-1.5 overflow-x-auto text-xs no-scrollbar">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium shrink-0 transition-colors cursor-pointer ${
                  selectedCategory === cat.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-blue-950/40 text-slate-400 hover:text-blue-300 hover:bg-blue-900/30'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Toast Notice */}
          <AnimatePresence>
            {successNotice && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-6 py-2 bg-emerald-950/40 border-b border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>{successNotice}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Add Custom App Collapsible Drawer */}
          {showAddForm && (
            <form
              onSubmit={handleCreateCustomApp}
              className="p-4 bg-[#080e21] border-b border-blue-700/40 space-y-3"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-blue-300 uppercase tracking-wider">
                <Plus className="w-3.5 h-3.5 text-blue-400" />
                <span>Register a Custom Laptop Application or URI Scheme</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                    App Name *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. IntelliJ, Blender, Unity"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    className="w-full bg-[#050810] border border-blue-900/40 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                    Protocol / Deep Link *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. idea:, blender:, steam://rungameid/..."
                    value={customProtocol}
                    onChange={(e) => setCustomProtocol(e.target.value)}
                    className="w-full bg-[#050810] border border-blue-900/40 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                    Category
                  </label>
                  <select
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value as LaptopApp['category'])}
                    className="w-full bg-[#050810] border border-blue-900/40 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50"
                  >
                    <option value="dev">Coding & Dev</option>
                    <option value="productivity">Productivity</option>
                    <option value="social">Chat & Social</option>
                    <option value="media">Media & Music</option>
                    <option value="gaming">Gaming & Design</option>
                    <option value="system">System Tools</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                    Web Fallback URL (Optional)
                  </label>
                  <input
                    type="url"
                    placeholder="https://..."
                    value={customFallbackUrl}
                    onChange={(e) => setCustomFallbackUrl(e.target.value)}
                    className="w-full bg-[#050810] border border-blue-900/40 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold uppercase tracking-wider cursor-pointer shadow-md"
                >
                  Save App
                </button>
              </div>
            </form>
          )}

          {/* Apps Grid / List */}
          <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {filteredApps.length === 0 ? (
              <div className="col-span-full py-16 text-center text-slate-500 text-xs font-light">
                No apps found matching "{searchQuery}". Try adding it as a custom app!
              </div>
            ) : (
              filteredApps.map((app) => (
                <div
                  key={app.id}
                  className="group flex items-center justify-between p-3 rounded-xl bg-[#060a14] border border-blue-900/20 hover:border-blue-700/40 hover:bg-[#0a1020] transition-all"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                    <div className="p-2 rounded-lg bg-blue-950/60 border border-blue-800/30 shrink-0">
                      {getCategoryIcon(app.category)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-xs font-semibold text-slate-200 truncate">{app.name}</h4>
                        {app.isCustom && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono">
                            Custom
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-400 truncate mt-0.5">{app.description}</p>
                      <span className="text-[9px] text-blue-400/80 font-mono">{app.protocol}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleLaunch(app)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold transition-all shadow-[0_0_12px_rgba(37,99,235,0.3)] cursor-pointer"
                      title={`Launch ${app.name} on your laptop`}
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Launch</span>
                    </button>

                    {app.isCustom && (
                      <button
                        type="button"
                        onClick={() => handleDeleteCustomApp(app.id, app.name)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                        title="Delete custom app"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Quick Voice Command Guide Footer */}
          <div className="px-6 py-3 bg-[#060a14] border-t border-blue-900/20 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>Voice commands: <em>"Krisha open Spotify"</em>, <em>"open VS Code"</em>, <em>"launch Discord"</em>, or <em>"open Calculator"</em></span>
            </div>
            <span className="font-mono text-[10px] text-blue-500/70">{filteredApps.length} laptop apps</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
