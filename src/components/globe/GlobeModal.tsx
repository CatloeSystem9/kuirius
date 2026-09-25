import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Search,
  RotateCcw,
  Plus,
  Minus,
  MapPin,
  Layers,
  Compass,
  Wind,
  Navigation,
  Globe2,
  Check,
  ExternalLink,
  ChevronRight,
  Info,
} from 'lucide-react';
import { EarthCanvas } from './EarthCanvas';
import {
  GlobeCoordinates,
  GlobeMarker,
  MapLayerType,
  GlobeControllerHandle,
  GlobeSearchResult,
} from './types';
import { AVAILABLE_LAYERS, FUTURE_WEATHER_OVERLAYS } from './layerManager';
import { GlobeAction, UserLocation } from '../../types';

interface GlobeModalProps {
  isOpen: boolean;
  onClose: () => void;
  userLocation?: UserLocation | null;
  initialAction?: GlobeAction | null;
  onActionComplete?: () => void;
}

export const GlobeModal: React.FC<GlobeModalProps> = ({
  isOpen,
  onClose,
  userLocation,
  initialAction,
  onActionComplete,
}) => {
  const globeRef = useRef<GlobeControllerHandle | null>(null);

  // UI & Layer State
  const [activeLayer, setActiveLayer] = useState<MapLayerType>('satellite');
  const [cursorCoords, setCursorCoords] = useState<GlobeCoordinates | null>(null);
  const [selectedPin, setSelectedPin] = useState<GlobeMarker | null>(null);
  const [isLayerMenuOpen, setIsLayerMenuOpen] = useState(false);
  const [isWeatherPreviewOpen, setIsWeatherPreviewOpen] = useState(false);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GlobeSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Handle Initial / Agent-triggered Actions
  useEffect(() => {
    if (!isOpen || !initialAction) return;

    const timer = setTimeout(async () => {
      if (!globeRef.current) return;

      if (initialAction.type === 'fly_to' && initialAction.lat !== undefined && initialAction.lng !== undefined) {
        await globeRef.current.flyTo(initialAction.lat, initialAction.lng, initialAction.zoom || 145);
        const pin: GlobeMarker = {
          id: 'agent_pin_' + Date.now(),
          lat: initialAction.lat,
          lng: initialAction.lng,
          label: initialAction.locationName || 'Target Location',
        };
        setSelectedPin(pin);
        globeRef.current.addMarker(pin);
      } else if (initialAction.type === 'set_layer' && initialAction.layer) {
        setActiveLayer(initialAction.layer);
      } else if (initialAction.type === 'reset_view') {
        await globeRef.current.resetToEarthView();
        setSelectedPin(null);
        globeRef.current.clearMarkers();
      }

      onActionComplete?.();
    }, 350);

    return () => clearTimeout(timer);
  }, [isOpen, initialAction]);

  if (!isOpen) return null;

  // Search Geocoding Handler using open endpoints
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      // 1. First try existing backend geocoding bridge
      const res = await fetch('/api/location/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: query }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.lat !== undefined && data.lng !== undefined) {
          const result: GlobeSearchResult = {
            name: data.city || data.formattedAddress || query,
            lat: data.lat,
            lng: data.lng,
            displayName: data.formattedAddress || `${data.city || query}, ${data.country || ''}`,
            country: data.country,
          };
          selectSearchResult(result);
          setIsSearching(false);
          return;
        }
      }

      // 2. OpenStreetMap Nominatim Fallback
      const osmRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=4&addressdetails=1`
      );
      if (osmRes.ok) {
        const osmData = await osmRes.json();
        if (Array.isArray(osmData) && osmData.length > 0) {
          const results: GlobeSearchResult[] = osmData.map((item: any) => ({
            name: item.name || item.display_name.split(',')[0],
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon),
            displayName: item.display_name,
            country: item.address?.country,
            category: item.type,
          }));

          if (results.length === 1) {
            selectSearchResult(results[0]);
          } else {
            setSearchResults(results);
          }
          setIsSearching(false);
          return;
        }
      }

      setSearchError(`No coordinates found for "${query}".`);
    } catch (err: any) {
      console.warn('Geocoding search error:', err);
      setSearchError('Search request failed. Please check network.');
    } finally {
      setIsSearching(false);
    }
  };

  const selectSearchResult = async (result: GlobeSearchResult) => {
    setSearchResults([]);
    setSearchQuery(result.name);
    const pin: GlobeMarker = {
      id: 'pin_' + Date.now(),
      lat: result.lat,
      lng: result.lng,
      label: result.name,
      sublabel: result.displayName,
    };
    setSelectedPin(pin);

    if (globeRef.current) {
      globeRef.current.addMarker(pin);
      await globeRef.current.flyTo(result.lat, result.lng, 140, 1600);
    }
  };

  const handleGlobeClick = (coords: GlobeCoordinates) => {
    const pin: GlobeMarker = {
      id: 'click_pin_' + Date.now(),
      lat: coords.lat,
      lng: coords.lng,
      label: `${coords.lat.toFixed(3)}°, ${coords.lng.toFixed(3)}°`,
    };
    setSelectedPin(pin);
    if (globeRef.current) {
      globeRef.current.addMarker(pin);
    }
  };

  const handleResetEarthView = () => {
    setSelectedPin(null);
    if (globeRef.current) {
      globeRef.current.clearMarkers();
      globeRef.current.resetToEarthView();
    }
  };

  const handleFlyToUserLocation = () => {
    if (!userLocation) return;
    const pin: GlobeMarker = {
      id: 'user_loc_pin',
      lat: userLocation.lat,
      lng: userLocation.lng,
      label: userLocation.city || 'Your Location',
      sublabel: userLocation.formattedAddress,
    };
    setSelectedPin(pin);
    if (globeRef.current) {
      globeRef.current.addMarker(pin);
      globeRef.current.flyTo(userLocation.lat, userLocation.lng, 135);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className="relative w-full h-full sm:max-w-6xl sm:h-[90vh] bg-[#030610] sm:rounded-3xl border border-blue-900/40 shadow-[0_0_60px_rgba(30,58,138,0.35)] flex flex-col overflow-hidden"
      >
        {/* Top Floating Header & Search Bar */}
        <header className="absolute top-0 inset-x-0 z-30 p-4 sm:p-5 flex flex-col sm:flex-row items-center justify-between gap-3 pointer-events-none">
          {/* Brand Badge */}
          <div className="flex items-center gap-3 bg-[#070c1a]/85 backdrop-blur-xl px-4 py-2.5 rounded-2xl border border-blue-800/40 shadow-lg pointer-events-auto self-start sm:self-auto">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-[0_0_10px_#3b82f6] animate-pulse" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold tracking-wider uppercase text-blue-100">
                  Krisha Earth
                </span>
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-blue-950/80 text-blue-400 border border-blue-800/50">
                  3D Geospatial
                </span>
              </div>
            </div>
          </div>

          {/* Search Box */}
          <div className="relative w-full sm:w-80 pointer-events-auto">
            <form onSubmit={handleSearch} className="relative flex items-center">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search city, country, or coordinate..."
                className="w-full bg-[#070c1a]/90 backdrop-blur-xl border border-blue-800/50 focus:border-blue-400 rounded-2xl pl-10 pr-10 py-2.5 text-xs text-blue-100 placeholder:text-blue-400/50 outline-none transition-all shadow-lg"
              />
              <Search className="w-4 h-4 text-blue-400 absolute left-3.5 pointer-events-none" />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                    setSearchError(null);
                  }}
                  className="absolute right-3 p-1 text-slate-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </form>

            {/* Autocomplete / Search Candidates Dropdown */}
            {searchResults.length > 0 && (
              <div className="absolute top-full mt-2 inset-x-0 bg-[#070c1a]/95 backdrop-blur-2xl border border-blue-800/60 rounded-2xl p-1.5 shadow-2xl z-40 max-h-56 overflow-y-auto">
                {searchResults.map((res, idx) => (
                  <button
                    key={idx}
                    onClick={() => selectSearchResult(res)}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs hover:bg-blue-900/40 text-blue-200 hover:text-white flex items-center justify-between group transition-colors"
                  >
                    <div className="truncate pr-2">
                      <div className="font-medium">{res.name}</div>
                      <div className="text-[10px] text-blue-400/70 truncate">{res.displayName}</div>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {searchError && (
              <div className="absolute top-full mt-1.5 inset-x-0 bg-red-950/90 border border-red-800/60 text-red-200 text-[11px] px-3 py-1.5 rounded-xl shadow-lg">
                {searchError}
              </div>
            )}
          </div>

          {/* Top Right Quick Controls */}
          <div className="flex items-center gap-2 pointer-events-auto self-end sm:self-auto">
            {/* Return to Earth View */}
            <button
              onClick={handleResetEarthView}
              title="Return to Full Earth View"
              className="p-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-blue-500 hover:bg-blue-950/50 rounded-2xl text-blue-300 hover:text-white transition-all shadow-lg cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              title="Return to Krisha"
              className="p-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-red-500 hover:bg-red-950/40 rounded-2xl text-slate-300 hover:text-white transition-all shadow-lg cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* 3D WebGL Earth Canvas Viewport */}
        <div className="relative flex-1 w-full h-full bg-[#02040a]">
          <EarthCanvas
            ref={globeRef}
            activeLayer={activeLayer}
            onCoordinatesChange={setCursorCoords}
            onLocationSelect={handleGlobeClick}
            selectedMarker={selectedPin}
          />
        </div>

        {/* Floating Left: Layer Switcher & Future Environmental Layers */}
        <div className="absolute bottom-6 left-6 z-30 flex flex-col gap-2 pointer-events-auto">
          {/* Layer Selector Dropdown Menu */}
          <AnimatePresence>
            {isLayerMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                className="p-2.5 bg-[#070c1a]/95 backdrop-blur-2xl border border-blue-800/60 rounded-2xl shadow-2xl w-60 space-y-1.5 mb-2"
              >
                <div className="text-[10px] font-mono uppercase text-blue-400/80 px-2 py-1 tracking-wider">
                  Base Imagery Layers
                </div>
                {(Object.keys(AVAILABLE_LAYERS) as MapLayerType[]).map((key) => {
                  const layer = AVAILABLE_LAYERS[key];
                  const isSelected = activeLayer === key;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setActiveLayer(key);
                        setIsLayerMenuOpen(false);
                      }}
                      className={`w-full text-left p-2 rounded-xl flex items-center justify-between text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-blue-600/30 text-blue-100 border border-blue-500/50'
                          : 'text-slate-300 hover:bg-blue-950/40 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className="w-3 h-3 rounded-full border border-white/20"
                          style={{ backgroundColor: layer.previewColor }}
                        />
                        <div>
                          <div className="font-medium">{layer.name}</div>
                          <div className="text-[9px] text-blue-400/60">{layer.badge}</div>
                        </div>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 text-blue-400" />}
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsLayerMenuOpen(!isLayerMenuOpen)}
              className="flex items-center gap-2 px-3.5 py-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-blue-500 hover:bg-blue-950/40 rounded-2xl text-xs text-blue-200 hover:text-white shadow-lg transition-all cursor-pointer"
            >
              <Layers className="w-4 h-4 text-blue-400" />
              <span>{AVAILABLE_LAYERS[activeLayer].name}</span>
            </button>

            {/* Environmental Architecture Button (Phase 2 Preview) */}
            <button
              onClick={() => setIsWeatherPreviewOpen(!isWeatherPreviewOpen)}
              title="Environmental & Live Wind Architecture"
              className="flex items-center gap-1.5 px-3 py-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-cyan-500 hover:bg-blue-950/40 rounded-2xl text-xs text-cyan-300 hover:text-white shadow-lg transition-all cursor-pointer"
            >
              <Wind className="w-4 h-4 text-cyan-400 animate-pulse" />
              <span className="hidden sm:inline">Weather Architecture</span>
            </button>
          </div>
        </div>

        {/* Floating Right: Zoom & Navigation Controls */}
        <div className="absolute bottom-6 right-6 z-30 flex flex-col gap-2 pointer-events-auto">
          {userLocation && (
            <button
              onClick={handleFlyToUserLocation}
              title={`Fly to My Location (${userLocation.city || 'Detected'})`}
              className="p-3 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-blue-500 hover:bg-blue-950/40 rounded-2xl text-blue-300 hover:text-white shadow-lg transition-all cursor-pointer"
            >
              <Navigation className="w-4 h-4" />
            </button>
          )}

          <div className="flex flex-col bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 rounded-2xl overflow-hidden shadow-lg">
            <button
              onClick={() => globeRef.current?.zoomIn()}
              title="Zoom In"
              className="p-3 hover:bg-blue-950/50 text-blue-300 hover:text-white border-b border-blue-900/40 transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={() => globeRef.current?.zoomOut()}
              title="Zoom Out"
              className="p-3 hover:bg-blue-950/50 text-blue-300 hover:text-white transition-colors cursor-pointer"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Bottom Coordinates & Pinned Location Info HUD */}
        <footer className="absolute bottom-2 inset-x-0 z-20 flex items-center justify-center pointer-events-none px-4">
          <div className="bg-[#050814]/85 backdrop-blur-xl border border-blue-900/40 px-4 py-1.5 rounded-full text-[11px] font-mono text-blue-300/80 shadow-lg flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>
                {cursorCoords
                  ? `CURSOR: ${Math.abs(cursorCoords.lat).toFixed(4)}° ${cursorCoords.lat >= 0 ? 'N' : 'S'}, ${Math.abs(
                      cursorCoords.lng
                    ).toFixed(4)}° ${cursorCoords.lng >= 0 ? 'E' : 'W'}`
                  : selectedPin
                  ? `PIN: ${selectedPin.label}`
                  : 'ROTATE: Drag • ZOOM: Scroll • SELECT: Click'}
              </span>
            </div>
            {selectedPin?.sublabel && (
              <span className="hidden md:inline text-blue-400/60 truncate max-w-xs">
                — {selectedPin.sublabel}
              </span>
            )}
          </div>
        </footer>

        {/* Environmental / Wind Architecture Modal Drawer (Phase 2 Roadmap) */}
        <AnimatePresence>
          {isWeatherPreviewOpen && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="absolute top-20 right-6 z-40 w-80 bg-[#070c1a]/95 backdrop-blur-2xl border border-blue-800/60 rounded-3xl p-5 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wind className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-cyan-100">
                    Atmospheric Engine
                  </span>
                </div>
                <button
                  onClick={() => setIsWeatherPreviewOpen(false)}
                  className="p-1 text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="text-[11px] text-blue-200/80 leading-relaxed">
                The Krisha geospatial layer manager has been architected to accept real-time global atmospheric and aerodynamic vector data.
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-mono uppercase text-blue-400 tracking-wider">
                  Planned Real-Time Overlays
                </div>
                {FUTURE_WEATHER_OVERLAYS.map((ov) => (
                  <div
                    key={ov.id}
                    className="p-2.5 rounded-xl bg-blue-950/30 border border-blue-900/40 text-xs"
                  >
                    <div className="flex items-center justify-between text-blue-200 font-medium">
                      <span>{ov.name}</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-blue-900/50 text-cyan-400">
                        {ov.provider}
                      </span>
                    </div>
                    <p className="text-[10px] text-blue-400/70 mt-1">{ov.description}</p>
                  </div>
                ))}
              </div>

              <div className="p-2.5 rounded-xl bg-cyan-950/30 border border-cyan-800/40 text-[10px] text-cyan-200/90 flex items-start gap-2">
                <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Free-First Real Data</strong>: Uses Open-Meteo & NOAA GFS APIs with 0 paid keys. Streamline flow particle simulation engine ready for Phase 2.
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
