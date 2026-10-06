/**
 * Official Google Earth / Maps 3D Geospatial Provider.
 * Connects Krisha's 3D Earth experience to Google's photorealistic 3D imagery and elevation tiles
 * using the official Google Maps Platform Maps3D Web Component (`<gmp-map-3d>`).
 *
 * Compliance:
 * - Includes required attribution ID: gmp_git_agentskills_v1
 * - Preserves Google Maps attribution
 * - Progressive loading and memory management (unloads/dormant when at far orbital distance)
 */
import {
  CameraState,
  DetailLevel,
  IEarthDetailProvider,
  ProviderInitOptions,
  ProviderStatus,
} from './types';
import { GlobeMarker, GlobeCoordinates } from '../types';
import { loadGoogleMaps3D, DEFAULT_MAPS_API_KEY } from './mapsLoader';

export class GoogleEarthProvider implements IEarthDetailProvider {
  readonly id = 'google_earth';
  readonly name = 'Google Earth (Photorealistic 3D)';

  private container: HTMLElement | null = null;
  private map3dElement: HTMLElement | null = null;
  private status: ProviderStatus = {
    isAvailable: true,
    isReady: false,
    isLoading: false,
    error: null,
    detailLevel: 'globe',
    activeMode: 'google_earth',
  };

  private currentCamera: CameraState = {
    lat: 20,
    lng: 0,
    altitudeMeters: 0,
    rangeMeters: 2000000,
    heading: 0,
    tilt: 0,
  };

  private isVisible = true;
  private options: ProviderInitOptions | null = null;
  private rafHandle: number | null = null;
  private markersMap = new Map<string, HTMLElement>();
  private activeMode: 'satellite' | 'hybrid' = 'satellite';

  isAvailable(): boolean {
    return Boolean(DEFAULT_MAPS_API_KEY);
  }

  getStatus(): ProviderStatus {
    return { ...this.status };
  }

