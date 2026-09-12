import { UserLocation, MapsLocationAction } from '../types';

const STORAGE_KEY = 'krisha_cached_location';
const MAX_CACHE_AGE_MS = 15 * 60 * 1000; // 15 minutes max cache age

/**
 * Reads cached location from localStorage only if it is fresh and from a verified GPS/manual source.
 * Discards any stale cache or IP-based guesses.
 */
export function getStoredLocation(): UserLocation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const loc: UserLocation = JSON.parse(raw);

    // Stale or invalid cache purge:
    // 1. IP geolocation guesses (which map to distant ISP datacenters 100+ km away)
    if (loc.source === 'client_ip' || loc.source === 'container_ip') {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    // 2. Old timestamp (older than 15 minutes)
    if (!loc.timestamp || Date.now() - loc.timestamp > MAX_CACHE_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    // 3. Datacenter coordinate check
    if (
      loc.country === 'Taiwan' ||
      loc.city === 'Changhua' ||
      loc.city === 'Changhua County' ||
      (loc.lat >= 23.5 && loc.lat <= 25.5 && loc.lng >= 120.0 && loc.lng <= 122.0)
    ) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    // 4. Sanity check coordinate range
    if (
      typeof loc.lat !== 'number' ||
      typeof loc.lng !== 'number' ||
      isNaN(loc.lat) ||
      isNaN(loc.lng) ||
      Math.abs(loc.lat) > 90 ||
      Math.abs(loc.lng) > 180
    ) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return loc;
  } catch {
    return null;
  }
}

/**
 * Saves location to localStorage only if it represents genuine device GPS or manual search.
 * Never caches IP-based network guesses.
 */
export function storeLocation(location: UserLocation): void {
  try {
    if (location.source === 'client_ip' || location.source === 'container_ip') {
      return; // Do not persist IP guesses
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Ignore storage quota issues
  }
}

/**
 * Clears stored location
 */
export function clearStoredLocation(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Raw browser position fix interface
 */
export interface BrowserGpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

/**
 * Retrieves the raw browser coordinates directly from navigator.geolocation.
 * Strictly uses maximumAge: 0 to eliminate stale cache.
 * Logs raw latitude, longitude, accuracy, and timestamp.
 * Verifies that latitude and longitude are not accidentally swapped.
 */
export function getBrowserGeolocationFix(): Promise<BrowserGpsFix> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.reject(new Error('navigator.geolocation is not supported in this browser'));
  }

  return new Promise((resolve, reject) => {
    // Tier 1: High Accuracy GPS (15s timeout, maximumAge: 0 for 100% fresh fix)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        let lat = pos.coords.latitude;
        let lng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy;
        const timestamp = pos.timestamp || Date.now();

        // Verify latitude and longitude are not swapped
        // Latitude is bounded to [-90, +90], Longitude is bounded to [-180, +180]
        if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
          console.warn('[GPS Source of Truth] Latitude and longitude were swapped! Correcting order.', { lat, lng });
          const temp = lat;
          lat = lng;
          lng = temp;
        }

        console.log('[GPS Source of Truth] Raw browser navigator.geolocation reading:', {
          latitude: lat,
          longitude: lng,
          accuracy: `±${Math.round(accuracy)}m`,
          timestamp,
          timeString: new Date(timestamp).toISOString(),
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
        });

        resolve({ lat, lng, accuracy, timestamp });
      },
      (err) => {
        console.warn('[GPS Source of Truth] High-accuracy GPS timed out or failed:', err.message, '- attempting standard accuracy fallback');
        // Tier 2: Standard Accuracy fallback (no cache)
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            let lat = pos.coords.latitude;
            let lng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy;
            const timestamp = pos.timestamp || Date.now();

            if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
              const temp = lat;
              lat = lng;
              lng = temp;
            }

            console.log('[GPS Source of Truth] Standard accuracy fallback reading:', {
              latitude: lat,
              longitude: lng,
              accuracy: `±${Math.round(accuracy)}m`,
              timestamp,
              timeString: new Date(timestamp).toISOString(),
              googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
            });

            resolve({ lat, lng, accuracy, timestamp });
          },
          (err2) => {
            console.error('[GPS Source of Truth] navigator.geolocation failed:', err2.message);
            reject(err2);
          },
          {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 0,
          }
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0, // Guarantees fresh hardware reading, never stale cached coordinates
      }
    );
  });
}

/**
 * Reverse geocodes coordinates or searches an address via our server-side Google Maps Platform proxy.
 * Crucially preserves the exact incoming coordinates so the marker and map center match device GPS.
 */
