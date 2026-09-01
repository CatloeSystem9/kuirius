import React from 'react';
import { History, BrainCircuit, Settings, HardDrive, Laptop } from 'lucide-react';
import { ActiveModal } from '../types';

interface SidebarNavProps {
  activeModal: ActiveModal;
  onSelectModal: (modal: ActiveModal) => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({ activeModal, onSelectModal }) => {
  return (
    <>
      {/* Desktop/Tablet Left Sidebar (Immersive UI Layout) */}
      <aside className="hidden sm:flex w-20 flex-col items-center justify-between py-10 border-r border-blue-900/20 bg-[#050810] shrink-0 z-30 select-none">
        {/* Top Brand Orb */}
        <button
          onClick={() => onSelectModal(null)}
          title="Krisha Presence"
          id="krisha-brand-orb"
          className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20 hover:border-blue-500/50 hover:bg-blue-500/20 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all cursor-pointer group"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-blue-400 shadow-[0_0_8px_#3b82f6] group-hover:scale-110 transition-transform" />
        </button>

        {/* Navigation Options */}
        <nav className="flex flex-col items-center space-y-7">
          {/* 1. Previous Conversations */}
          <button
            id="nav-previous-conversations"
            title="Previous Conversations"
            onClick={() => onSelectModal(activeModal === 'conversations' ? null : 'conversations')}
            className={`relative p-3 rounded-2xl transition-all cursor-pointer group ${
              activeModal === 'conversations'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <History className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'conversations' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 2. Memory */}
          <button
            id="nav-memory"
            title="Memory"
            onClick={() => onSelectModal(activeModal === 'memory' ? null : 'memory')}
            className={`relative p-3 rounded-2xl transition-all cursor-pointer group ${
              activeModal === 'memory'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <BrainCircuit className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'memory' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 3. Computer Files & Storage */}
          <button
            id="nav-files"
            title="Computer Storage & Files"
            onClick={() => onSelectModal(activeModal === 'files' ? null : 'files')}
            className={`relative p-3 rounded-2xl transition-all cursor-pointer group ${
              activeModal === 'files'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <HardDrive className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'files' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 4. Downloaded Laptop Apps */}
          <button
            id="nav-apps"
            title="Downloaded Laptop Apps"
            onClick={() => onSelectModal(activeModal === 'apps' ? null : 'apps')}
            className={`relative p-3 rounded-2xl transition-all cursor-pointer group ${
              activeModal === 'apps'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <Laptop className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'apps' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 5. Settings */}
          <button
            id="nav-settings"
            title="Settings"
            onClick={() => onSelectModal(activeModal === 'settings' ? null : 'settings')}
            className={`relative p-3 rounded-2xl transition-all cursor-pointer group ${
              activeModal === 'settings'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <Settings className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'settings' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>
        </nav>

        {/* Bottom Accent */}
        <div className="w-2 h-2 rounded-full bg-blue-900/40" />
      </aside>

      {/* Mobile Top Navigation Bar */}
      <header className="sm:hidden w-full px-4 py-3 flex items-center justify-between border-b border-blue-900/20 bg-[#050810] z-30 select-none">
        <button
          onClick={() => onSelectModal(null)}
          className="flex items-center gap-2"
        >
          <span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_#3b82f6]" />
          <span className="text-xs font-light tracking-[0.3em] uppercase text-blue-100/90">
            Krisha
          </span>
        </button>

        <div className="flex items-center gap-1">
          <button
            id="mobile-nav-conversations"
            onClick={() => onSelectModal(activeModal === 'conversations' ? null : 'conversations')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'conversations'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <History className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-memory"
            onClick={() => onSelectModal(activeModal === 'memory' ? null : 'memory')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'memory'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <BrainCircuit className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-files"
            onClick={() => onSelectModal(activeModal === 'files' ? null : 'files')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'files'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <HardDrive className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-apps"
            onClick={() => onSelectModal(activeModal === 'apps' ? null : 'apps')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'apps'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <Laptop className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-settings"
            onClick={() => onSelectModal(activeModal === 'settings' ? null : 'settings')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'settings'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>
    </>
  );
};

