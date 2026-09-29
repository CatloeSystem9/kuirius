import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  MapPin,
  ExternalLink,
  Navigation,
  Crosshair,
  Copy,
  Check,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { MapsLocationAction } from '../types';

interface MapsLocationCardProps {
  action: MapsLocationAction | null;
  onDismiss?: () => void;
  onChangeLocation?: () => void;
  onCalibrate?: () => void;
  isLightMode?: boolean;
}

export const MapsLocationCard: React.FC<MapsLocationCardProps> = ({
  action,
  onDismiss,
  onChangeLocation,
  onCalibrate,
  isLightMode = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [showEmbed, setShowEmbed] = useState(false);

  if (!action) return null;

  const handleChange = onChangeLocation || onCalibrate;

  const handleCopy = () => {
    const textToCopy = action.lat !== undefined && action.lng !== undefined
      ? `${action.lat.toFixed(6)}, ${action.lng.toFixed(6)} (${action.formattedAddress || action.city || ''})`
      : action.formattedAddress || '';
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exactGoogleMapsUrl = action.lat !== undefined && action.lng !== undefined
    ? `https://www.google.com/maps/search/?api=1&query=${action.lat},${action.lng}`
    : action.googleMapsUrl;

  const handleOpenGoogleMaps = () => {
    if (exactGoogleMapsUrl) {
      window.open(exactGoogleMapsUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const latDir = action.lat !== undefined ? (action.lat >= 0 ? 'N' : 'S') : '';
  const lngDir = action.lng !== undefined ? (action.lng >= 0 ? 'E' : 'W') : '';
  const formattedCoord = action.lat !== undefined && action.lng !== undefined
    ? `${Math.abs(action.lat).toFixed(5)}° ${latDir}, ${Math.abs(action.lng).toFixed(5)}° ${lngDir} (${action.lat.toFixed(6)}, ${action.lng.toFixed(6)})`
    : null;

  return (
    <AnimatePresence>
      <motion.div
        id="google-maps-location-card"
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={`w-full max-w-lg mx-auto mb-3 rounded-2xl p-4 shadow-xl backdrop-blur-xl border transition-all ${
          isLightMode
            ? 'bg-slate-50/95 border-slate-200 shadow-slate-300/40 text-slate-800'
            : 'bg-gradient-to-br from-[#060d1d]/95 via-[#071126]/90 to-[#040814]/95 border-blue-500/25 shadow-black/60 text-slate-100'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-blue-500/15 border border-blue-400/30 text-blue-400 shadow-sm shadow-blue-500/20">
              <MapPin className="w-5 h-5 text-blue-400" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1">
                  <Navigation className="w-3 h-3" />
                  Google Maps
                </span>
                {action.usedAlternative ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1" />
                    Alternative (Google Maps Failed)
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1" />
                    First Priority: Google Maps
                  </span>
                )}
              </div>
              <h4 className="text-sm font-medium truncate mt-0.5">
                {action.city || action.formattedAddress || 'Resolved Location'}
              </h4>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {onDismiss && (
              <button
                id="dismiss-maps-card-btn"
                type="button"
                onClick={onDismiss}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors cursor-pointer"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {action.formattedAddress && (
          <div className="mt-2.5 pl-11">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-0.5">
              Current Address (Google Maps):
            </span>
            <p className="text-xs text-slate-200 font-medium leading-relaxed select-all">
              {action.formattedAddress}
            </p>
          </div>
        )}

        {/* Google Maps Grounding Places & Links */}
        {action.mapsGrounding && action.mapsGrounding.length > 0 && (
          <div className="mt-3 pl-11 space-y-2 border-t border-blue-500/20 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                <Navigation className="w-3 h-3" />
                Google Maps Grounded Places ({action.mapsGrounding.length})
              </span>
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Live Data
              </span>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {action.mapsGrounding.map((place, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-xl bg-blue-950/40 border border-blue-500/20 hover:border-blue-400/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-white">
                      {place.title}
                    </span>
                    {place.uri && (
                      <a
                        href={place.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 font-medium bg-blue-500/10 hover:bg-blue-500/20 px-2 py-0.5 rounded-lg border border-blue-500/25 shrink-0"
                        title={`Open ${place.title} on Google Maps`}
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>View</span>
                      </a>
                    )}
                  </div>

                  {/* Review Snippets from Maps Grounding */}
                  {place.reviewSnippets && place.reviewSnippets.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      {place.reviewSnippets.map((snippet, sIdx) => (
                        <p key={sIdx} className="text-[11px] text-slate-300 italic bg-blue-900/20 p-1.5 rounded-lg border border-blue-500/10">
                          "{snippet}"
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {action.usedAlternative && (
          <div className="mt-1 pl-11">
            <p className="text-[10px] text-amber-400/80 font-mono">
              Google Maps was her first priority, but direct fix was unavailable ({action.mapsFailureReason || 'permission denied'}). Switched to network alternative.
            </p>
          </div>
        )}

        {formattedCoord && (
          <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-2 pl-11 font-mono flex-wrap">
            <Crosshair className="w-3.5 h-3.5 text-blue-400/80 shrink-0" />
            <span>{formattedCoord}</span>
          </div>
        )}

        {/* Embedded Map Toggle View */}
        {showEmbed && action.embedUrl && (
          <div className="mt-3 rounded-xl overflow-hidden border border-blue-500/30 shadow-inner h-48 w-full bg-black/40">
            <iframe
              title="Google Maps Location Preview"
              src={action.embedUrl}
              className="w-full h-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </div>
        )}

        <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-white/10">
          <button
            id="open-in-google-maps-btn"
            type="button"
            onClick={handleOpenGoogleMaps}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/30 transition-all active:scale-[0.98] cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Google Maps
          </button>

          {action.embedUrl && (
            <button
              id="toggle-map-preview-btn"
              type="button"
              onClick={() => setShowEmbed(!showEmbed)}
              className="px-3 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              {showEmbed ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5" />
                  Hide Map
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5" />
                  Preview Map
                </>
              )}
            </button>
          )}

          {handleChange && (
            <button
              id="change-location-btn"
              type="button"
              onClick={handleChange}
              className="px-2.5 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
              title="Change location or search city"
            >
              Change
            </button>
          )}

          <button
            id="copy-location-btn"
            type="button"
            onClick={handleCopy}
            className="p-2 rounded-xl text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
            title="Copy coordinates and address"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