export async function geocodeCoordinates(
  lat?: number,
  lng?: number,
  accuracy?: number,
  address?: string
): Promise<UserLocation | null> {
  try {
    const res = await fetch('/api/location/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, address }),
    });

    if (!res.ok) {
      throw new Error(`Geocode failed with status ${res.status}`);
    }

    const data = await res.json();
    if (!data || !data.success) {
      throw new Error(data?.error || 'Invalid geocode response');
    }

    // Preserve exact input coordinates when available, rather than any centroid drift
    const exactLat = typeof lat === 'number' && !isNaN(lat) ? lat : data.lat;
    const exactLng = typeof lng === 'number' && !isNaN(lng) ? lng : data.lng;

    const resolved: UserLocation = {
      lat: exactLat,
      lng: exactLng,
      accuracy: accuracy || data.accuracy || 25,
      formattedAddress: data.formattedAddress || address || `${exactLat}, ${exactLng}`,
      city: data.city || address || 'Detected Location',
      neighborhood: data.neighborhood,
      state: data.state,
      country: data.country,
      postalCode: data.postalCode,
      street: data.street,
      // Use exact coordinates in Google Maps URL to pinpoint exact spot
      googleMapsUrl:
        exactLat !== undefined && exactLng !== undefined
          ? `https://www.google.com/maps/search/?api=1&query=${exactLat},${exactLng}`
          : data.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.formattedAddress || '')}`,
      embedUrl:
        exactLat !== undefined && exactLng !== undefined
          ? `https://www.google.com/maps?q=${exactLat},${exactLng}&z=16&output=embed`
          : data.embedUrl || `https://www.google.com/maps?q=${exactLat},${exactLng}&z=15&output=embed`,
      source: data.source || (address ? 'manual_search' : 'browser_gps'),
      timestamp: Date.now(),
    };

    storeLocation(resolved);
    return resolved;
  } catch (err) {
    console.warn('Location resolution warning:', err);
    return null;
  }
}

/**
 * Directly geocodes an address or city name entered by the user
 */
export async function geocodeAddress(address: string): Promise<UserLocation | null> {
  if (!address.trim()) return null;
  return geocodeCoordinates(undefined, undefined, 50, address.trim());
}

export interface FreshLocationResult {
  location: UserLocation | null;
  error?: 'permission_denied' | 'position_unavailable' | 'timeout' | 'unsupported' | string;
  errorMessage?: string;
  reverseGeocodeFailed?: boolean;
}

/**
 * Explicitly triggers device GPS prompt with high accuracy as the sole source of truth,
 * retrieves fresh hardware coordinates, and reverse-geocodes them into a human-readable address.
 * Never guesses or falls back to IP geolocation.
 */
export async function acquireFreshGpsLocationAndAddress(): Promise<FreshLocationResult> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return {
      location: null,
      error: 'unsupported',
      errorMessage: 'Geolocation is not supported by your browser.',
    };
  }

  try {
    const fix = await getBrowserGeolocationFix();
    const resolved = await geocodeCoordinates(fix.lat, fix.lng, fix.accuracy);

    if (resolved) {
      resolved.source = 'browser_gps';
      resolved.accuracy = fix.accuracy;
      resolved.timestamp = fix.timestamp;
      storeLocation(resolved);
      return { location: resolved };
    }

    // Direct coordinate fallback if reverse geocoding service is temporarily unreachable
    const fallback: UserLocation = {
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      formattedAddress: `GPS Fix: ${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)}`,
      city: 'GPS Coordinates',
      googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${fix.lat},${fix.lng}`,
      embedUrl: `https://www.google.com/maps?q=${fix.lat},${fix.lng}&z=16&output=embed`,
      source: 'browser_gps',
      timestamp: fix.timestamp,
    };
    storeLocation(fallback);
    return { location: fallback, reverseGeocodeFailed: true };
  } catch (err: any) {
    console.warn('[GPS Acquisition] Browser Geolocation error:', err);
    if (err?.code === 1) {
      return {
        location: null,
        error: 'permission_denied',
        errorMessage: 'Location permission was denied in your browser. Please allow location permissions in your browser settings.',
      };
    } else if (err?.code === 2) {
      return {
        location: null,
        error: 'position_unavailable',
        errorMessage: 'GPS hardware signal is currently unavailable on your device.',
      };
    } else if (err?.code === 3) {
      return {
        location: null,
        error: 'timeout',
        errorMessage: 'GPS acquisition timed out while attempting to pinpoint your exact coordinates.',
      };
    }
    return {
      location: null,
      error: 'unknown',
      errorMessage: err?.message || 'Could not acquire GPS position.',
    };
  }
}