  async init(container: HTMLElement, options: ProviderInitOptions): Promise<boolean> {
    this.container = container;
    this.options = options;
    this.currentCamera = { ...options.initialCamera };
    this.status.isLoading = true;
    this.status.error = null;

    try {
      // 1. Ensure Google Maps JavaScript API with `maps3d` library is loaded
      await loadGoogleMaps3D(options.apiKey || DEFAULT_MAPS_API_KEY);

      // 2. Instantiate the <gmp-map-3d> custom element
      const mapEl = document.createElement('gmp-map-3d') as any;

      // Attribution & compliance
      mapEl.setAttribute('internal-usage-attribution-ids', 'gmp_git_agentskills_v1');
      if (typeof mapEl.defaultUIHidden !== 'undefined') {
        mapEl.defaultUIHidden = true;
      } else {
        mapEl.setAttribute('default-ui-disabled', 'true');
      }

      // Initial visual mode
      this.activeMode = options.mode || 'satellite';
      mapEl.setAttribute('mode', this.activeMode);

      // Initial camera setup
      mapEl.setAttribute(
        'center',
        `${this.currentCamera.lat},${this.currentCamera.lng},${this.currentCamera.altitudeMeters || 0}`
      );
      mapEl.setAttribute('range', String(Math.round(this.currentCamera.rangeMeters)));
      mapEl.setAttribute('tilt', String(Math.round(this.currentCamera.tilt)));
      mapEl.setAttribute('heading', String(Math.round(this.currentCamera.heading)));
      mapEl.setAttribute('gesture-handling', 'greedy');

      // Styling: fill parent container completely
      mapEl.style.width = '100%';
      mapEl.style.height = '100%';
      mapEl.style.display = 'block';
      mapEl.style.outline = 'none';

      // 3. Register camera event listeners with RAF throttling
      const notifyCameraChange = () => {
        if (this.rafHandle) return;
        this.rafHandle = requestAnimationFrame(() => {
          this.rafHandle = null;
          if (!mapEl) return;

          try {
            const center = mapEl.center;
            const latVal = typeof center?.lat === 'function' ? center.lat() : center?.lat;
            const lngVal = typeof center?.lng === 'function' ? center.lng() : center?.lng;
            const altVal = typeof center?.altitude === 'number' ? center.altitude : 0;

            const range = typeof mapEl.range === 'number' ? mapEl.range : this.currentCamera.rangeMeters;
            const tilt = typeof mapEl.tilt === 'number' ? mapEl.tilt : this.currentCamera.tilt;
            const heading = typeof mapEl.heading === 'number' ? mapEl.heading : this.currentCamera.heading;

            if (typeof latVal === 'number' && typeof lngVal === 'number' && !isNaN(latVal) && !isNaN(lngVal)) {
              this.currentCamera = {
                lat: Number(latVal.toFixed(4)),
                lng: Number(lngVal.toFixed(4)),
                altitudeMeters: Number(altVal.toFixed(0)),
                rangeMeters: Math.round(range),
                tilt: Number(tilt.toFixed(1)),
                heading: Number(heading.toFixed(1)),
              };
              this.options?.onCameraChange?.(this.currentCamera);
            }
          } catch {
            // Ignore temporary access errors during camera transitions
          }
        });
      };

      const passiveOpts: AddEventListenerOptions = { passive: true };
      mapEl.addEventListener('gmp-centerchange', notifyCameraChange, passiveOpts);
      mapEl.addEventListener('gmp-rangechange', notifyCameraChange, passiveOpts);
      mapEl.addEventListener('gmp-tiltchange', notifyCameraChange, passiveOpts);
      mapEl.addEventListener('gmp-headingchange', notifyCameraChange, passiveOpts);

      mapEl.addEventListener('gmp-click', (e: any) => {
        if (e?.position) {
          const pLat = typeof e.position.lat === 'function' ? e.position.lat() : e.position.lat;
          const pLng = typeof e.position.lng === 'function' ? e.position.lng() : e.position.lng;
          const pAlt = typeof e.position.altitude === 'number' ? e.position.altitude : 0;
          if (typeof pLat === 'number' && typeof pLng === 'number') {
            const coords: GlobeCoordinates = {
              lat: Number(pLat.toFixed(4)),
              lng: Number(pLng.toFixed(4)),
              altitude: Number(pAlt.toFixed(0)),
            };
            this.options?.onCoordinatesClick?.(coords);
          }
        }
      });

      // Clear container and append
      this.container.innerHTML = '';
      this.container.appendChild(mapEl);
      this.map3dElement = mapEl;

      this.status.isReady = true;
      this.status.isLoading = false;
      this.options.onReady?.();
      return true;
    } catch (err: any) {
      console.error('GoogleEarthProvider initialization error:', err);
      this.status.isReady = false;
      this.status.isLoading = false;
      this.status.error = err?.message || 'Failed to initialize Google Earth 3D view';
      this.options.onError?.(err);
      return false;
    }
  }

  syncCamera(camera: CameraState): void {
    if (!this.map3dElement) return;
    this.currentCamera = { ...camera };

    try {
      const mapEl = this.map3dElement as any;
      mapEl.center = {
        lat: camera.lat,
        lng: camera.lng,
        altitude: camera.altitudeMeters || 0,
      };
      if (camera.rangeMeters > 0) {
        mapEl.range = camera.rangeMeters;
      }
      if (typeof camera.tilt === 'number') {
        mapEl.tilt = camera.tilt;
      }
      if (typeof camera.heading === 'number') {
        mapEl.heading = camera.heading;
      }
    } catch (err) {
      console.warn('GoogleEarthProvider syncCamera error:', err);
    }
  }

