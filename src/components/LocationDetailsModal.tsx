import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  MapPin,
  Navigation,
  ExternalLink,
  RefreshCw,
  Copy,
  Check,
  Globe,
  Radio,
  Search,
  Crosshair,
  AlertCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { UserLocation, MapsGroundingPlace } from '../types';
import { geocodeAddress, requestBrowserGps } from '../utils/locationService';

interface LocationDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  location: UserLocation | null;
  onRefreshLocation: () => Promise<void>;
  onUpdateLocation?: (loc: UserLocation) => void;
  isRefreshing?: boolean;
  onAskKrishaLocation?: () => void;
  isLightMode?: boolean;
}

export const LocationDetailsModal: React.FC<LocationDetailsModalProps> = ({
  isOpen,
  onClose,
  location,
  onRefreshLocation,
  onUpdateLocation,
  isRefreshing = false,
  onAskKrishaLocation,
  isLightMode = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [cityInput, setCityInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Maps Grounding state
  const [groundingQuery, setGroundingQuery] = useState('');
  const [isGroundingLoading, setIsGroundingLoading] = useState(false);
  const [groundingAnswer, setGroundingAnswer] = useState<string | null>(null);
  const [groundedPlaces, setGroundedPlaces] = useState<MapsGroundingPlace[]>([]);
  const [groundingError, setGroundingError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleExecuteMapsGrounding = async (q?: string) => {
    const queryToRun = (q || groundingQuery).trim();
    if (!queryToRun || isGroundingLoading) return;

    setIsGroundingLoading(true);
    setGroundingError(null);
    setGroundingAnswer(null);
    setGroundedPlaces([]);

    try {
      const res = await fetch('/api/maps/grounding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryToRun,
          userLocation: location ? { lat: location.lat, lng: location.lng } : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Maps grounding query failed');
      }

      setGroundingAnswer(data.text || '');
      setGroundedPlaces(data.mapsGrounding || []);
    } catch (err: any) {
      setGroundingError(err?.message || 'Failed to get Google Maps data');
    } finally {
      setIsGroundingLoading(false);
    }
  };

  const handleCopyCoords = () => {
    if (location) {
      const text = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)} (Accuracy: ±${Math.round(location.accuracy || 0)}m) - ${location.formattedAddress || ''}`;
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exactGoogleMapsUrl = location?.lat !== undefined && location?.lng !== undefined
    ? `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`
    : location?.googleMapsUrl;

  const handleOpenGoogleMaps = () => {
    if (exactGoogleMapsUrl) {
      window.open(exactGoogleMapsUrl, '_blank', 'noopener,noreferrer');
    }
  };

  // 1. Manual City Search & Pin
  const handleSearchCity = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = cityInput.trim();
    if (!query) return;

    setIsSearching(true);
    setStatusMessage({ text: `Locating "${query}" on Google Maps...`, type: 'info' });

    try {
      const resolved = await geocodeAddress(query);
      if (resolved) {
        if (onUpdateLocation) onUpdateLocation(resolved);
        setStatusMessage({
          text: `Location set to ${resolved.city || resolved.formattedAddress}! Krisha is now synced here.`,
          type: 'success',
        });
        setCityInput('');
      } else {
        setStatusMessage({
          text: `Could not find "${query}". Try adding country or a major city name.`,
          type: 'error',
        });
      }
    } catch {
      setStatusMessage({
        text: 'Failed to search location. Please check your internet connection.',
        type: 'error',
      });
    } finally {
      setIsSearching(false);
    }
  };

  // 2. High-Accuracy Device GPS Request (Source of Truth)
  const handleRequestGps = async () => {
    setIsSearching(true);
    setStatusMessage({
      text: 'Requesting device GPS (navigator.geolocation)... Please click "Allow" if prompted.',
      type: 'info',
    });

    try {
      const gpsLoc = await requestBrowserGps();
      if (gpsLoc) {
        if (onUpdateLocation) onUpdateLocation(gpsLoc);
        setStatusMessage({
          text: `Device GPS Signal Locked! Precision: ±${Math.round(gpsLoc.accuracy)}m (${gpsLoc.city || 'Your Exact Location'}).`,
          type: 'success',
        });
      }
    } catch (err: any) {
      console.warn('GPS prompt error:', err);
      const msg =
        err?.code === 1
          ? 'Browser location permission was denied. Please allow location in your browser settings or search your city above.'
          : 'GPS acquisition timed out. You can re-try or type your city name above to set your location.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <AnimatePresence>
      <div
        id="location-details-modal-backdrop"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          id="location-details-modal-container"
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className={`w-full max-w-xl rounded-2xl p-6 shadow-2xl border flex flex-col max-h-[92vh] overflow-hidden ${
            isLightMode
              ? 'bg-slate-50 border-slate-200 text-slate-800'
              : 'bg-[#060b18]/95 border-blue-500/20 text-slate-100 shadow-blue-950/40'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/15 border border-blue-400/30 flex items-center justify-center text-blue-400 shadow-sm shadow-blue-500/20">
                <MapPin className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold tracking-wide">Google Maps Location</h3>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    <Radio className="w-2.5 h-2.5 animate-pulse" />
                    Live Sync
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Krisha is synced with Google Maps to know your exact location in real-time
                </p>
              </div>
            </div>

            <button
              id="close-location-modal-btn"
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="py-4 overflow-y-auto space-y-4 flex-1 pr-1">
            {/* Status Message / Notification */}
            {statusMessage && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-3 rounded-xl text-xs flex items-start gap-2.5 border ${
                  statusMessage.type === 'success'
                    ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                    : statusMessage.type === 'error'
                    ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                    : 'bg-blue-950/40 border-blue-500/30 text-blue-300'
                }`}
              >
                {statusMessage.type === 'error' ? (
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                ) : statusMessage.type === 'success' ? (
                  <Check className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <Radio className="w-4 h-4 shrink-0 mt-0.5 animate-pulse" />
                )}
                <span className="flex-1 leading-relaxed">{statusMessage.text}</span>
              </motion.div>
            )}

            {/* Calibrate / Set Location Controls */}
            <div
              className={`p-4 rounded-xl border ${
                isLightMode ? 'bg-white border-slate-200' : 'bg-blue-950/20 border-blue-500/20'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
                  <Navigation className="w-3.5 h-3.5" />
                  Set Your Location / Search City
                </span>
              </div>

              {/* Quick City Search Form */}
              <form onSubmit={handleSearchCity} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="modal-city-input"
                    type="text"
                    value={cityInput}
                    onChange={(e) => setCityInput(e.target.value)}
                    placeholder="Type your city or area (e.g. Pune, Mumbai, London)..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-black/30 border border-white/10 text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
                <button
                  id="modal-search-city-btn"
                  type="submit"
                  disabled={isSearching || !cityInput.trim()}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors shrink-0 flex items-center gap-1.5"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  Pin City
                </button>
              </form>

              {/* Hardware GPS Trigger */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/10">
                <button
                  id="modal-trigger-gps-btn"
                  type="button"
                  onClick={handleRequestGps}
                  disabled={isSearching}
                  className="flex-1 py-2 px-3 rounded-lg text-xs font-medium bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                  title="Prompt browser for exact GPS coordinates"
                >
                  <Crosshair className="w-3.5 h-3.5 text-blue-400" />
                  Acquire Device GPS (navigator.geolocation)
                </button>

                <button
                  id="modal-sync-fresh-btn"
                  type="button"
                  onClick={onRefreshLocation}
                  disabled={isSearching || isRefreshing}
                  className="py-2 px-3 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 shrink-0"
                  title="Refresh location"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>

            {/* Currently Pinned Location Card */}
            {location ? (
              <>
                <div
                  className={`p-4 rounded-xl border ${
                    isLightMode ? 'bg-white border-slate-200' : 'bg-black/30 border-white/10'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5" />
                          Pinned Location
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono inline-flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3 text-emerald-400" />
                          {location.source === 'browser_gps' ? 'GPS Ground Truth' : 'Manual Search'}
                        </span>
                      </div>
                      <h4 className="text-base font-medium mt-1">
                        {location.city || 'Detected Location'}
                        {location.country ? `, ${location.country}` : ''}
                      </h4>
                      {location.formattedAddress && (
                        <p className="text-xs text-slate-300/80 mt-1 leading-relaxed">
                          {location.formattedAddress}
                        </p>
                      )}
                    </div>

                    <button
                      id="copy-modal-coords-btn"
                      type="button"
                      onClick={handleCopyCoords}
                      className="p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors shrink-0"
                      title="Copy Coordinates"
                    >
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>

                  {/* High precision verified GPS metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3 pt-3 border-t border-white/10 text-xs font-mono">
                    <div className="flex flex-col gap-0.5 bg-white/5 p-2 rounded-lg">
                      <span className="text-[10px] uppercase text-slate-400 font-sans">Latitude</span>
                      <span className="text-white font-semibold">
                        {Math.abs(location.lat).toFixed(6)}° {location.lat >= 0 ? 'N' : 'S'}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 bg-white/5 p-2 rounded-lg">
                      <span className="text-[10px] uppercase text-slate-400 font-sans">Longitude</span>
                      <span className="text-white font-semibold">
                        {Math.abs(location.lng).toFixed(6)}° {location.lng >= 0 ? 'E' : 'W'}
                      </span>
                    </div>
                    <div className="col-span-2 sm:col-span-1 flex flex-col gap-0.5 bg-white/5 p-2 rounded-lg">
                      <span className="text-[10px] uppercase text-slate-400 font-sans">Accuracy</span>
                      <span className="text-emerald-400 font-semibold">
                        ±{Math.round(location.accuracy || 15)}m
                      </span>
                    </div>
                  </div>
                </div>

                {/* Google Maps Embed / Interactive Preview */}
                <div className="rounded-xl overflow-hidden border border-blue-500/25 shadow-lg h-56 w-full relative bg-black/50">
                  {location.embedUrl ? (
                    <iframe
                      title="Google Maps Interactive View"
                      src={location.embedUrl}
                      className="w-full h-full border-0"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-2 p-4 text-center">
                      <Globe className="w-8 h-8 text-blue-400/50" />
                      <p className="text-xs">Location coordinates resolved</p>
                    </div>
                  )}
                </div>

                {/* Google Maps Grounding Exploration Tool */}
                <div className="p-4 rounded-xl bg-blue-950/25 border border-blue-500/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      Explore with Google Maps Grounding
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      gemini-3.5-flash
                    </span>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleExecuteMapsGrounding();
                    }}
                    className="flex items-center gap-2"
                  >
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search nearby cafes, restaurants, sights with Google Maps..."
                        value={groundingQuery}
                        onChange={(e) => setGroundingQuery(e.target.value)}
                        className={`w-full pl-9 pr-3 py-2 rounded-xl text-xs focus:outline-none transition-colors border ${
                          isLightMode
                            ? 'bg-white border-slate-300 text-slate-800'
                            : 'bg-black/40 border-blue-900/40 text-slate-100 placeholder-slate-500 focus:border-blue-500'
                        }`}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isGroundingLoading || !groundingQuery.trim()}
                      className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors shrink-0 flex items-center gap-1.5 cursor-pointer shadow-sm shadow-emerald-900/30"
                    >
                      {isGroundingLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                      Search
                    </button>
                  </form>

                  {/* Suggestion Chips */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {[
                      'Top cafes near me',
                      'Best dinner restaurants',
                      'Must-visit sights and attractions',
                      'Popular shopping spots',
                    ].map((chip, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setGroundingQuery(chip);
                          handleExecuteMapsGrounding(chip);
                        }}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-900/30 hover:bg-blue-800/40 text-blue-200 border border-blue-500/20 transition-colors cursor-pointer"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>

                  {/* Grounding Error */}
                  {groundingError && (
                    <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                      {groundingError}
                    </div>
                  )}

                  {/* Grounded Answer and Place Links */}
                  {groundingAnswer && (
                    <div className="space-y-2 pt-2 border-t border-blue-900/30">
                      <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                        {groundingAnswer}
                      </p>

                      {groundedPlaces.length > 0 && (
                        <div className="space-y-1.5 pt-2">
                          <span className="text-[11px] font-semibold text-emerald-400 block">
                            Direct Google Maps Links:
                          </span>
                          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                            {groundedPlaces.map((place, pIdx) => (
                              <div
                                key={pIdx}
                                className="p-2 rounded-lg bg-black/40 border border-blue-500/20 flex items-start justify-between gap-2"
                              >
                                <span className="text-xs font-medium text-white">{place.title}</span>
                                {place.uri && (
                                  <a
                                    href={place.uri}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[11px] text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 shrink-0 font-mono bg-blue-500/15 px-2 py-0.5 rounded"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                    Maps
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Companion Integration Note */}
                <div className="p-3 rounded-xl bg-blue-950/30 border border-blue-500/20 text-xs text-blue-200/90 flex items-start gap-2.5">
                  <span className="text-base">📍</span>
                  <p className="leading-relaxed">
                    Krisha has this spot saved in her active memory. You can also tell her in chat:
                    <span className="font-semibold text-white"> &quot;I am in Mumbai&quot;</span> or{' '}
                    <span className="font-semibold text-white">&quot;I live in Pune&quot;</span>, and she will update
                    instantly!
                  </p>
                </div>
              </>
            ) : (
              <div className="py-8 flex flex-col items-center justify-center text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 animate-pulse">
                  <Navigation className="w-6 h-6" />
                </div>
                <h4 className="text-sm font-medium">No location pinned yet</h4>
                <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
                  Click &quot;Use Device GPS&quot;, type your city above, or click &quot;Network Auto-Detect&quot; to pin
                  your location.
                </p>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-white/10 flex items-center justify-between gap-3 shrink-0">
            <button
              id="refresh-location-btn"
              type="button"
              disabled={isRefreshing}
              onClick={onRefreshLocation}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Syncing...' : 'Sync Background'}
            </button>

            <div className="flex items-center gap-2">
              {onAskKrishaLocation && (
                <button
                  id="ask-krisha-location-btn"
                  type="button"
                  onClick={() => {
                    onClose();
                    onAskKrishaLocation();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 border border-purple-500/30 transition-all"
                >
                  Ask Krisha &quot;Where am I?&quot;
                </button>
              )}

              {location?.googleMapsUrl && (
                <button
                  id="modal-open-google-maps-btn"
                  type="button"
                  onClick={handleOpenGoogleMaps}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/40 transition-all"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Google Maps
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
