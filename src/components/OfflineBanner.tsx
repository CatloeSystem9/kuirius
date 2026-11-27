/**
 * OfflineBanner — slim top bar that appears when the browser loses connectivity.
 *
 * Uses the browser's native `online`/`offline` events, so it reacts instantly
 * without polling. The banner auto-dismisses when the connection is restored.
 */

import React, { useEffect, useState } from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function OfflineBanner() {
  const [status, setStatus] = useState<'offline' | 'restored' | 'online'>(
    navigator.onLine ? 'online' : 'offline'
  );

  useEffect(() => {
    const handleOffline = () => setStatus('offline');
    const handleOnline  = () => {
      setStatus('restored');
      // Hide the "restored" indicator after 2.5 s
      const t = setTimeout(() => setStatus('online'), 2500);
      return () => clearTimeout(t);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online',  handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online',  handleOnline);
    };
  }, []);

  const visible = status === 'offline' || status === 'restored';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={status}
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0,   opacity: 1 }}
          exit={{    y: -40, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className={`
            fixed top-0 left-0 right-0 z-[9999]
            flex items-center justify-center gap-2
            px-4 py-1.5 text-xs font-medium tracking-wide
            ${status === 'offline'
              ? 'bg-amber-500/90 text-amber-950 backdrop-blur-sm'
              : 'bg-emerald-500/90 text-emerald-950 backdrop-blur-sm'}
          `}
          role="status"
          aria-live="polite"
        >
          {status === 'offline' ? (
            <>
              <WifiOff size={13} strokeWidth={2.5} />
              You're offline — Krisha's UI is running from cache
            </>
          ) : (
            <>
              <Wifi size={13} strokeWidth={2.5} />
              Connection restored
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
