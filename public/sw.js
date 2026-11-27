/**
 * Krisha Service Worker — Offline UI Shell Cache
 *
 * Strategy:
 *  - App shell (JS/CSS/HTML/fonts/model) → Cache-first (served instantly offline)
 *  - API calls to /api/* → Network-only (fall through; never cached)
 *  - Everything else → Stale-while-revalidate
 *
 * Cache is versioned: bump CACHE_VERSION when deploying new builds so stale
 * assets are cleared automatically on the next SW activation.
 */

const CACHE_VERSION = 'krisha-v1';
const SHELL_CACHE  = `${CACHE_VERSION}-shell`;
const FONT_CACHE   = `${CACHE_VERSION}-fonts`;

// Assets that must be pre-cached for the UI to render offline.
// Vite hashes file names, so we keep the top-level roots; dynamic assets
// are added to the cache as they are fetched (see fetch handler below).
const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Take control immediately — don't wait for old SW to die.
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('krisha-') && key !== SHELL_CACHE && key !== FONT_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Claim all existing clients so the new SW takes effect immediately.
  self.clients.claim();
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept API calls — let them fail naturally when offline.
  if (url.pathname.startsWith('/api/')) return;

  // 2. Google Fonts stylesheet & font files → stale-while-revalidate in font cache.
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // 3. Same-origin assets (JS, CSS, images, VRM model, etc.) → cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // 4. Everything else → network with cache fallback.
  event.respondWith(networkWithCacheFallback(request, SHELL_CACHE));
});

// ─── Strategies ───────────────────────────────────────────────────────────────

/**
 * Cache-first: return cached copy instantly; refresh cache in background.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Background refresh (don't await)
    fetchAndCache(request, cache).catch(() => {});
    return cached;
  }
  return fetchAndCache(request, cache);
}

/**
 * Stale-while-revalidate: return cached copy instantly if available,
 * always fetch fresh in background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetchAndCache(request, cache).catch(() => cached);
  return cached || networkPromise;
}

/**
 * Network-first with cache fallback for offline.
 */
async function networkWithCacheFallback(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Return a minimal offline placeholder for navigation requests.
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Fetch a request and store it in the given cache; return the response.
 */
async function fetchAndCache(request, cache) {
  const response = await fetch(request);
  // Only cache successful, non-opaque responses.
  if (response.ok && response.type !== 'opaque') {
    cache.put(request, response.clone());
  }
  return response;
}
