/**
 * Provider contracts & level-of-detail types for Krisha's 3D Earth experience.
 * Supports swappable geospatial imagery providers (Google Earth / Maps 3D, Three.js fallback).
 */
import { GlobeCoordinates, GlobeMarker } from '../types';

export type EarthDetailLevel = 'globe' | 'regional' | 'city' | 'photorealistic_3d';
export type DetailLevel = EarthDetailLevel;
export type EarthEngineMode = 'threejs' | 'google_earth';

export interface CameraState {
  lat: number;
  lng: number;
  altitudeMeters: number;
  rangeMeters: number; // Camera-to-center distance in meters
  heading: number; // Degrees [-180, 180]
  tilt: number; // Degrees [0, 90]
  roll?: number;
}

export interface ProviderStatus {
  isAvailable: boolean;
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  detailLevel: EarthDetailLevel;
  activeMode: EarthEngineMode;
}

export interface ProviderInitOptions {
  apiKey: string;
  initialCamera: CameraState;
  mode?: 'satellite' | 'hybrid';
  onCameraChange?: (camera: CameraState) => void;
  onCoordinatesClick?: (coords: GlobeCoordinates) => void;
  onError?: (err: Error) => void;
  onReady?: () => void;
}

/**
 * Common contract for geospatial detail providers.
 * Allows Google Earth to be easily updated or swapped if Google updates APIs.
 */
export interface IEarthDetailProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  init(container: HTMLElement, options: ProviderInitOptions): Promise<boolean>;
  syncCamera(camera: CameraState): void;
  flyTo(target: Partial<CameraState>, durationMs?: number): Promise<void>;
  setDetailLevel(level: EarthDetailLevel): void;
  setMode(mode: 'satellite' | 'hybrid'): void;
  addMarker(marker: GlobeMarker): void;
  clearMarkers(): void;
  setVisible(visible: boolean): void;
  getStatus(): ProviderStatus;
  destroy(): void;
}