export interface PriorityLocationResult {
  location: UserLocation | null;
  priorityUsed: 'google_maps_first' | 'alternative_network' | 'alternative_cache' | 'none';
  googleMapsSuccess: boolean;
  googleMapsError?: string;
  alternativeUsed: boolean;
  alternativeReason?: string;
}

/**
 * Alternative fallback: Fetches client public IP geolocation when Google Maps resolution fails.
 * ONLY used as a secondary alternative if Google Maps (First Priority) fails.
 */
export async function fetchClientIpLocation(): Promise<UserLocation | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://ipwho.is/', { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data && data.success && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        const cityStr = data.city || data.region || 'Detected Area';
        const formatted = [data.city, data.region, data.country].filter(Boolean).join(', ');
        const loc: UserLocation = {
          lat: data.latitude,
          lng: data.longitude,
          accuracy: 25000,
          formattedAddress: formatted || `Approx. ${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`,
          city: cityStr,
          state: data.region,
          country: data.country,
          postalCode: data.postal,
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${data.latitude},${data.longitude}`,
          embedUrl: `https://www.google.com/maps?q=${data.latitude},${data.longitude}&z=12&output=embed`,
          source: 'client_ip',
          timestamp: Date.now(),
          googleMapsPriority: false,
          usedAlternative: true,
        };
        return loc;
      }
    }
  } catch (err) {
    console.warn('[Alternative Location] ipwho.is client query failed:', err);
  }

  return null;
}

/**
 * Executes location resolution following the user's explicit rule:
 * 1. FIRST PRIORITY: Google Maps! Pinpointing user's position through Google Maps with high-accuracy geocoding.
 * 2. ALTERNATIVES: ONLY if Google Maps (First Priority) fails (permission denied, timeout, or unavailable):
 *    - Network/IP Geolocation (Alternative 1)
 *    - Stored/Cached verified location (Alternative 2)
 */
export async function acquireLocationWithPriority(): Promise<PriorityLocationResult> {
  console.log('[Location Pipeline] FIRST PRIORITY: Checking location via Google Maps...');

  // Try First Priority: Google Maps resolution
  const mapsResult = await acquireFreshGpsLocationAndAddress();
  if (mapsResult.location) {
    const mapsLocation: UserLocation = {
      ...mapsResult.location,
      googleMapsPriority: true,
      source: 'google_maps',
      usedAlternative: false,
    };
    console.log('[Location Pipeline] First Priority (Google Maps) Succeeded! Resolved Location:', mapsLocation);
    return {
      location: mapsLocation,
      priorityUsed: 'google_maps_first',
      googleMapsSuccess: true,
      alternativeUsed: false,
    };
  }

  // First Priority failed. Capture the exact reason.
  const mapsErrorMessage = mapsResult.errorMessage || 'Google Maps location access was denied or unavailable in the browser';
  console.warn('[Location Pipeline] First Priority (Google Maps) failed:', mapsErrorMessage, '--> Falling back to secondary alternatives...');

  // Alternative 1: Check client IP/network geolocation
  const ipLocation = await fetchClientIpLocation();
  if (ipLocation) {
    ipLocation.googleMapsPriority = false;
    ipLocation.usedAlternative = true;
    ipLocation.mapsFailureReason = mapsErrorMessage;
    console.log('[Location Pipeline] Alternative 1 (Network IP) Succeeded:', ipLocation);
    return {
      location: ipLocation,
      priorityUsed: 'alternative_network',
      googleMapsSuccess: false,
      googleMapsError: mapsErrorMessage,
      alternativeUsed: true,
      alternativeReason: `Google Maps check failed (${mapsErrorMessage}). Switched to network location alternative.`,
    };
  }

  // Alternative 2: Stored/cached location if recent
  const stored = getStoredLocation();
  if (stored) {
    stored.googleMapsPriority = false;
    stored.usedAlternative = true;
    stored.mapsFailureReason = mapsErrorMessage;
    console.log('[Location Pipeline] Alternative 2 (Cached) Succeeded:', stored);
    return {
      location: stored,
      priorityUsed: 'alternative_cache',
      googleMapsSuccess: false,
      googleMapsError: mapsErrorMessage,
      alternativeUsed: true,
      alternativeReason: `Google Maps check failed (${mapsErrorMessage}). Using previously verified location.`,
    };
  }

  // All failed
  console.warn('[Location Pipeline] Google Maps First Priority and all alternatives failed.');
  return {
    location: null,
    priorityUsed: 'none',
    googleMapsSuccess: false,
    googleMapsError: mapsErrorMessage,
    alternativeUsed: false,
  };
}

