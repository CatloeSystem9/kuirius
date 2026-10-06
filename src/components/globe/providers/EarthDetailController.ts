/**
 * EarthDetailController:
 * Coordinates Level-of-Detail (LOD), camera distance thresholds, and smooth transitions
 * between Krisha's lightweight Three.js orbital globe and Google Earth's photorealistic 3D detail view.
 *
 * Rules:
 * - Far zoom (> 140 distance / > 2,500,000m range): Normal Krisha Earth/globe (Three.js with Atmosphere & Wind)
 * - Zoom closer (<= 140 distance): Google Earth-level imagery/detail becomes available.
 * - Zoom further (<= 120 distance / < 50,000m): Progressively loads 3D buildings, terrain, and photorealistic mesh.
 * - Zoom back out (> 2,500,000m range): Returns seamlessly to the lighter Three.js globe.
 */
import { CameraState, EarthDetailLevel, EarthEngineMode } from './types';
import { GlobeCoordinates } from '../types';

export interface DetailControllerListener {
  onModeChange?: (mode: EarthEngineMode) => void;
  onDetailLevelChange?: (level: EarthDetailLevel) => void;
  onTransitionChange?: (isTransitioning: boolean) => void;
}

export class EarthDetailController {
  private activeMode: EarthEngineMode = 'threejs';
  private currentDetailLevel: EarthDetailLevel = 'globe';
  private isTransitioning = false;
  private listeners = new Set<DetailControllerListener>();

  // Thresholds with hysteresis to prevent mode oscillation
  public static readonly THREEJS_ZOOM_IN_THRESHOLD = 138; // Distance <= 138 triggers Google Earth 3D
  public static readonly THREEJS_ZOOM_OUT_THRESHOLD = 146; // Distance >= 146 returns to Three.js
  public static readonly GOOGLE_EARTH_ZOOM_OUT_METERS = 7000000; // Planetary overview threshold where zooming out transitions to Three.js deep space orbital view

  constructor(initialMode: EarthEngineMode = 'threejs') {
    this.activeMode = initialMode;
    this.currentDetailLevel = initialMode === 'threejs' ? 'globe' : 'regional';
  }

  getActiveMode(): EarthEngineMode {
    return this.activeMode;
  }

  getDetailLevel(): EarthDetailLevel {
    return this.currentDetailLevel;
  }

  isCurrentlyTransitioning(): boolean {
    return this.isTransitioning;
  }

  subscribe(listener: DetailControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => {
      l.onModeChange?.(this.activeMode);
      l.onDetailLevelChange?.(this.currentDetailLevel);
      l.onTransitionChange?.(this.isTransitioning);
    });
  }

  /**
   * Evaluates Three.js camera distance and checks if Google Earth detail view should engage.
   * @param cameraDistance Three.js distance from earth center (115 to 320, earth radius 100)
   * @returns true if detail view should be active
   */
  evaluateThreeJsDistance(cameraDistance: number): boolean {
    if (this.activeMode === 'threejs' && cameraDistance <= EarthDetailController.THREEJS_ZOOM_IN_THRESHOLD) {
      this.setMode('google_earth', 'regional');
      return true;
    }
    return false;
  }

  /**
   * Evaluates Google Earth camera range in meters and updates Level-of-Detail (LOD).
   * Note: Standard panning and moving around the globe updates detail following the visible area
   * without exiting Google Earth! Zooming back out to Three.js is safely gated via allowZoomOutTransition.
   * @param rangeMeters Distance in meters from camera to center
   * @param allowZoomOutTransition If true, transitioning back to Three.js is permitted when zoomed out into space
   */
  evaluateGoogleEarthRange(rangeMeters: number, allowZoomOutTransition = false): boolean {
    if (!Number.isFinite(rangeMeters) || rangeMeters <= 0) return false;

    // Determine progressive LOD within Google Earth
    let newLevel: EarthDetailLevel = 'regional';
    if (rangeMeters < 15000) {
      newLevel = 'photorealistic_3d'; // High detail 3D buildings & terrain mesh
    } else if (rangeMeters < 250000) {
      newLevel = 'city'; // City-level roads, landmarks, architecture
    } else if (rangeMeters < 3500000) {
      newLevel = 'regional'; // High-res satellite & geographic terrain
    } else {
      newLevel = 'globe'; // Continental & planetary satellite view
    }

    if (newLevel !== this.currentDetailLevel) {
      this.currentDetailLevel = newLevel;
      this.notify();
    }

    // Zooming out past planetary distance (>= 6,500,000m) returns to lighter Three.js globe allowing deep space view
    if (allowZoomOutTransition && rangeMeters >= 6500000 && this.activeMode === 'google_earth') {
      this.setMode('threejs', 'globe');
      return true;
    }

    return false;
  }

  /**
   * Explicitly evaluates zoom out action against outer space threshold
   */
  evaluateZoomOut(rangeMeters: number): boolean {
    return this.evaluateGoogleEarthRange(rangeMeters, true);
  }

  setMode(mode: EarthEngineMode, preferredLevel?: EarthDetailLevel): void {
    if (this.activeMode === mode && (!preferredLevel || this.currentDetailLevel === preferredLevel)) {
      return;
    }

    this.isTransitioning = true;
    this.activeMode = mode;
    this.currentDetailLevel = preferredLevel || (mode === 'threejs' ? 'globe' : 'regional');
    this.notify();

    // Release transition lock after smooth crossfade
    setTimeout(() => {
      this.isTransitioning = false;
      this.notify();
    }, 600);
  }

  toggleMode(): void {
    if (this.activeMode === 'threejs') {
      this.setMode('google_earth', 'city');
    } else {
      this.setMode('threejs', 'globe');
    }
  }

  /**
   * Translates Three.js spherical parameters into Google Earth CameraState
   */
  static threeCoordsToGoogleCamera(coords: GlobeCoordinates, distance: number): CameraState {
    // Distance from globe surface: (distance - 100). Surface is at 100 units.
    // Earth radius ~6,371,000m. 1 ThreeJS unit ~ 63,710 meters.
    const altitudeApprox = Math.max(500, (distance - 100) * 63710);
    return {
      lat: coords.lat,
      lng: coords.lng,
      altitudeMeters: Math.round(coords.altitude || 0),
      rangeMeters: Math.round(altitudeApprox * 1.25),
      heading: 0,
      tilt: distance < 125 ? 55 : 0,
    };
  }

  /**
   * Translates Google Earth CameraState into Three.js camera distance
   */
  static googleCameraToThreeDistance(camera: CameraState): number {
    // When Google Earth is at or beyond planetary scale (>= 6,000,000m),
    // map to 280-500+ so that zooming out moves smoothly into deep space beyond default (240)
    if (camera.rangeMeters >= 6000000) {
      const extra = (camera.rangeMeters - 6000000) / 10000000;
      return Math.round(280 + extra * 400);
    }
    const units = camera.rangeMeters / 63710 / 1.25;
    return Math.max(115, Math.min(1400, 100 + units));
  }
}
