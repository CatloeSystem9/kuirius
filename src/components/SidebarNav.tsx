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
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
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

  // Ultra-fluid Drag-to-Scroll handlers with GPU-friendly RAF batching & momentum physics
  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
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
    if (Math.abs(deltaY) > 3) {
      hasDraggedRef.current = true;
    }
    const now = performance.now();
    const dt = now - lastTimeRef.current;
    if (dt > 4) {
      const v = (currentY - lastYRef.current) / dt;
      // Exponential smoothing on velocity for clean release momentum
      velocityRef.current = velocityRef.current * 0.35 + v * 0.65;
      lastYRef.current = currentY;
      lastTimeRef.current = now;
    }

    targetScrollTopRef.current = startScrollTopRef.current - deltaY;

    // Single RAF throttle: synchronize direct scroll assignment to display refresh rate
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

    // Apply high-FPS fluid momentum inertial decay animation if released with velocity
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

    setTimeout(() => {
      hasDraggedRef.current = false;
    }, 60);
  };

  const handleNavClick = (modal: ActiveModal) => {
    if (hasDraggedRef.current) return;
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
            onClick={() => onSelectModal(null)}
            title="Krisha Presence"
            id="krisha-brand-orb"
            className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20 hover:border-blue-500/50 hover:bg-blue-500/20 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all cursor-pointer group"
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
            onClick={() => scrollSmooth(-140)}
            title="Scroll up"
            className="p-1 rounded-full text-blue-400/80 hover:text-blue-200 hover:bg-blue-500/15 transition-all cursor-pointer"
          >
            <ChevronUp className="w-4 h-4 animate-bounce" />
          </button>
        </div>

        {/* Navigation Options with 60-120 FPS high-performance fluid drag-to-scroll */}
        <nav
          ref={navRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerCancel={endDrag}
          className={`flex flex-col items-center space-y-5 sm:space-y-6 flex-1 w-full overflow-y-auto overflow-x-hidden smooth-scroll nav-scrollbar py-2 px-1 overscroll-contain transition-colors select-none transform-gpu will-change-scroll ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{ touchAction: 'pan-y' }}
        >
          {/* 1. Previous Conversations */}
          <button
            id="nav-previous-conversations"
            title="Previous Conversations"
            onClick={() => handleNavClick('conversations')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
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
            onClick={() => handleNavClick('memory')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
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
            onClick={() => handleNavClick('files')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
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
            onClick={() => handleNavClick('apps')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
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

          {/* 5. Google Maps Location */}
          <button
            id="nav-location"
            title={location?.city ? `Google Maps: ${location.city} (Connected)` : "Google Maps Location"}
            onClick={() => handleNavClick('location')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
              activeModal === 'location'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <MapPin className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'location' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
            {location && (
              <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_#34d399]" />
            )}
          </button>

          {/* 6. Web & Media Launcher (YouTube, Search, Web) */}
          <button
            id="nav-web-browser"
            title="Web & Media Launcher (YouTube, Search, Streaming)"
            onClick={() => handleNavClick('web_browser')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
              activeModal === 'web_browser'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <Globe className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'web_browser' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 7. Interactive 3D Earth */}
          <button
            id="nav-globe"
            title="Interactive 3D Earth / Globe"
            onClick={() => handleNavClick('globe')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
              activeModal === 'globe'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <Orbit className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'globe' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 8. Audio Transcription (Microphone & Audio Files) */}
          <button
            id="nav-transcribe"
            title="Transcribe Audio (Microphone & Audio Files with Gemini)"
            onClick={() => handleNavClick('transcribe')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
              activeModal === 'transcribe'
                ? 'text-blue-300 bg-blue-950/40 border border-blue-800/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                : 'text-slate-500 hover:text-blue-400 hover:bg-blue-950/20'
            }`}
          >
            <AudioLines className="w-5 h-5 transition-transform group-hover:scale-110" />
            {activeModal === 'transcribe' && (
              <span className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-3 rounded-full bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
            )}
          </button>

          {/* 9. Settings */}
          <button
            id="nav-settings"
            title="Settings"
            onClick={() => handleNavClick('settings')}
            className={`relative p-3 rounded-2xl transition-all duration-150 ease-out cursor-pointer group hover:scale-105 active:scale-95 transform-gpu ${
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

