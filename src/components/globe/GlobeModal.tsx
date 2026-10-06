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
  Loader2,
  Box,
} from 'lucide-react';
import { EarthCanvas } from './EarthCanvas';
import { EarthViewAdapter } from './providers';
import {
  GlobeCoordinates,
  GlobeMarker,
  MapLayerType,
  GlobeControllerHandle,
  GlobeSearchResult,
  WindInfoReading,
} from './types';
import { AVAILABLE_LAYERS, FUTURE_WEATHER_OVERLAYS } from './layerManager';
import { GlobeAction, UserLocation } from '../../types';
import { WEATHER_ATTRIBUTION, WindStatusMeta } from './environment/envService';

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

  // Environmental (wind) layer state
  const [windEnabled, setWindEnabled] = useState(false);
  const [windStatus, setWindStatus] = useState<WindStatusMeta | null>(null);
  const [windAtPin, setWindAtPin] = useState<WindInfoReading | null>(null);
  const [isLoadingPinWind, setIsLoadingPinWind] = useState(false);

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
      } else if (initialAction.type === 'wind_on') {
        setWindEnabled(true);
        setIsWeatherPreviewOpen(true);
        if (initialAction.lat !== undefined && initialAction.lng !== undefined) {
          await globeRef.current.flyTo(initialAction.lat, initialAction.lng, initialAction.zoom || 145);
          const pin: GlobeMarker = {
            id: 'agent_pin_' + Date.now(),
            lat: initialAction.lat,
            lng: initialAction.lng,
            label: initialAction.locationName || 'Target Location',
          };
          setSelectedPin(pin);
          globeRef.current.addMarker(pin);
        }
      } else if (initialAction.type === 'wind_off') {
        setWindEnabled(false);
      } else if (initialAction.type === 'zoom_detail') {
        if (initialAction.lat !== undefined && initialAction.lng !== undefined) {
          await globeRef.current.flyTo(initialAction.lat, initialAction.lng, initialAction.zoom || 120);
          globeRef.current.setDetailLevel?.(initialAction.detailLevel || 'city');
          const pin: GlobeMarker = {
            id: 'agent_pin_' + Date.now(),
            lat: initialAction.lat,
            lng: initialAction.lng,
            label: initialAction.locationName || 'High Detail View',
          };
          setSelectedPin(pin);
          globeRef.current.addMarker(pin);
        } else {
          globeRef.current.setDetailLevel?.(initialAction.detailLevel || 'photorealistic_3d');
        }
      } else if (initialAction.type === 'set_detail_mode') {
        if (initialAction.engineMode) {
          globeRef.current.setEngineMode?.(initialAction.engineMode);
        }
        if (initialAction.detailLevel) {
          globeRef.current.setDetailLevel?.(initialAction.detailLevel);
        }
      } else if (initialAction.type === 'reset_view') {
        await globeRef.current.resetToEarthView();
        setSelectedPin(null);
        globeRef.current.clearMarkers();
      }

      onActionComplete?.();
    }, 350);

    return () => clearTimeout(timer);
  }, [isOpen, initialAction]);

  // Inspect real wind data at the selected pin when the layer is active.
  useEffect(() => {
    if (!windEnabled || !selectedPin) {
      setWindAtPin(null);
      setIsLoadingPinWind(false);
      return;
    }
    let cancelled = false;
    setIsLoadingPinWind(true);
    globeRef.current
      ?.getWindReadingAt(selectedPin.lat, selectedPin.lng)
      .then((reading) => {
        if (cancelled) return;
        setWindAtPin(reading);
        setIsLoadingPinWind(false);
      })
      .catch(() => {
        if (cancelled) return;
        setWindAtPin(null);
        setIsLoadingPinWind(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPin, windEnabled]);

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
      await globeRef.current.flyTo(result.lat, result.lng, 128, 1600);
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
        <header className="absolute top-0 inset-x-0 z-30 p-3 sm:p-4 flex items-center justify-between gap-2.5 sm:gap-4 pointer-events-none">
          {/* Brand Badge */}
          <div className="flex items-center gap-2.5 bg-[#070c1a]/90 backdrop-blur-xl px-3 sm:px-4 py-2 rounded-2xl border border-blue-800/40 shadow-lg pointer-events-auto shrink-0">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-[0_0_10px_#3b82f6] animate-pulse shrink-0" />
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-wider uppercase text-blue-100 whitespace-nowrap">
                Krisha Earth
              </span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-blue-950/80 text-blue-400 border border-blue-800/50 whitespace-nowrap hidden sm:inline">
                3D Geospatial
              </span>
            </div>
          </div>

          {/* Search Box (positioned on right side before action buttons, leaving center completely open) */}
          <div className="relative w-36 sm:w-52 md:w-64 pointer-events-auto ml-auto">
            <form onSubmit={handleSearch} className="relative flex items-center">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search city or coord..."
                className="w-full bg-[#070c1a]/90 backdrop-blur-xl border border-blue-800/50 focus:border-cyan-400 rounded-2xl pl-8 pr-7 py-2 text-xs text-blue-100 placeholder:text-blue-400/50 outline-none transition-all shadow-lg"
              />
              <Search className="w-3.5 h-3.5 text-blue-400 absolute left-2.5 pointer-events-none" />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                    setSearchError(null);
                  }}
                  className="absolute right-2 p-1 text-slate-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
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
          <div className="flex items-center gap-1.5 sm:gap-2 pointer-events-auto shrink-0">
            {/* Return to Earth View */}
            <button
              onClick={handleResetEarthView}
              title="Return to Full Earth View"
              className="p-2 sm:p-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-blue-500 hover:bg-blue-950/50 rounded-2xl text-blue-300 hover:text-white transition-all shadow-lg cursor-pointer shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              title="Return to Krisha"
              className="p-2 sm:p-2.5 bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-red-500 hover:bg-red-950/40 rounded-2xl text-slate-300 hover:text-white transition-all shadow-lg cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
          </div>
        </header>

        {/* 3D WebGL Earth & Google Earth Viewport */}
        <div className="relative flex-1 w-full h-full bg-[#02040a]">
          <EarthViewAdapter
            ref={globeRef}
            activeLayer={activeLayer}
            onCoordinatesChange={setCursorCoords}
            onLocationSelect={handleGlobeClick}
            selectedMarker={selectedPin}
            windEnabled={windEnabled}
            onWindStatusChange={setWindStatus}
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

            {/* Live Wind Layer Toggle */}
            <button
              onClick={() => setWindEnabled(!windEnabled)}
              title={windEnabled ? 'Turn off wind currents' : 'Show live wind currents'}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-2xl text-xs shadow-lg transition-all cursor-pointer ${
                windEnabled
                  ? 'bg-cyan-950/70 border border-cyan-500/60 text-cyan-100'
                  : 'bg-[#070c1a]/85 backdrop-blur-xl border border-blue-800/40 hover:border-cyan-500 hover:bg-blue-950/40 text-cyan-300 hover:text-white'
              }`}
            >
              <Wind
                className={`w-4 h-4 ${
                  windStatus?.status === 'live'
                    ? 'text-cyan-300 shadow-[0_0_8px_#22d3ee]'
                    : 'text-cyan-400'
                }`}
              />
              <span>Wind</span>
              {windEnabled && (
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    windStatus?.status === 'live'
                      ? 'bg-cyan-300 shadow-[0_0_6px_#22d3ee]'
                      : windStatus?.status === 'loading'
                      ? 'bg-amber-300 animate-pulse'
                      : windStatus?.status === 'error' || windStatus?.status === 'stale'
                      ? 'bg-red-400'
                      : 'bg-amber-300'
                  }`}
                />
              )}
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

          {/* 3D Tilt / Perspective Toggle */}
          <button
            onClick={() => globeRef.current?.toggleTilt?.()}
            title="Toggle 3D Perspective Tilt (0° top-down / 60° 3D buildings)"
            className="p-3 bg-[#070c1a]/85 backdrop-blur-xl border border-cyan-800/40 hover:border-cyan-400 hover:bg-cyan-950/40 rounded-2xl text-cyan-300 hover:text-white shadow-lg transition-all cursor-pointer flex items-center justify-center group"
          >
            <Box className="w-4 h-4 group-hover:scale-110 transition-transform" />
          </button>

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
            {windEnabled && windAtPin && (
              <span className="hidden sm:inline text-cyan-300/90 truncate">
                | WIND: {windAtPin.speedKmh} km/h {windAtPin.cardinal}
                {windAtPin.stale ? ' (stale)' : ''}
              </span>
            )}
            {windEnabled && !windAtPin && windStatus?.status === 'error' && (
              <span className="hidden sm:inline text-red-400/80">| WIND: live data unavailable</span>
            )}
          </div>
        </footer>

        {/* Atmospheric Engine Panel (live wind layer status & info) */}
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

              {/* Wind Layer Toggle */}
              <button
                onClick={() => setWindEnabled(!windEnabled)}
                className={`w-full flex items-center justify-between p-2.5 rounded-xl text-xs transition-colors cursor-pointer ${
                  windEnabled
                    ? 'bg-cyan-600/25 text-cyan-100 border border-cyan-500/50'
                    : 'bg-blue-950/30 text-slate-300 border border-blue-900/40 hover:border-cyan-500/40 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Wind className={`w-4 h-4 ${windEnabled ? 'text-cyan-300' : 'text-cyan-400/70'}`} />
                  <span className="font-medium">Live Wind Currents</span>
                </span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase ${
                    windEnabled ? 'bg-cyan-900/60 text-cyan-300' : 'bg-blue-900/50 text-slate-400'
                  }`}
                >
                  {windEnabled ? 'Active' : 'Off'}
                </span>
              </button>

              {/* Layer status */}
              {windEnabled && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-blue-400 font-mono uppercase tracking-wider">Data Feed</span>
                    <span
                      className={`flex items-center gap-1.5 font-mono ${
                        windStatus?.status === 'live'
                          ? 'text-cyan-300'
                          : windStatus?.status === 'loading'
                          ? 'text-amber-300'
                          : windStatus?.status === 'stale'
                          ? 'text-orange-300'
                          : windStatus?.status === 'error'
                          ? 'text-red-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {windStatus?.status === 'live' && <span className="w-1.5 h-1.5 rounded-full bg-cyan-300" />}
                      {windStatus?.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin" />}
                      {windStatus?.status === 'stale' && <Info className="w-3 h-3" />}
                      {windStatus?.status === 'error' && <Info className="w-3 h-3" />}
                      {windStatus?.status ?? 'waiting'}
                    </span>
                  </div>

                  {windStatus?.status === 'error' && (
                    <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-800/50 text-[10px] text-red-200">
                      Live data unavailable{windStatus.message ? `: ${windStatus.message}` : ''}. Check your
                      connection — the globe itself keeps working.
                    </div>
                  )}

                  {windStatus?.status === 'stale' && (
                    <div className="p-2.5 rounded-xl bg-orange-950/40 border border-orange-800/50 text-[10px] text-orange-200">
                      Showing the last valid wind field — refresh failed, retrying periodically.
                    </div>
                  )}

                  {windStatus && windStatus.vectorCount > 0 && (
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="p-2 rounded-lg bg-blue-950/30 border border-blue-900/40">
                        <div className="text-blue-400/70 font-mono uppercase">Points</div>
                        <div className="text-blue-200 font-mono">{windStatus.vectorCount}</div>
                      </div>
                      <div className="p-2 rounded-lg bg-blue-950/30 border border-blue-900/40">
                        <div className="text-blue-400/70 font-mono uppercase">Updated</div>
                        <div className="text-blue-200 font-mono">
                          {new Date(windStatus.fetchedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Selected location wind inspection */}
              {windEnabled && selectedPin && (
                <div className="space-y-2">
                  <div className="text-[10px] font-mono uppercase text-blue-400 tracking-wider flex items-center gap-1.5">
                    <MapPin className="w-3 h-3" />
                    Wind at selected location
                  </div>
                  {isLoadingPinWind ? (
                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-blue-950/30 border border-blue-900/40 text-[10px] text-blue-300">
                      <Loader2 className="w-3 h-3 animate-spin" /> Reading wind field...
                    </div>
                  ) : windAtPin ? (
                    <div className="p-2.5 rounded-xl bg-cyan-950/30 border border-cyan-800/40 space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-lg text-cyan-100 font-mono">{windAtPin.speedKmh} km/h</span>
                        <span className="text-[10px] font-mono text-cyan-300">
                          FROM {windAtPin.directionDeg.toFixed(0)}° {windAtPin.cardinal}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-cyan-400/80">
                        {windAtPin.lat.toFixed(3)}°, {windAtPin.lng.toFixed(3)}°
                        {windAtPin.stale ? ' · stale data' : ' · live'}
                      </div>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-blue-950/30 border border-blue-900/40 text-[10px] text-blue-300/80">
                      Live data unavailable for this location.
                    </div>
                  )}
                </div>
              )}

              <div className="p-2.5 rounded-xl bg-cyan-950/30 border border-cyan-800/40 text-[10px] text-cyan-200/90 flex items-start gap-2">
                <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Free-First Real Data</strong>: {WEATHER_ATTRIBUTION}. No paid keys. Flow follows real
                  vector data — never random movement.
                </span>
              </div>

              {/* Future overlays (architecture roadmap, not yet implemented) */}
              <div className="space-y-1">
                <div className="text-[10px] font-mono uppercase text-blue-500/70 tracking-wider">
                  Planned environmental layers
                </div>
                {FUTURE_WEATHER_OVERLAYS.filter((ov) => ov.id !== 'wind_particles').map((ov) => (
                  <div
                    key={ov.id}
                    className="px-2.5 py-1.5 rounded-lg bg-blue-950/20 border border-blue-950/60 text-[10px] text-blue-400/60 flex items-center justify-between"
                  >
                    <span>{ov.name}</span>
                    <span className="font-mono text-[8px] uppercase">soon</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
