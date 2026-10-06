import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from 'react';
import { EarthCanvas, DEFAULT_DISTANCE, MAX_DISTANCE } from '../EarthCanvas';
import {
  GlobeCoordinates,
  GlobeMarker,
  MapLayerType,
  GlobeControllerHandle,
  WindInfoReading,
} from '../types';
import { WindStatusMeta } from '../environment/envService';
import {
  CameraState,
  EarthDetailLevel,
  EarthEngineMode,
} from './types';
import { GoogleEarthProvider } from './GoogleEarthProvider';
import { EarthDetailController } from './EarthDetailController';
import { DEFAULT_MAPS_API_KEY } from './mapsLoader';
import { Sparkles, Globe, Eye, Layers, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react';

export interface EarthViewAdapterProps {
  activeLayer: MapLayerType;
  onCoordinatesChange?: (coords: GlobeCoordinates | null) => void;
  onLocationSelect?: (coords: GlobeCoordinates) => void;
  initialLat?: number;
  initialLng?: number;
  selectedMarker?: GlobeMarker | null;
  windEnabled?: boolean;
  onWindStatusChange?: (meta: WindStatusMeta) => void;
  onEngineModeChange?: (mode: EarthEngineMode) => void;
  onDetailLevelChange?: (level: EarthDetailLevel) => void;
}

export const EarthViewAdapter = forwardRef<GlobeControllerHandle, EarthViewAdapterProps>(
  (
    {
      activeLayer,
      onCoordinatesChange,
      onLocationSelect,
      initialLat = 20,
      initialLng = 0,
      selectedMarker,
      windEnabled = false,
      onWindStatusChange,
      onEngineModeChange,
      onDetailLevelChange,
    },
    ref
  ) => {
    const threeGlobeRef = useRef<GlobeControllerHandle | null>(null);
    const googleEarthContainerRef = useRef<HTMLDivElement>(null);
    const googleEarthProviderRef = useRef<GoogleEarthProvider | null>(null);
    const controllerRef = useRef<EarthDetailController>(new EarthDetailController('threejs'));

    const [engineMode, setEngineMode] = useState<EarthEngineMode>('threejs');
    const [detailLevel, setDetailLevel] = useState<EarthDetailLevel>('globe');
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [isGoogleEarthReady, setIsGoogleEarthReady] = useState(false);
    const [isGoogleEarthLoading, setIsGoogleEarthLoading] = useState(false);
    const [googleEarthError, setGoogleEarthError] = useState<string | null>(null);

    // Track active coordinates to maintain spatial continuity across transitions
    const currentCoordsRef = useRef<GlobeCoordinates>({
      lat: initialLat,
      lng: initialLng,
      altitude: 0,
    });

    const currentCameraRef = useRef<CameraState>({
      lat: initialLat,
      lng: initialLng,
      altitudeMeters: 0,
      rangeMeters: 2500000,
      heading: 0,
      tilt: 0,
    });

    // 1. Subscribe to controller LOD & engine state changes
    useEffect(() => {
      const controller = controllerRef.current;
      const unsubscribe = controller.subscribe({
        onModeChange: (newMode) => {
          setEngineMode(newMode);
          onEngineModeChange?.(newMode);
          if (newMode === 'google_earth') {
            if (!isGoogleEarthReady && !googleEarthError) {
              initGoogleEarth();
            } else if (googleEarthProviderRef.current) {
              const targetCam = EarthDetailController.threeCoordsToGoogleCamera(currentCoordsRef.current, 130);
              googleEarthProviderRef.current.flyTo(targetCam, 600);
            }
          } else if (newMode === 'threejs') {
            // When returning to Three.js globe view, ensure camera starts at least at DEFAULT_DISTANCE
            // or deeper in space if returning from a zoomed-out view
            const targetDist = Math.max(
              DEFAULT_DISTANCE,
              EarthDetailController.googleCameraToThreeDistance(currentCameraRef.current)
            );
            threeGlobeRef.current?.flyTo(
              currentCoordsRef.current.lat,
              currentCoordsRef.current.lng,
              targetDist,
              600
            );
          }
        },
        onDetailLevelChange: (newLevel) => {
          setDetailLevel(newLevel);
          onDetailLevelChange?.(newLevel);
        },
        onTransitionChange: (trans) => {
          setIsTransitioning(trans);
        },
      });

      return () => {
        unsubscribe();
      };
    }, [isGoogleEarthReady, googleEarthError, onEngineModeChange, onDetailLevelChange]);

    // 2. Initialize Google Earth Provider on demand (Progressive Loading to save bandwidth/GPU)
    const initGoogleEarth = useCallback(async () => {
      if (googleEarthProviderRef.current || isGoogleEarthLoading) return;
      if (!googleEarthContainerRef.current) return;

      setIsGoogleEarthLoading(true);
      setGoogleEarthError(null);

      const provider = new GoogleEarthProvider();
      googleEarthProviderRef.current = provider;

      const ok = await provider.init(googleEarthContainerRef.current, {
        apiKey: DEFAULT_MAPS_API_KEY,
        initialCamera: currentCameraRef.current,
        mode: activeLayer === 'standard' ? 'hybrid' : 'satellite',
        onCameraChange: (camera) => {
          currentCameraRef.current = camera;
          currentCoordsRef.current = {
            lat: camera.lat,
            lng: camera.lng,
            altitude: camera.altitudeMeters,
          };
          onCoordinatesChange?.(currentCoordsRef.current);

          // Evaluate range to detect if user zoomed far out into orbital distance
          controllerRef.current.evaluateGoogleEarthRange(camera.rangeMeters);
        },
        onCoordinatesClick: (coords) => {
          currentCoordsRef.current = coords;
          onLocationSelect?.(coords);
        },
        onError: (err) => {
          setGoogleEarthError(err.message || 'Google Earth 3D unavailable');
          setIsGoogleEarthReady(false);
          setIsGoogleEarthLoading(false);
          // Fall back seamlessly to Three.js globe
          controllerRef.current.setMode('threejs', 'globe');
        },
        onReady: () => {
          setIsGoogleEarthReady(true);
          setIsGoogleEarthLoading(false);
          if (selectedMarker) {
            provider.addMarker(selectedMarker);
          }
        },
      });

      if (!ok) {
        setIsGoogleEarthLoading(false);
      }
    }, [activeLayer, isGoogleEarthLoading, onCoordinatesChange, onLocationSelect, selectedMarker]);

    // Clean teardown on unmount
    useEffect(() => {
      return () => {
        if (googleEarthProviderRef.current) {
          googleEarthProviderRef.current.destroy();
          googleEarthProviderRef.current = null;
        }
      };
    }, []);

    // Synchronize markers to both Three.js and Google Earth
    useEffect(() => {
      if (selectedMarker && googleEarthProviderRef.current && isGoogleEarthReady) {
        googleEarthProviderRef.current.addMarker(selectedMarker);
      }
    }, [selectedMarker, isGoogleEarthReady]);

    // Handle layer changes
    useEffect(() => {
      if (googleEarthProviderRef.current && isGoogleEarthReady) {
        googleEarthProviderRef.current.setMode(activeLayer === 'standard' ? 'hybrid' : 'satellite');
      }
    }, [activeLayer, isGoogleEarthReady]);

    // Imperative controller methods exposed to parent
    useImperativeHandle(ref, () => ({
      flyTo: async (lat: number, lng: number, distance: number = 150, durationMs: number = 1600): Promise<void> => {
        currentCoordsRef.current = { lat, lng };

        // Check if destination zoom requests high detail
        const isHighDetailZoom = distance <= EarthDetailController.THREEJS_ZOOM_IN_THRESHOLD;

        if (isHighDetailZoom) {
          // Transition to Google Earth 3D view
          controllerRef.current.setMode('google_earth', distance <= 125 ? 'photorealistic_3d' : 'city');
          await initGoogleEarth();

          const targetCamera = EarthDetailController.threeCoordsToGoogleCamera({ lat, lng }, distance);
          currentCameraRef.current = targetCamera;

          if (googleEarthProviderRef.current) {
            await googleEarthProviderRef.current.flyTo(targetCamera, durationMs);
          }
          // Also keep Three.js in sync underneath
          threeGlobeRef.current?.flyTo(lat, lng, distance, durationMs);
        } else {
          // Far orbital zoom -> Use lightweight Three.js Earth
          controllerRef.current.setMode('threejs', 'globe');
          await threeGlobeRef.current?.flyTo(lat, lng, distance, durationMs);
        }
      },

      resetToEarthView: async (durationMs: number = 1200): Promise<void> => {
        controllerRef.current.setMode('threejs', 'globe');
        await threeGlobeRef.current?.resetToEarthView(durationMs);
      },

      zoomIn: () => {
        if (engineMode === 'google_earth' && googleEarthProviderRef.current) {
          const current = currentCameraRef.current;
          const nextRange = Math.max(800, current.rangeMeters * 0.6);
          const nextTilt = nextRange < 15000 ? Math.min(65, (current.tilt || 0) + 15) : current.tilt;
          googleEarthProviderRef.current.flyTo({ rangeMeters: nextRange, tilt: nextTilt }, 600);
        } else {
          threeGlobeRef.current?.zoomIn();
        }
      },

      zoomOut: () => {
        if (engineMode === 'google_earth' && googleEarthProviderRef.current) {
          const current = currentCameraRef.current;
          const nextRange = current.rangeMeters * 1.6;
          // If range is approaching or exceeding planetary threshold, return to Three.js orbital globe
          // and immediately zoom out into space!
          if (nextRange >= EarthDetailController.GOOGLE_EARTH_ZOOM_OUT_METERS || current.rangeMeters >= 6000000) {
            controllerRef.current.setMode('threejs', 'globe');
            setTimeout(() => {
              threeGlobeRef.current?.zoomOut();
            }, 80);
          } else {
            const nextTilt = nextRange > 30000 ? Math.max(0, (current.tilt || 0) - 15) : current.tilt;
            googleEarthProviderRef.current.flyTo({ rangeMeters: nextRange, tilt: nextTilt }, 600);
          }
        } else {
          threeGlobeRef.current?.zoomOut();
        }
      },

      toggleTilt: () => {
        if (engineMode === 'google_earth' && googleEarthProviderRef.current) {
          googleEarthProviderRef.current.toggleTilt();
        }
      },

      setLayer: (layer: MapLayerType) => {
        threeGlobeRef.current?.setLayer(layer);
        if (googleEarthProviderRef.current) {
          googleEarthProviderRef.current.setMode(layer === 'standard' ? 'hybrid' : 'satellite');
        }
      },

      getCoordinatesUnderCursor: () => {
        if (engineMode === 'google_earth') {
          return currentCoordsRef.current;
        }
        return threeGlobeRef.current?.getCoordinatesUnderCursor() || currentCoordsRef.current;
      },

      getCameraCoordinates: () => {
        if (engineMode === 'google_earth') {
          return currentCoordsRef.current;
        }
        return threeGlobeRef.current?.getCameraCoordinates() || currentCoordsRef.current;
      },

      addMarker: (marker: GlobeMarker) => {
        threeGlobeRef.current?.addMarker(marker);
        googleEarthProviderRef.current?.addMarker(marker);
      },

      clearMarkers: () => {
        threeGlobeRef.current?.clearMarkers();
        googleEarthProviderRef.current?.clearMarkers();
      },

      getWindReadingAt: (lat: number, lng: number) => {
        return threeGlobeRef.current?.getWindReadingAt(lat, lng) || Promise.resolve(null);
      },

      isWindDataReady: () => {
        return threeGlobeRef.current?.isWindDataReady() || false;
      },

      setDetailLevel: (level: 'globe' | 'regional' | 'city' | 'photorealistic_3d') => {
        if (level === 'globe') {
          controllerRef.current.setMode('threejs', 'globe');
        } else {
          controllerRef.current.setMode('google_earth', level);
          initGoogleEarth().then(() => {
            googleEarthProviderRef.current?.setDetailLevel(level);
          });
        }
      },

      setEngineMode: (mode: EarthEngineMode) => {
        controllerRef.current.setMode(mode);
        if (mode === 'google_earth') {
          initGoogleEarth();
        }
      },

      getEngineMode: () => engineMode,
      getDetailLevel: () => detailLevel,
    }));

    // Intercept Three.js coordinate changes to evaluate zoom threshold
    const handleThreeCoordinatesChange = (coords: GlobeCoordinates | null) => {
      if (coords) {
        currentCoordsRef.current = coords;
      }
      if (engineMode === 'threejs') {
        onCoordinatesChange?.(coords);
      }
    };

    // When zooming in close on the Three.js globe, progressively transition to Google Earth 3D!
    const handleThreeDistanceChange = (distance: number, coords: GlobeCoordinates) => {
      currentCoordsRef.current = coords;
      if (engineMode === 'threejs' && distance <= EarthDetailController.THREEJS_ZOOM_IN_THRESHOLD) {
        currentCameraRef.current = EarthDetailController.threeCoordsToGoogleCamera(coords, distance);
        controllerRef.current.setMode('google_earth', distance <= 122 ? 'photorealistic_3d' : 'city');
        initGoogleEarth();
      }
    };

    // Intercept wheel events on Google Earth container so scrolling out beyond planetary limits
    // smoothly transitions into Three.js deep space orbital view
    useEffect(() => {
      const container = googleEarthContainerRef.current;
      if (!container) return;

      let consecutiveZoomOutCount = 0;
      let lastZoomOutTime = 0;

      const handleWheelOnContainer = (e: WheelEvent) => {
        // deltaY > 0 indicates scrolling down / zooming out
        if (engineMode === 'google_earth' && e.deltaY > 0) {
          const now = Date.now();
          if (now - lastZoomOutTime > 1500) {
            consecutiveZoomOutCount = 0;
          }
          lastZoomOutTime = now;
          consecutiveZoomOutCount++;

          const range = currentCameraRef.current.rangeMeters;
          // Transition to Three.js if at planetary range or if user repeatedly zooms out at the limit
          if (range >= 6000000 || consecutiveZoomOutCount >= 3) {
            e.preventDefault();
            e.stopPropagation();
            consecutiveZoomOutCount = 0;
            controllerRef.current.setMode('threejs', 'globe');
            setTimeout(() => {
              threeGlobeRef.current?.zoomOut();
            }, 80);
          }
        }
      };

      container.addEventListener('wheel', handleWheelOnContainer, { passive: false });
      return () => {
        container.removeEventListener('wheel', handleWheelOnContainer);
      };
    }, [engineMode]);

    return (
      <div className="relative w-full h-full overflow-hidden select-none bg-[#02040a]">
        {/* 1. Underlying Three.js Earth Canvas (Orbital globe with Atmosphere & Wind) */}
        <div
          className={`absolute inset-0 w-full h-full transition-opacity duration-700 ${
            engineMode === 'threejs' ? 'opacity-100 pointer-events-auto z-10' : 'opacity-0 pointer-events-none z-0'
          }`}
        >
          <EarthCanvas
            ref={threeGlobeRef}
            activeLayer={activeLayer}
            onCoordinatesChange={handleThreeCoordinatesChange}
            onLocationSelect={onLocationSelect}
            initialLat={initialLat}
            initialLng={initialLng}
            selectedMarker={selectedMarker}
            windEnabled={windEnabled}
            onWindStatusChange={onWindStatusChange}
            onDistanceChange={handleThreeDistanceChange}
          />
        </div>

        {/* 2. Google Earth / Maps 3D Viewport (Photorealistic 3D Mesh & Terrain) */}
        <div
          ref={googleEarthContainerRef}
          className={`absolute inset-0 w-full h-full transition-opacity duration-700 ${
            engineMode === 'google_earth'
              ? 'opacity-100 pointer-events-auto z-10'
              : 'opacity-0 pointer-events-none z-0'
          }`}
        />

        {/* 3. Transition & Loading Shimmer Overlay */}
        {isTransitioning && (
          <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center bg-blue-950/20 backdrop-blur-[2px] transition-opacity duration-300">
            <div className="px-4 py-2 rounded-full bg-[#050814]/90 border border-blue-500/40 text-blue-200 text-xs flex items-center gap-2.5 shadow-[0_0_20px_rgba(59,130,246,0.3)] animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
              <span>
                {engineMode === 'google_earth'
                  ? 'Loading Google Earth 3D imagery...'
                  : 'Returning to planetary globe...'}
              </span>
            </div>
          </div>
        )}

        {/* 4. Google Earth Loading Indicator */}
        {isGoogleEarthLoading && !isTransitioning && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className="px-3.5 py-1.5 rounded-full bg-[#050814]/80 border border-blue-500/30 text-blue-300 text-[11px] flex items-center gap-2 backdrop-blur-sm">
              <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
              <span>Initializing Google Earth 3D...</span>
            </div>
          </div>
        )}

        {/* 5. Google Earth Error Toast Fallback */}
        {googleEarthError && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
            <div className="px-4 py-2 rounded-xl bg-amber-950/80 border border-amber-500/40 text-amber-200 text-xs flex items-center gap-2 backdrop-blur-md shadow-lg">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>{googleEarthError}. Using orbital Three.js Earth fallback.</span>
            </div>
          </div>
        )}

        {/* 6. Level-of-Detail & Mode Indicator HUD Badge (Top Center) */}
        <div className="absolute top-16 sm:top-3.5 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex items-center gap-2">
          {engineMode === 'threejs' ? (
            <div
              style={{ marginLeft: 0, marginRight: 0 }}
              className="mx-0 flex items-center gap-2 bg-[#050814]/85 border border-blue-500/30 hover:border-blue-400/60 rounded-full px-3 py-1.5 backdrop-blur-md shadow-[0_0_15px_rgba(59,130,246,0.15)] transition-all text-xs"
            >
              <Globe className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-blue-100 font-medium">Orbital Globe</span>
              <span className="text-blue-400/60 text-[10px] hidden sm:inline">|</span>
              <button
                type="button"
                onClick={() => {
                  controllerRef.current.setMode('google_earth', 'city');
                  initGoogleEarth();
                }}
                className="text-[11px] text-cyan-300 hover:text-white font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                title="Switch to Google Earth photorealistic 3D imagery"
              >
                <Sparkles className="w-3 h-3 text-cyan-400" />
                <span>Google Earth 3D</span>
              </button>
            </div>
          ) : (
            <div
              style={{ marginLeft: 0, marginRight: 0 }}
              className="mx-0 flex items-center gap-2 bg-[#050814]/90 border border-cyan-500/40 rounded-full px-3 py-1.5 backdrop-blur-md shadow-[0_0_20px_rgba(6,182,212,0.2)] text-xs"
            >
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]" />
              <span className="text-cyan-200 font-medium hidden sm:inline">Google Earth 3D</span>

              {/* Interactive Level-of-Detail Switcher Chips */}
              <div className="flex items-center gap-1 bg-[#020617]/70 p-0.5 rounded-full border border-cyan-500/20">
                <button
                  type="button"
                  onClick={() => googleEarthProviderRef.current?.setDetailLevel('regional')}
                  className={`text-[10px] px-2 py-0.5 rounded-full transition-all cursor-pointer ${
                    detailLevel === 'regional' || detailLevel === 'globe'
                      ? 'bg-cyan-600/40 text-cyan-100 border border-cyan-400/50 shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Regional satellite elevation overview"
                >
                  Regional
                </button>
                <button
                  type="button"
                  onClick={() => googleEarthProviderRef.current?.setDetailLevel('city')}
                  className={`text-[10px] px-2 py-0.5 rounded-full transition-all cursor-pointer ${
                    detailLevel === 'city'
                      ? 'bg-cyan-600/40 text-cyan-100 border border-cyan-400/50 shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="City-level 3D buildings & landmarks"
                >
                  City 3D
                </button>
                <button
                  type="button"
                  onClick={() => googleEarthProviderRef.current?.setDetailLevel('photorealistic_3d')}
                  className={`text-[10px] px-2 py-0.5 rounded-full transition-all cursor-pointer ${
                    detailLevel === 'photorealistic_3d'
                      ? 'bg-cyan-500 text-slate-950 font-semibold shadow-[0_0_10px_#06b6d4]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Max photorealistic 3D mesh & street terrain"
                >
                  3D Mesh
                </button>
              </div>

              <span className="text-slate-600 text-[10px]">|</span>
              <button
                type="button"
                onClick={() => controllerRef.current.setMode('threejs', 'globe')}
                className="text-[11px] text-slate-300 hover:text-white flex items-center gap-1 cursor-pointer transition-colors"
                title="Return to orbital Three.js Earth"
              >
                <RotateCcw className="w-3 h-3 text-blue-400" />
                <span>Globe</span>
              </button>
            </div>
          )}
        </div>

        {/* 7. Dedicated Required Google Attribution Badge */}
        {engineMode === 'google_earth' && (
          <div className="absolute bottom-3 left-4 z-30 pointer-events-none text-[10px] text-slate-400/80 font-sans tracking-wide select-none drop-shadow">
            Google Maps
          </div>
        )}
      </div>
    );
  }
);

EarthViewAdapter.displayName = 'EarthViewAdapter';
