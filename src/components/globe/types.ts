/**
 * Types & Contracts for Krisha 3D Earth / Geospatial System.
 * Designed for extensible base layers and future environmental/wind layers.
 */

export interface GlobeCoordinates {
  lat: number;
  lng: number;
  altitude?: number;
}

export type MapLayerType = 'satellite' | 'dark' | 'standard' | 'terrain';

export interface MapLayerConfig {
  id: MapLayerType;
  name: string;
  badge: string;
  description: string;
  attribution: string;
  previewColor: string;
  // Equirectangular high-performance textures / fallback canvases
  textureUrl: string;
  nightTextureUrl?: string;
  cloudsTextureUrl?: string;
  bumpMapUrl?: string;
  specularMapUrl?: string;
}

export interface GlobeMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  sublabel?: string;
  timestamp?: number;
}

export interface GlobeSearchResult {
  name: string;
  lat: number;
  lng: number;
  displayName: string;
  country?: string;
  category?: string;
}

export interface GlobeControllerHandle {
  flyTo: (lat: number, lng: number, distance?: number, durationMs?: number) => Promise<void>;
  resetToEarthView: (durationMs?: number) => Promise<void>;
  zoomIn: () => void;
  zoomOut: () => void;
  setLayer: (layer: MapLayerType) => void;
  getCoordinatesUnderCursor: () => GlobeCoordinates | null;
  getCameraCoordinates: () => GlobeCoordinates;
  addMarker: (marker: GlobeMarker) => void;
  clearMarkers: () => void;
  getWindReadingAt: (lat: number, lng: number) => Promise<WindInfoReading | null>;
  isWindDataReady: () => boolean;
  // Level of detail & swappable geospatial engine extensions
  setDetailLevel?: (level: 'globe' | 'regional' | 'city' | 'photorealistic_3d') => void;
  setEngineMode?: (mode: 'threejs' | 'google_earth') => void;
  getEngineMode?: () => 'threejs' | 'google_earth';
  getDetailLevel?: () => 'globe' | 'regional' | 'city' | 'photorealistic_3d';
  toggleTilt?: () => void;
}

// ---------------------------------------------------------------------------
// Live environmental readings (structurally matches envService.WindReading)
// ---------------------------------------------------------------------------

export interface WindInfoReading {
  lat: number;
  lng: number;
  speedMs: number;
  speedKmh: number;
  directionDeg: number; // FROM-direction (0 = from north)
  cardinal: string;
  timestamp: number; // epoch ms of the reading
  source: string;
  stale: boolean; // true if served from an older cached fetch
}

// ---------------------------------------------------------------------------
// Extensible Weather & Wind Architecture (Contracts for Phase 2 Integration)
// ---------------------------------------------------------------------------

export type WeatherLayerType = 'wind_particles' | 'temperature' | 'precipitation' | 'clouds';

export interface WeatherLayerConfig {
  id: WeatherLayerType;
  name: string;
  description: string;
  provider: 'open-meteo' | 'noaa_gfs' | 'ecmwf_open';
  attribution: string;
  enabled: boolean;
  opacity: number;
  colorRamp?: string[];
  unit: string;
  minVal?: number;
  maxVal?: number;
}

export interface WindVectorPoint {
  lat: number;
  lng: number;
  u: number; // East-West velocity component (m/s)
  v: number; // North-South velocity component (m/s)
  speed: number; // Scalar wind speed (m/s or km/h)
  directionDeg: number; // Heading angle in degrees (0 = North, 90 = East)
}

export interface WindFieldGrid {
  timestamp: number;
  source: string;
  resolutionDegrees: number; // e.g. 0.5 or 1.0 degree grid
  vectors: WindVectorPoint[];
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}