  async flyTo(target: Partial<CameraState>, durationMs: number = 1800): Promise<void> {
    if (!this.map3dElement) return;
    const mapEl = this.map3dElement as any;

    const lat = target.lat ?? this.currentCamera.lat;
    const lng = target.lng ?? this.currentCamera.lng;
    const altitude = target.altitudeMeters ?? this.currentCamera.altitudeMeters ?? 0;
    const range = target.rangeMeters ?? this.currentCamera.rangeMeters;
    const tilt = target.tilt ?? this.currentCamera.tilt ?? 0;
    const heading = target.heading ?? this.currentCamera.heading ?? 0;

    // Prefer native flyCameraTo if available on the Map3DElement
    if (typeof mapEl.flyCameraTo === 'function') {
      try {
        mapEl.flyCameraTo({
          endCamera: {
            center: { lat, lng, altitude },
            range,
            tilt,
            heading,
          },
          durationMillis: durationMs,
        });
        this.currentCamera = { lat, lng, altitudeMeters: altitude, rangeMeters: range, tilt, heading };
        return;
      } catch (err) {
        console.warn('Native flyCameraTo not ready, applying direct animated parameters:', err);
      }
    }

    // Direct property update fallback
    mapEl.center = { lat, lng, altitude };
    mapEl.range = range;
    mapEl.tilt = tilt;
    mapEl.heading = heading;
    this.currentCamera = { lat, lng, altitudeMeters: altitude, rangeMeters: range, tilt, heading };
  }

  setDetailLevel(level: DetailLevel): void {
    this.status.detailLevel = level;
    if (!this.map3dElement) return;

    // Adjust camera viewing tilt & range to match desired detail
    let targetRange = this.currentCamera.rangeMeters;
    let targetTilt = this.currentCamera.tilt;

    if (level === 'photorealistic_3d') {
      // High detail 3D buildings & street-level terrain
      targetRange = Math.min(targetRange, 3500);
      targetTilt = Math.max(targetTilt, 60);
    } else if (level === 'city') {
      targetRange = Math.min(targetRange, 35000);
      targetTilt = Math.max(targetTilt, 45);
    } else if (level === 'regional') {
      targetRange = Math.min(targetRange, 450000);
      targetTilt = 0;
    }

    this.flyTo({ rangeMeters: targetRange, tilt: targetTilt }, 1200);
  }

  setMode(mode: 'satellite' | 'hybrid'): void {
    this.activeMode = mode;
    if (this.map3dElement) {
      this.map3dElement.setAttribute('mode', mode);
    }
  }

  getCurrentCamera(): CameraState {
    return { ...this.currentCamera };
  }

  toggleTilt(): void {
    if (!this.map3dElement) return;
    const currentTilt = this.currentCamera.tilt || 0;
    const targetTilt = currentTilt > 30 ? 0 : 60;
    this.flyTo({ tilt: targetTilt }, 900);
  }

  addMarker(marker: GlobeMarker): void {
    if (!this.map3dElement) return;

    // Clean existing marker with same ID
    if (this.markersMap.has(marker.id)) {
      const existing = this.markersMap.get(marker.id);
      existing?.remove();
    }

    try {
      const markerEl = document.createElement('gmp-marker-3d');
      markerEl.setAttribute('position', `${marker.lat},${marker.lng},0`);
      markerEl.setAttribute('altitude-mode', 'clamp-to-ground');
      markerEl.setAttribute('label', marker.label);

      this.map3dElement.appendChild(markerEl);
      this.markersMap.set(marker.id, markerEl);
    } catch (err) {
      console.warn('Could not add 3D marker to Google Earth element:', err);
    }
  }

  clearMarkers(): void {
    this.markersMap.forEach((el) => el.remove());
    this.markersMap.clear();
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    if (this.container) {
      this.container.style.opacity = visible ? '1' : '0';
      this.container.style.pointerEvents = visible ? 'auto' : 'none';
      this.container.style.visibility = visible ? 'visible' : 'hidden';
    }
  }

  destroy(): void {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.clearMarkers();
    if (this.map3dElement) {
      this.map3dElement.remove();
      this.map3dElement = null;
    }
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
    this.status.isReady = false;
  }
}