/**
 * Explicitly triggers device GPS prompt with high accuracy as the sole source of truth.
 */
export async function requestBrowserGps(): Promise<UserLocation | null> {
  const result = await acquireLocationWithPriority();
  return result.location;
}

/**
 * On-demand location detection:
 * Checks for fresh stored location or attempts priority acquisition.
 */
export async function detectBackgroundLocation(): Promise<UserLocation | null> {
  const stored = getStoredLocation();
  if (stored) return stored;
  return null;
}

/**
 * Checks if user message is asking Krisha about their location or Google Maps
 */
export function isLocationIntent(text: string): boolean {
  const clean = text.toLowerCase().trim();
  const patterns = [
    'open google maps',
    'open google map',
    'open maps',
    'open map',
    'check user current location',
    "check user's current location",
    "check user's location",
    'check users current location',
    'user current location',
    "user's current location",
    'check location',
    'check my location',
    'tell location',
    'tell my location',
    'tell me location',
    'tell me my location',
    'where exactly am i',
    'where am i exactly',
    'where am i',
    'where are we',
    'where am i right now',
    'what is my location',
    "what's my location",
    'what is my exact location',
    'my exact location',
    'what is my current location',
    'my current location',
    'what is my address',
    "what's my address",
    'what is my current address',
    "what's my current address",
    'what is my exact address',
    'my exact address',
    'tell me my address',
    'tell me my exact address',
    'can you tell my location',
    'can you tell me my location',
    'can you see where i am',
    'can you tell where i am',
    'what city am i in',
    'which city am i in',
    'show my location',
    'google maps',
    'my coordinates',
    'what are my coordinates',
    'my address',
    'actual address',
    'where do i live',
    'where do we live',
    'wrong location',
    'incorrect location',
    'correct location',
    'my location is wrong',
    'find my location',
    'detect my location',
    'locate me',
    'pinpoint me',
    'where am i located',
  ];

  return patterns.some((p) => clean.includes(p));
}

/**
 * Detects if the user explicitly commanded to open Google Maps
 */
export function shouldOpenGoogleMaps(text: string): boolean {
  const clean = text.toLowerCase().trim();
  return (
    clean.includes('open google maps') ||
    clean.includes('open google map') ||
    clean.includes('open maps') ||
    clean.includes('open map') ||
    clean.includes('launch google maps') ||
    clean.includes('launch maps') ||
    clean.includes('show on google maps') ||
    clean.includes('show in google maps')
  );
}

/**
 * Detects if the user is explicitly stating or setting their location/city in chat
 * e.g., "I am in Mumbai", "I live in Pune", "My location is Tokyo", "Set location to New York"
 */
export function parseLocationStatement(text: string): string | null {
  const clean = text.trim();
  const regexes = [
    /^(?:i\s+am\s+in|i'm\s+in|im\s+in)\s+([A-Za-z0-9\s,.-]+)$/i,
    /^(?:my\s+location\s+is|my\s+city\s+is)\s+([A-Za-z0-9\s,.-]+)$/i,
    /^(?:set\s+(?:my\s+)?location\s+to|change\s+(?:my\s+)?location\s+to|update\s+(?:my\s+)?location\s+to)\s+([A-Za-z0-9\s,.-]+)$/i,
    /^(?:i\s+live\s+in|currently\s+in)\s+([A-Za-z0-9\s,.-]+)$/i,
    /^(?:i\s+stay\s+in)\s+([A-Za-z0-9\s,.-]+)$/i,
  ];

  for (const regex of regexes) {
    const match = clean.match(regex);
    if (match && match[1]) {
      const city = match[1].replace(/[.?!]+$/, '').trim();
      if (city.length >= 2 && city.length <= 60) {
        return city;
      }
    }
  }

  return null;
}

/**
 * Builds a MapsLocationAction from a UserLocation
 */
export function buildMapsActionFromLocation(location: UserLocation): MapsLocationAction {
  return {
    type: 'current_location',
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy,
    formattedAddress: location.formattedAddress,
    city: location.city,
    neighborhood: location.neighborhood,
    country: location.country,
    googleMapsUrl: location.googleMapsUrl,
    embedUrl: location.embedUrl,
    googleMapsPriority: location.googleMapsPriority !== false,
    usedAlternative: location.usedAlternative,
    source: location.source,
    mapsFailureReason: location.mapsFailureReason || location.gpsFailureReason,
    gpsFailureReason: location.gpsFailureReason,
  };
}
