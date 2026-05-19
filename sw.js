// sw.js — Nuzlocke Tracker service worker (PWA v1.0)
//
// Three cache layers:
//   1. Shell cache  (nuz-shell-v1)   — pre-cached on install, app boots offline.
//   2. PokeAPI runtime cache (nuz-pokeapi-v1) — stale-while-revalidate for
//      pokeapi.co/api/v2/* and raw.githubusercontent.com/PokeAPI/sprites/*.
//   3. Aggressive pre-cache         — opt-in, driven by `prefetch-all` message
//      from the page; fills nuz-pokeapi-v1 with whatever URL list the page
//      supplies (e.g. every species/move the active game touches).
//
// Icon rasterization note (for Dev B / future maintainers): icons/icon-192.png
// and icons/icon-512.png are generated from a plain-Node script at
// icons/_build-pngs.mjs (uses built-in zlib + manual CRC since sharp/canvas
// aren't installed). Re-run that script if icon.svg changes.
//
// Message protocol (in -> out, all via postMessage):
//   { type: 'prefetch-all', urls: [...] }
//     -> repeated { type: 'prefetch-progress', done, total }
//     -> final    { type: 'prefetch-done', cached, failed }
//   { type: 'clear-caches' }   -> { type: 'caches-cleared' }
//   { type: 'cache-status' }   -> { type: 'cache-status-result', shell, pokeapi }
//   { type: 'skip-waiting' }   -> (no reply; SW activates immediately)
//
// To bump versions: change SHELL_CACHE / POKEAPI_CACHE constants. The activate
// handler will sweep any older nuz-* cache. Keep the `nuz-` prefix so the
// sweep matches.

const SHELL_CACHE = 'nuz-shell-v2';
const POKEAPI_CACHE = 'nuz-pokeapi-v1';

const SHELL_URLS = [
  '/log.html',
  '/data.bundle.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-1024.png',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap'
];

// Cache bumped from v1 → v2 when the icons switched from the programmatic
// Pokeball placeholders to the real designed artwork. Old shell entries with
// the SVG reference would otherwise stick around.

// --- Install: pre-cache the shell -------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use individual adds so one failed cross-origin fetch doesn't nuke install.
    await Promise.all(SHELL_URLS.map(async (url) => {
      try {
        // `no-cache` to dodge HTTP cache and get a fresh shell on first install.
        const req = new Request(url, { cache: 'no-cache' });
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(url, res.clone());
        }
      } catch (e) {
        // Non-fatal: missing optional shell entries are tolerated.
        console.warn('[sw] shell precache failed for', url, e);
      }
    }));
  })());
});

// --- Activate: claim clients + sweep stale nuz-* caches ---------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, POKEAPI_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      if (n.startsWith('nuz-') && !keep.has(n)) return caches.delete(n);
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

// --- Fetch routing ----------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // PokeAPI / PokeAPI sprite CDN -> stale-while-revalidate.
  if (
    url.hostname === 'pokeapi.co' && url.pathname.startsWith('/api/v2/') ||
    url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/PokeAPI/sprites/')
  ) {
    event.respondWith(staleWhileRevalidate(req, POKEAPI_CACHE));
    return;
  }

  // Shell HTML -> network-first so the user gets updates when online.
  if (isShellHtml(req, url)) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // Other shell assets -> cache-first.
  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Everything else: try network, fall back to whatever's cached (no put).
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw e;
    }
  })());
});

function isShellHtml(req, url) {
  if (req.mode === 'navigate') return true;
  if (url.pathname === '/' || url.pathname === '/log.html') return true;
  return false;
}

function isShellAsset(url) {
  // Match by full URL string against SHELL_URLS, with same-origin shortcut.
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) {
    return SHELL_URLS.includes(url.pathname);
  }
  const full = url.href;
  return SHELL_URLS.includes(full);
}

// --- Caching strategies -----------------------------------------------------
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req) || await cache.match('/log.html');
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch((e) => {
    // Swallow network errors when we have a cache hit; rethrow otherwise.
    if (!hit) throw e;
    return hit;
  });
  return hit || fetchPromise;
}

// --- Message protocol -------------------------------------------------------
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'skip-waiting':
      self.skipWaiting();
      return;
    case 'clear-caches':
      event.waitUntil(handleClearCaches(event));
      return;
    case 'cache-status':
      event.waitUntil(handleCacheStatus(event));
      return;
    case 'prefetch-all':
      event.waitUntil(handlePrefetchAll(event, Array.isArray(msg.urls) ? msg.urls : []));
      return;
  }
});

async function handleClearCaches(event) {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('nuz-')).map((n) => caches.delete(n)));
  reply(event, { type: 'caches-cleared' });
}

async function handleCacheStatus(event) {
  const [shell, pokeapi] = await Promise.all([
    countCache(SHELL_CACHE),
    countCache(POKEAPI_CACHE)
  ]);
  reply(event, { type: 'cache-status-result', shell, pokeapi });
}

async function countCache(name) {
  if (!(await caches.has(name))) return 0;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  return keys.length;
}

async function handlePrefetchAll(event, urls) {
  const total = urls.length;
  const cache = await caches.open(POKEAPI_CACHE);
  let done = 0, cached = 0, failed = 0;
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      const url = urls[i];
      try {
        const existing = await cache.match(url);
        if (existing) {
          cached++;
        } else {
          const res = await fetch(url);
          if (res && (res.ok || res.type === 'opaque')) {
            await cache.put(url, res.clone());
            cached++;
          } else {
            failed++;
          }
        }
      } catch (e) {
        failed++;
      }
      done++;
      if (done % 10 === 0 || done === total) {
        reply(event, { type: 'prefetch-progress', done, total });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total || 1) }, worker));
  reply(event, { type: 'prefetch-done', cached, failed });
}

function reply(event, payload) {
  // Prefer the originating client (event.source); fall back to broadcasting
  // so a page that lost its handle still sees lifecycle messages.
  if (event.source && typeof event.source.postMessage === 'function') {
    event.source.postMessage(payload);
    return;
  }
  self.clients.matchAll({ includeUncontrolled: true }).then((list) => {
    for (const c of list) c.postMessage(payload);
  });
}
