/**
 * Krisha Environmental Data Layer Architecture.
 *
 * Reusable abstraction for environmental layers (wind today; temperature,
 * precipitation, cloud cover, surface pressure later). Future layers only
 * need to implement EnvLayerQuery -- the globe is untouched.
 *
 * Weather provider: Open-Meteo (free, no API key, CC-BY 4.0 attribution).
 * Fair use: ~10,000 requests/day on the free tier. This module throttles
 * network calls (debounce + min-interval + abort) so a whole session stays
 * far below provider limits.
 */
import { WindFieldGrid, WindVectorPoint } from '../types';

// ---------------------------------------------------------------------------
// Public types & contracts
// ---------------------------------------------------------------------------

export type WindStatus = 'idle' | 'loading' | 'live' | 'stale' | 'error';

export interface WindStatusMeta {
  status: WindStatus;
  vectorCount: number;
  fetchedAt: number; // epoch ms of last successful fetch (0 = none)
  source: string;
  stale: boolean;
  message?: string;
}

export interface WindFieldRequest {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface EnvLayerQuery<TGrid, TPoint> {
  readonly id: string;
  readonly attribution: string;
  /** Fetch a regional grid of data covering the request bounds. */
  fetchGrid(bounds: WindFieldRequest): Promise<TGrid>;
  /** Fetch a single-point reading (used for inspection). */
  fetchPoint(lat: number, lng: number): Promise<TPoint>;
}

// ---------------------------------------------------------------------------
// Open-Meteo wind implementation (reusable pattern for future variables)
// ---------------------------------------------------------------------------

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_ATTRIBUTION = 'Open-Meteo.com / NOAA GFS (Open Access)';

/** Build one Open-Meteo forecast URL for a list of locations. */
function buildOpenMeteoUrl(lats: number[], lngs: number[], variables: string[]): string {
  const params = new URLSearchParams();
  params.set('latitude', lats.map((v) => v.toFixed(2)).join(','));
  params.set('longitude', lngs.map((v) => v.toFixed(2)).join(','));
  params.set('current', variables.join(','));
  params.set('wind_speed_unit', 'ms');
  params.set('timezone', 'UTC');
  return `${OPEN_METEO_BASE}?${params.toString()}`;
}

const WIND_VARIABLES = ['wind_speed_10m', 'wind_direction_10m'];

/** Meteorological convention: direction is where wind blows FROM. */
export function speedToUV(speedMs: number, directionDeg: number): { u: number; v: number } {
  const theta = (directionDeg * Math.PI) / 180;
  // 0 = from north (blowing south), 90 = from east (blowing west)
  return { u: -speedMs * Math.sin(theta), v: -speedMs * Math.cos(theta) };
}

/** Convert u/v m/s (standard meteorological components) to FROM-direction + speed. */
export function uvToSpeedDirection(u: number, v: number): { speedMs: number; directionDeg: number } {
  const speedMs = Math.hypot(u, v);
  let directionDeg = (Math.atan2(-u, -v) * 180) / Math.PI;
  if (directionDeg < 0) directionDeg += 360;
  return { speedMs, directionDeg };
}

const CARDINAL_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function directionToCardinal(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  return CARDINAL_POINTS[Math.round(normalized / 22.5) % 16];
}

export interface WindReading {
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

interface OpenMeteoPointReading {
  latitude?: number;
  longitude?: number;
  current?: {
    time?: string;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
}

function readingToWindVector(r: OpenMeteoPointReading): WindVectorPoint | null {
  const current = r?.current;
  if (!current || typeof current.wind_speed_10m !== 'number' || typeof current.wind_direction_10m !== 'number') {
    return null;
  }
  const speedMs = current.wind_speed_10m;
  const directionDeg = current.wind_direction_10m;
  const { u, v } = speedToUV(speedMs, directionDeg);
  return {
    lat: r.latitude ?? 0,
    lng: r.longitude ?? 0,
    u: Math.round(u * 1000) / 1000,
    v: Math.round(v * 1000) / 1000,
    speed: Math.round(speedMs * 100) / 100,
    directionDeg,
  };
}

/**
 * EnvLayerQuery implementation for wind via Open-Meteo.
 * Multi-location requests keep this to ONE network call per regional grid
 * (chunked at 200 locations to stay within comfortable URL limits).
 */
export const OPEN_METEO_WIND_QUERY: EnvLayerQuery<WindFieldGrid, WindReading> = {
  id: 'wind',
  attribution: WEATHER_ATTRIBUTION,

  async fetchGrid(bounds: WindFieldRequest): Promise<WindFieldGrid> {
    const locations = enumerateGridLocations(bounds);
    if (locations.length === 0) throw new Error('Empty grid bounds');

    const vectors = await fetchOpenMeteoVectors(locations);
    if (vectors.length === 0) throw new Error('Open-Meteo returned no wind vectors');

    return {
      timestamp: Date.now(),
      source: 'open-meteo',
      resolutionDegrees: locations.resolution,
      vectors,
      bounds: {
        minLat: -85,
        maxLat: 85,
        minLng: -180,
        maxLng: 180,
      },
    };
  },

  async fetchPoint(lat: number, lng: number): Promise<WindReading> {
    const res = await fetch(buildOpenMeteoUrl([lat], [lng], WIND_VARIABLES));
    if (!res.ok) throw new Error(`Open-Meteo point query failed (${res.status})`);
    const data = (await res.json()) as OpenMeteoPointReading;
    const vector = readingToWindVector(data);
    if (!vector) throw new Error('No wind data available for this location');
    const time = data?.current?.time ? new Date(data.current.time + ':00Z').getTime() : Date.now();
    return {
      lat,
      lng,
      speedMs: vector.speed,
      speedKmh: Math.round(vector.speed * 3.6 * 10) / 10,
      directionDeg: vector.directionDeg,
      cardinal: directionToCardinal(vector.directionDeg),
      timestamp: Number.isFinite(time) ? time : Date.now(),
      source: 'open-meteo',
      stale: false,
    };
  },
}

interface EnumeratedGrid extends Array<{ lat: number; lng: number }> {
  resolution: number;
}

/** Enumerate grid locations for a request; lng wraps across the dateline. */
function enumerateGridLocations(bounds: WindFieldRequest): EnumeratedGrid {
  const MIN_SPAN = 6;
  const MAX_SPAN = 170;
  const latSpan = Math.max(MIN_SPAN, Math.min(MAX_SPAN, bounds.maxLat - bounds.minLat));
  const lngSpan = Math.max(MIN_SPAN, Math.min(MAX_SPAN, shortestLngSpan(bounds)));

  const baseLatStep = clampStep(latSpan / 6);
  const baseLngStep = clampStep(lngSpan / 6);

  // Keep one network call per grid: cap total locations at 200.
  let latStep = baseLatStep;
  let lngStep = baseLngStep;
  const latLo = Math.max(-85, bounds.minLat);
  const latHi = Math.min(85, Math.max(latLo, bounds.maxLat));
  const rows = Math.ceil((latHi - latLo) / latStep) + 1;
  const cols = Math.ceil(lngSpan / lngStep);
  const overflow = (rows * cols) / 200;
  if (overflow > 1) {
    const factor = Math.ceil(overflow * 100) / 100;
    latStep = clampStep(latStep * factor);
    lngStep = clampStep(lngStep * factor);
  }

  const locations: { lat: number; lng: number }[] = [];
  const maxLat = latLo + Math.floor((latHi - latLo) / latStep + 1e-6) * latStep;
  for (let lat = latLo; lat <= maxLat + 1e-6; lat += latStep) {
    for (let col = 0; col <= Math.floor(lngSpan / lngStep + 1e-6); col++) {
      const lng = ((bounds.minLng + col * lngStep) + 540) % 360 - 180;
      locations.push({ lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 });
    }
  }
  const out = locations as EnumeratedGrid;
  out.resolution = clampStep((latStep + lngStep) / 2);
  return out;
}

function shortestLngSpan(bounds: WindFieldRequest): number {
  const span = bounds.maxLng - bounds.minLng;
  if (!Number.isFinite(span) || span <= 0 || span >= 360) return 360;
  return span;
}

function clampStep(step: number): number {
  return Math.min(25, Math.max(0.25, Math.round(step * 100) / 100));
}

/** Fetch a set of vectors from Open-Meteo in chunked multi-location requests. */
async function fetchOpenMeteoVectors(locations: { lat: number; lng: number }[]): Promise<WindVectorPoint[]> {
  const CHUNK = 200;
  const results: WindVectorPoint[] = [];
  for (let i = 0; i < locations.length; i += CHUNK) {
    const chunk = locations.slice(i, i + CHUNK);
    const res = await fetch(
      buildOpenMeteoUrl(
        chunk.map((c) => c.lat),
        chunk.map((c) => c.lng),
        WIND_VARIABLES
      )
    );
    if (!res.ok) throw new Error(`Open-Meteo grid query failed (${res.status})`);
    const data = await res.json();
    const readings: OpenMeteoPointReading[] = Array.isArray(data) ? data : [data];
    for (const r of readings) {
      const vector = readingToWindVector(r);
      if (vector) results.push(vector);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// PreparedGrid: fast O(1) interpolation structure, rebuilt once per field.
// ------------------------------------------------------------=--------------

export interface PreparedGrid {
  field: WindFieldGrid;
  lat0: number; // lowest grid latitude
  step: number; // grid step in degrees (approx, from data)
  rows: number;
  cols: number; // grid columns across 360 degrees
  cells: Map<number, WindVectorPoint>; // key = row * cols + col
}

function colKeyOf(grid: PreparedGrid, lng: number): number {
  // Columns span 360 degrees with an anchor at the first vector's lng.
  const anchor = grid.field.vectors[0]?.lng ?? 0;
  const delta = ((lng - anchor) % 360 + 540) % 360 - 180;
  return Math.round(delta / grid.step);
}

/** Build the O(1) interpolation grid from a freshly fetched field. */
export function prepareGrid(field: WindFieldGrid): PreparedGrid | null {
  if (field.vectors.length === 0) return null;

  const uniqueLats = Array.from(new Set(field.vectors.map((v) => v.lat))).sort((a, b) => a - b);
  if (uniqueLats.length < 2) return null;

  const step = Math.abs(uniqueLats[1] - uniqueLats[0]) || 1;
  const cols = Math.max(2, Math.floor(360 / step));

  const grid: PreparedGrid = {
    field,
    lat0: uniqueLats[0],
    step,
    rows: uniqueLats.length,
    cols,
    cells: new Map(),
  };

  for (const v of field.vectors) {
    const row = Math.round((v.lat - grid.lat0) / step);
    if (row < 0 || row >= grid.rows) continue;
    const col = Math.round((colKeyOf(grid, v.lng) % cols + cols) % cols);
    grid.cells.set(row * cols + col, v);
  }
  return grid;
}

function cellAt(grid: PreparedGrid, row: number, col: number): WindVectorPoint | undefined {
  const wrappedCol = ((col % grid.cols) + grid.cols) % grid.cols;
  return grid.cells.get(row * grid.cols + wrappedCol);
}

/**
 * Sample the wind field at geographic coordinates using bilinear
 * interpolation over a prepared grid. Returns null when the coordinate
 * lies outside the grid.
 */
export function sampleField(
  grid: PreparedGrid,
  lat: number,
  lng: number
): { u: number; v: number } | null {
  const latVal = Math.max(-85, Math.min(85, lat));
  const rowF = (latVal - grid.lat0) / grid.step;
  const colF = colKeyOf(grid, lng);

  const rowLo = Math.floor(rowF);
  const colLo = Math.floor(colF);
  const tx = rowF - rowLo;
  const ty = colF - colLo;

  const c00 = cellAt(grid, rowLo, colLo);
  const c01 = cellAt(grid, rowLo, colLo + 1);
  const c10 = cellAt(grid, rowLo + 1, colLo);
  const c11 = cellAt(grid, rowLo + 1, colLo + 1);
  if (!c00 && !c01 && !c10 && !c11) return null;

  // Any missing corner falls back to the nearest available corner.
  const p00 = c00 ?? c01 ?? c10 ?? c11;
  const p01 = c01 ?? c00 ?? c11 ?? c10;
  const p10 = c10 ?? c11 ?? c00 ?? c01;
  const p11 = c11 ?? c10 ?? c01 ?? c00;
  if (!p00 || !p01 || !p10 || !p11) return null;

  const u =
    (p00.u * (1 - tx) + p10.u * tx) * (1 - ty) +
    (p01.u * (1 - tx) + p11.u * tx) * ty;
  const v =
    (p00.v * (1 - tx) + p10.v * tx) * (1 - ty) +
    (p01.v * (1 - tx) + p11.v * tx) * ty;

  return { u, v };
}

// ---------------------------------------------------------------------------
// WindService: cache + throttle + stale handling on top of the query.
// Separates NETWORK updates (requestWindField) from ANIMATION (getLayer).
// ---------------------------------------------------------------------------

const MIN_FIELD_INTERVAL_MS = 10_000; // at most 1 grid fetch / 10 s
const FIELD_DEBOUNCE_MS = 3_000; // settle for 3 s after camera stops
const MIN_POINT_INTERVAL_MS = 2_000; // at most 1 point fetch / 2 s
const STALE_AFTER_MS = 30 * 60_000; // reading older than 30 min is flagged

export class WindService {
  private query: EnvLayerQuery<WindFieldGrid, WindReading>;
  private activeController: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastField: WindFieldGrid | null = null;
  private lastFetchAttemptAt = 0;
  private lastPointAttemptAt = 0;
  private lastPointReading: WindReading | null = null;

  constructor(query: EnvLayerQuery<WindFieldGrid, WindReading> = OPEN_METEO_WIND_QUERY) {
    this.query = query;
  }

  get cachedField(): WindFieldGrid | null {
    return this.lastField;
  }

  get cachedPoint(): WindReading | null {
    return this.lastPointReading;
  }

  /**
   * Request an updated wind field covering `bounds`.
   * Debounced (restartable) and throttled. Never throws: failures keep the
   * last valid data and report a stale/error status.
   */
  requestWindField(bounds: WindFieldRequest, onStatus?: (meta: WindStatusMeta) => void): void {
    if (bounds.maxLat - bounds.minLat <= 0 || shortestLngSpan(bounds) >= 360) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.fetchWindField(bounds, onStatus);
    }, FIELD_DEBOUNCE_MS);
  }

  private async fetchWindField(
    bounds: WindFieldRequest,
    onStatus?: (meta: WindStatusMeta) => void
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetchAttemptAt < MIN_FIELD_INTERVAL_MS) return;
    this.lastFetchAttemptAt = now;

    if (this.activeController) this.activeController.abort();
    const controller = new AbortController();
    this.activeController = controller;

    this.emitStatus(onStatus, 'loading');
    try {
      const field = await this.query.fetchGrid(bounds);
      if (controller.signal.aborted) return;
      this.lastField = field;
      this.emitStatus(onStatus, 'live');
    } catch (err: any) {
      if (controller.signal.aborted) return;
      this.emitStatus(onStatus, this.lastField ? 'stale' : 'error', err?.message || String(err));
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  /**
   * Reading at an exact coordinate. Serves from the cached grid when it
   * covers the coordinate (stale flagged if older than STALE_AFTER_MS);
   * otherwise performs a rate-limited network point query.
   */
  async getReadingAt(lat: number, lng: number, prepared?: PreparedGrid | null): Promise<WindReading | null> {
    const grid = prepared ?? (this.lastField ? prepareGrid(this.lastField) : null);
    if (grid) {
      const sample = sampleField(grid, lat, lng);
      if (sample) {
        const { speedMs, directionDeg } = uvToSpeedDirection(sample.u, sample.v);
        const field = grid.field;
        const stale = Date.now() - field.timestamp > STALE_AFTER_MS;
        return {
          lat,
          lng,
          speedMs: Math.round(speedMs * 100) / 100,
          speedKmh: Math.round(speedMs * 3.6 * 10) / 10,
          directionDeg: Math.round(directionDeg * 10) / 10,
          cardinal: directionToCardinal(directionDeg),
          timestamp: field.timestamp,
          source: field.source,
          stale,
        };
      }
    }

    const now = Date.now();
    if (now - this.lastPointAttemptAt < MIN_POINT_INTERVAL_MS) {
      return this.lastPointReading;
    }
    this.lastPointAttemptAt = now;

    try {
      const reading = await this.query.fetchPoint(lat, lng);
      this.lastPointReading = reading;
      return reading;
    } catch (err: any) {
      console.warn('Krisha wind point query failed:', err?.message || err);
      if (this.lastPointReading && Date.now() - this.lastPointReading.timestamp < STALE_AFTER_MS) {
        return this.lastPointReading;
      }
      return null;
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.activeController) this.activeController.abort();
    this.activeController = null;
    this.lastField = null;
    this.lastPointReading = null;
  }

  private emitStatus(
    onStatus: ((meta: WindStatusMeta) => void) | undefined,
    status: WindStatus,
    message?: string
  ): void {
    if (!onStatus) return;
    onStatus({
      status,
      vectorCount: this.lastField?.vectors.length ?? 0,
      fetchedAt: this.lastField?.timestamp ?? 0,
      source: this.query.attribution,
      stale: status === 'stale',
      message,
    });
  }
}
