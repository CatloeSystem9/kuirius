import { MapLayerConfig, MapLayerType, WeatherLayerConfig } from './types';

/**
 * Free & Open Imagery Catalog for Krisha 3D Earth.
 * All layers use public domain or open-access resources requiring 0 paid keys.
 */
export const AVAILABLE_LAYERS: Record<MapLayerType, MapLayerConfig> = {
  satellite: {
    id: 'satellite',
    name: 'NASA Satellite',
    badge: 'True Color',
    description: 'High-definition photorealistic satellite imagery captured by NASA Blue Marble.',
    attribution: 'NASA Visible Earth / Blue Marble (Public Domain)',
    previewColor: '#1e3a8a',
    textureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-blue-marble.jpg',
    nightTextureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-night.jpg',
    cloudsTextureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-clouds.png',
    bumpMapUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-topology.png',
    specularMapUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-water.png',
  },
  dark: {
    id: 'dark',
    name: 'Cyber Night',
    badge: 'Krisha Dark',
    description: 'Bioluminescent city lights and deep ocean dark matter optimized for Krisha aesthetics.',
    attribution: 'NASA Earth Observatory / Night Lights',
    previewColor: '#090d16',
    textureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-night.jpg',
    bumpMapUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-topology.png',
  },
  standard: {
    id: 'standard',
    name: 'Standard Map',
    badge: 'Geographic',
    description: 'Clean cartographic day map showing political landmasses and continental borders.',
    attribution: 'Open Cartography / Natural Earth Data',
    previewColor: '#0f766e',
    textureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-day.jpg',
    bumpMapUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-topology.png',
  },
  terrain: {
    id: 'terrain',
    name: 'Terrain Relief',
    badge: 'Topographic',
    description: 'Hypsometric elevation contours and bathymetric shaded relief.',
    attribution: 'ETOPO1 Global Relief / NOAA',
    previewColor: '#78350f',
    textureUrl: 'https://unpkg.com/three-globe@2.35.2/example/img/earth-topology.png',
  },
};

/**
 * Fallback procedural textures generated on HTML5 canvas if network is offline.
 * Ensures the globe always renders with zero latency.
 */
export function createFallbackProceduralTexture(type: MapLayerType): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Base background
  if (type === 'dark') {
    ctx.fillStyle = '#050a18';
  } else if (type === 'satellite') {
    ctx.fillStyle = '#071630';
  } else if (type === 'terrain') {
    ctx.fillStyle = '#1c1917';
  } else {
    ctx.fillStyle = '#022c43';
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw latitude / longitude holographic grid lines
  ctx.strokeStyle = type === 'dark' ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;

  // Parallels (Latitude lines)
  for (let lat = -80; lat <= 80; lat += 20) {
    const y = ((90 - lat) / 180) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Meridians (Longitude lines)
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = ((lng + 180) / 360) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  // Equator
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Prime meridian
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

/**
 * Extensible Weather & Environmental Overlays Catalog (Foundation for Phase 2).
 */
export const FUTURE_WEATHER_OVERLAYS: WeatherLayerConfig[] = [
  {
    id: 'wind_particles',
    name: 'Live Wind Currents',
    description: 'Animated aerodynamic streamlines indicating velocity and atmospheric direction.',
    provider: 'open-meteo',
    attribution: 'Open-Meteo Weather API / NOAA GFS (Open Access)',
    enabled: false,
    opacity: 0.85,
    unit: 'km/h',
    minVal: 0,
    maxVal: 120,
    colorRamp: ['#38bdf8', '#34d399', '#facc15', '#f87171', '#c084fc'],
  },
  {
    id: 'temperature',
    name: 'Global Temperature Heatmap',
    description: 'Real-time surface air temperatures.',
    provider: 'open-meteo',
    attribution: 'Open-Meteo Global Forecast System',
    enabled: false,
    opacity: 0.5,
    unit: '°C',
    minVal: -40,
    maxVal: 50,
  },
  {
    id: 'clouds',
    name: 'Dynamic Cloud Cover',
    description: 'Atmospheric moisture and cloud opacity layer.',
    provider: 'noaa_gfs',
    attribution: 'NOAA Geostationary Operational Satellite (GOES)',
    enabled: false,
    opacity: 0.65,
    unit: '%',
  },
];
