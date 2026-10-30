import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  History,
  BrainCircuit,
  Settings,
  HardDrive,
  Laptop,
  MapPin,
  Globe,
  Orbit,
  AudioLines,
  CalendarCheck,
  Gamepad2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { WindowsLogo } from './WindowsLogo';
import { ActiveModal, UserLocation } from '../types';

interface SidebarNavProps {
  activeModal: ActiveModal;
  onSelectModal: (modal: ActiveModal) => void;
  location?: UserLocation | null;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({ activeModal, onSelectModal, location }) => {
  const asideRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startScrollTopRef = useRef(0);
  const targetScrollTopRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTimeRef = useRef(0);
  const velocityRef = useRef(0);
  const hasDraggedRef = useRef(false);
  const dragRafRef = useRef<number | null>(null);
  const momentumRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  // Monitor scroll position with RAF throttling to prevent layout thrashing and maintain 60-120fps
  const scheduleCheckScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = navRef.current;
      if (!el) return;
      const hasUp = el.scrollTop > 8;
      const hasDown = el.scrollHeight - el.clientHeight - el.scrollTop > 8;
      setCanScrollUp((prev) => (prev !== hasUp ? hasUp : prev));
      setCanScrollDown((prev) => (prev !== hasDown ? hasDown : prev));
    });
  }, []);

  useEffect(() => {
    const navEl = navRef.current;
    const asideEl = asideRef.current;
    const mobileEl = mobileNavRef.current;
    if (!navEl) return;

    scheduleCheckScroll();

    // Use passive event listener options across all scroll & gesture handlers
    // to guarantee zero main-thread blocking, enabling off-thread compositor scrolling
    const passiveOpts: AddEventListenerOptions = { passive: true };

    // 1. Primary scroll listener for desktop sidebar
    navEl.addEventListener('scroll', scheduleCheckScroll, passiveOpts);
    navEl.addEventListener('wheel', scheduleCheckScroll, passiveOpts);
    navEl.addEventListener('touchmove', scheduleCheckScroll, passiveOpts);

    // 2. Wheel event forwarding on aside container for unified scrolling
    const handleAsideWheel = (e: WheelEvent) => {
      if (navEl && e.deltaY) {
        navEl.scrollTop += e.deltaY;
      }
    };
    if (asideEl) {
      asideEl.addEventListener('wheel', handleAsideWheel, passiveOpts);
    }

    // 3. Mobile navigation scroll listener
    if (mobileEl) {
      mobileEl.addEventListener('scroll', scheduleCheckScroll, passiveOpts);
      mobileEl.addEventListener('touchmove', scheduleCheckScroll, passiveOpts);
    }

    // 4. Window resize listener
    window.addEventListener('resize', scheduleCheckScroll, passiveOpts);

    return () => {
      navEl.removeEventListener('scroll', scheduleCheckScroll);
      navEl.removeEventListener('wheel', scheduleCheckScroll);
      navEl.removeEventListener('touchmove', scheduleCheckScroll);
      if (asideEl) {
        asideEl.removeEventListener('wheel', handleAsideWheel);
      }
      if (mobileEl) {
        mobileEl.removeEventListener('scroll', scheduleCheckScroll);
        mobileEl.removeEventListener('touchmove', scheduleCheckScroll);
      }
      window.removeEventListener('resize', scheduleCheckScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
      if (momentumRafRef.current) cancelAnimationFrame(momentumRafRef.current);
    };
  }, [scheduleCheckScroll]);

  // Smooth scroll jump helper for indicators
  const scrollSmooth = (amount: number) => {
    if (navRef.current) {
      navRef.current.scrollBy({ top: amount, behavior: 'smooth' });
    }
  };

  // Drag-to-scroll handlers (only applied when dragging on container background, never interfering with buttons)
  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // Never hijack clicks or pointer events intended for buttons
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }

    if (momentumRafRef.current) {
      cancelAnimationFrame(momentumRafRef.current);
      momentumRafRef.current = null;
    }
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // safe fallback if capture unsupported
    }

    isDraggingRef.current = true;
    setIsDragging(true);
    hasDraggedRef.current = false;
    startYRef.current = e.clientY;
    lastYRef.current = e.clientY;
    lastTimeRef.current = performance.now();
    velocityRef.current = 0;
    const initialScrollTop = navRef.current ? navRef.current.scrollTop : 0;
    startScrollTopRef.current = initialScrollTop;
    targetScrollTopRef.current = initialScrollTop;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingRef.current || !navRef.current) return;
    const currentY = e.clientY;
    const deltaY = currentY - startYRef.current;
    if (Math.abs(deltaY) > 4) {
      hasDraggedRef.current = true;
    }
    const now = performance.now();
    const dt = now - lastTimeRef.current;
    if (dt > 4) {
      const v = (currentY - lastYRef.current) / dt;
      velocityRef.current = velocityRef.current * 0.35 + v * 0.65;
      lastYRef.current = currentY;
      lastTimeRef.current = now;
    }

    targetScrollTopRef.current = startScrollTopRef.current - deltaY;

    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        if (navRef.current && isDraggingRef.current) {
          navRef.current.scrollTop = targetScrollTopRef.current;
        }
      });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // safe fallback
    }

    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }

    if (hasDraggedRef.current && Math.abs(velocityRef.current) > 0.05 && navRef.current) {
      let currentVelocity = velocityRef.current * 16;
      const friction = 0.94;

      const stepMomentum = () => {
        if (Math.abs(currentVelocity) > 0.15 && navRef.current) {
          navRef.current.scrollTop -= currentVelocity;
          currentVelocity *= friction;
          momentumRafRef.current = requestAnimationFrame(stepMomentum);
        } else {
          momentumRafRef.current = null;
        }
      };
      momentumRafRef.current = requestAnimationFrame(stepMomentum);
    }

    hasDraggedRef.current = false;
  };

  const handleNavClick = (modal: ActiveModal) => {
    onSelectModal(activeModal === modal ? null : modal);
  };

  return (
    <>
      {/* Desktop/Tablet Left Sidebar (Immersive UI Layout) */}
      <aside
        ref={asideRef}
        className="hidden sm:flex w-20 flex-col items-center justify-between py-6 border-r border-blue-900/20 bg-[#050810] shrink-0 z-30 select-none h-full max-h-screen relative overflow-hidden transition-all duration-300"
      >
        {/* Top Brand Orb */}
        <div className="shrink-0 mb-2 flex flex-col items-center">
          <button
            type="button"
            onClick={() => onSelectModal(null)}
            title="Krisha Presence"
            id="krisha-brand-orb"
            className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20 hover:border-blue-500/50 hover:bg-blue-500/20 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all cursor-pointer group pointer-events-auto"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-blue-400 shadow-[0_0_8px_#3b82f6] group-hover:scale-110 transition-transform" />
          </button>
        </div>

        {/* Up overflow indicator / smooth scroll jump */}
        <div
          className={`shrink-0 transition-all duration-300 ${
            canScrollUp ? 'opacity-100 h-6' : 'opacity-0 h-0 pointer-events-none overflow-hidden'
          }`}
        >
          <button
            type="button"
            onClick={() => scrollSmooth(-140)}
            title="Scroll up"
            className="p-1 rounded-full text-blue-400/80 hover:text-blue-200 hover:bg-blue-500/15 transition-all cursor-pointer pointer-events-auto"
          >
            <ChevronUp className="w-4 h-4 animate-bounce" />
          </button>
        </div>

        {/* Navigation Options */}
        <nav
          ref={navRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerCancel={endDrag}
          className="flex flex-col items-center space-y-5 sm:space-y-6 flex-1 w-full overflow-y-auto overflow-x-hidden smooth-scroll nav-scrollbar py-2 px-1 overscroll-contain transition-colors select-none transform-gpu will-change-scroll"
          style={{ touchAction: 'pan-y' }}
        >
          {/* 1. Previous Conversations */}
          <button
            type="button"
            id="nav-previous-conversations"
            title="Previous Conversations"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('conversations');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'conversations'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <History className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'conversations' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 2. Memory */}
          <button
            type="button"
            id="nav-memory"
            title="Memory"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('memory');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'memory'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <BrainCircuit className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'memory' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 3. Computer Files & Storage */}
          <button
            type="button"
            id="nav-files"
            title="Computer Storage & Files"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('files');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'files'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <HardDrive className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'files' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 4. Windows Option (Start Menu & App Search) */}
          <button
            type="button"
            id="nav-windows"
            title="⊞ Windows Option (Search & Open Any Laptop App)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('apps');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'apps'
                ? 'text-blue-200 bg-blue-600/25 border border-blue-400/60 shadow-[0_0_20px_rgba(0,120,215,0.45)] ring-1 ring-blue-400/40'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <WindowsLogo className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'apps' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 5. Google Maps Location */}
          <button
            type="button"
            id="nav-location"
            title={location?.city ? `Google Maps: ${location.city} (Connected)` : "Google Maps Location"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('location');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'location'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <MapPin className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'location' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
            {location && (
              <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_#34d399]" />
            )}
          </button>

          {/* 6. Web & Media Launcher (YouTube, Search, Web) */}
          <button
            type="button"
            id="nav-web-browser"
            title="Web & Media Launcher (YouTube, Search, Streaming)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('web_browser');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'web_browser'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <Globe className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'web_browser' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 7. Interactive 3D Earth */}
          <button
            type="button"
            id="nav-globe"
            title="Interactive 3D Earth / Globe"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('globe');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'globe'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <Orbit className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'globe' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 8. Audio Transcription (Microphone & Audio Files) */}
          <button
            type="button"
            id="nav-transcribe"
            title="Transcribe Audio (Microphone & Audio Files with Gemini)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('transcribe');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'transcribe'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <AudioLines className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'transcribe' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 9. Daily Habits & Calendar */}
          <button
            type="button"
            id="nav-habits"
            title="Daily Habits & Calendar"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('habits');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'habits'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <CalendarCheck className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'habits' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>

          {/* 10. Krix Arcade */}
          <button
            type="button"
            id="nav-arcade"
            title="🎮 Krix Arcade (Games & Strategy)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('arcade');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'arcade'
                ? 'text-indigo-200 bg-indigo-600/25 border border-indigo-500/60 shadow-[0_0_18px_rgba(99,102,241,0.4)] ring-1 ring-indigo-400/40'
                : 'text-slate-400 hover:text-indigo-300 hover:bg-indigo-950/40 border border-transparent hover:border-indigo-500/30 hover:shadow-[0_0_12px_rgba(99,102,241,0.25)]'
            }`}
          >
            <Gamepad2 className="w-5 h-5 transition-transform group-hover:scale-110 group-hover:rotate-6" />
            {activeModal === 'arcade' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-indigo-400 shadow-[0_0_8px_#818cf8]" />
            )}
          </button>

          {/* 11. Settings */}
          <button
            type="button"
            id="nav-settings"
            title="Settings"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleNavClick('settings');
            }}
            className={`relative p-3 rounded-2xl transition-all duration-200 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu pointer-events-auto ${
              activeModal === 'settings'
                ? 'text-blue-200 bg-blue-600/20 border border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.35)] ring-1 ring-blue-400/30'
                : 'text-slate-400 hover:text-blue-300 hover:bg-blue-950/40 border border-transparent hover:border-blue-500/30 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]'
            }`}
          >
            <Settings className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'settings' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full bg-blue-400 shadow-[0_0_8px_#38bdf8]" />
            )}
          </button>
        </nav>

        {/* Down overflow indicator / smooth scroll jump */}
        <div
          className={`shrink-0 transition-all duration-300 ${
            canScrollDown ? 'opacity-100 h-6' : 'opacity-0 h-0 pointer-events-none overflow-hidden'
          }`}
        >
          <button
            onClick={() => scrollSmooth(140)}
            title="Scroll down"
            className="p-1 rounded-full text-blue-400/80 hover:text-blue-200 hover:bg-blue-500/15 transition-all cursor-pointer"
          >
            <ChevronDown className="w-4 h-4 animate-bounce" />
          </button>
        </div>

        {/* Bottom Accent */}
        <div className="shrink-0 mt-2 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-blue-900/40" />
        </div>
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

        <div ref={mobileNavRef} className="flex items-center gap-1 overflow-x-auto scroll-smooth nav-scrollbar py-1">
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
            id="mobile-nav-windows"
            title="⊞ Windows Option (Search & Open Laptop Apps)"
            onClick={() => onSelectModal(activeModal === 'apps' ? null : 'apps')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'apps'
                ? 'text-blue-300 bg-blue-950/60 ring-1 ring-blue-500/40'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <WindowsLogo className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-location"
            title="Google Maps Location"
            onClick={() => onSelectModal(activeModal === 'location' ? null : 'location')}
            className={`p-2 rounded-lg text-xs transition-all relative ${
              activeModal === 'location'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <MapPin className="w-4 h-4" />
            {location && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
          </button>

          <button
            id="mobile-nav-web-browser"
            title="Web & Media Launcher"
            onClick={() => onSelectModal(activeModal === 'web_browser' ? null : 'web_browser')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'web_browser'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <Globe className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-globe"
            title="Interactive 3D Earth"
            onClick={() => onSelectModal(activeModal === 'globe' ? null : 'globe')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'globe'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <Orbit className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-transcribe"
            title="Transcribe Audio"
            onClick={() => onSelectModal(activeModal === 'transcribe' ? null : 'transcribe')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'transcribe'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <AudioLines className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-habits"
            title="Daily Habits & Calendar"
            onClick={() => onSelectModal(activeModal === 'habits' ? null : 'habits')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'habits'
                ? 'text-blue-300 bg-blue-950/50'
                : 'text-slate-400 hover:text-blue-300'
            }`}
          >
            <CalendarCheck className="w-4 h-4" />
          </button>

          <button
            id="mobile-nav-arcade"
            title="🎮 Krix Arcade"
            onClick={() => onSelectModal(activeModal === 'arcade' ? null : 'arcade')}
            className={`p-2 rounded-lg text-xs transition-all ${
              activeModal === 'arcade'
                ? 'text-indigo-300 bg-indigo-950/60 ring-1 ring-indigo-500/40'
                : 'text-slate-400 hover:text-indigo-300'
            }`}
          >
            <Gamepad2 className="w-4 h-4" />
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

