/**
 * Asynchronous loader for Google Maps Platform JavaScript API with the `maps3d` library.
 * Guarantees single-script injection, error handling, and promise caching.
 */

// Fallback provisioned key for Maps Platform 3D Earth
export const DEFAULT_MAPS_API_KEY =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_MAPS_API_KEY) ||
  'AIzaSyDb5zl5tAdB3GumWg_WoHM2zQf65v2BBoA';

let loadPromise: Promise<void> | null = null;

export function isGoogleMapsLoaded(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).google?.maps?.maps3d?.Map3DElement);
}

export function loadGoogleMaps3D(apiKey: string = DEFAULT_MAPS_API_KEY): Promise<void> {
  if (isGoogleMapsLoaded()) {
    return Promise.resolve();
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    const key = apiKey || DEFAULT_MAPS_API_KEY;
    if (!key) {
      reject(new Error('Google Maps API Key is required to initialize Google Earth 3D'));
      return;
    }

    // Check if script was already attached to document
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src*="maps.googleapis.com/maps/api/js"]'
    );

    const onScriptLoaded = async () => {
      try {
        if ((window as any).google?.maps?.importLibrary) {
          await (window as any).google.maps.importLibrary('maps3d');
        }
        resolve();
      } catch (err: any) {
        reject(new Error('Failed to import Google Maps maps3d library: ' + (err?.message || err)));
      }
    };

    if (existingScript) {
      if ((window as any).google?.maps) {
        onScriptLoaded();
      } else {
        existingScript.addEventListener('load', onScriptLoaded);
        existingScript.addEventListener('error', (e) =>
          reject(new Error('Failed loading existing Google Maps script: ' + e))
        );
      }
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?loading=async&key=${encodeURIComponent(
      key
    )}&libraries=maps3d`;
    script.async = true;
    script.defer = true;
    script.id = 'google-maps-3d-script';

    script.onload = () => {
      onScriptLoaded();
    };

    script.onerror = (e) => {
      loadPromise = null;
      reject(new Error('Failed to load Google Maps 3D script from Google CDN'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}
