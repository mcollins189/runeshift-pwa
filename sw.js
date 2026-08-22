// sw.js — NuzTracker service worker (PWA v1.0)
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

// v3 — renamed primary HTML from tracker.html to index.html so the app
// serves at the bare poke.runeshift.xyz/ root. tracker.html is kept as a
// tiny redirect stub for existing installed PWAs (their cached manifest
// still references tracker.html) and old bookmarks. Bumping the cache
// version forces the activate sweep to evict the old v2 shell so users
// get the new SHELL_URLS list on next visit.
// v4 — self-hosted sprites: the app now serves all sprites from same-origin
// ./sprites/ (pixel + WebP artwork) instead of raw.githubusercontent / weserv.
// A cache-first route caches them on view (and the pre-cache pre-fills them);
// bumping the shell cache evicts the old v3 shell so installed users pick up
// the self-host index.html.
// v5 — offline data.bundle.js fix: index.html loads data.bundle.js?v=<ts>
// (build-data rewrites the ?v= each build), but install caches it under the
// bare path. cacheFirst matched ?v=NNN with ignoreSearch:false, so once a
// deploy bumped ?v=, offline clients had no entry for the new query →
// data.bundle.js failed → NUZ_DATA undefined → bosses + most features broke
// offline. cacheFirst now falls back to an ignoreSearch match when the exact
// key misses AND the network is unreachable, rescuing the bundle offline while
// keeping the online ?v= freshness path (exact miss → fetch fresh → re-cache).
// Bumped to evict the stale/broken v4 cache and force a fresh reinstall.
// v6 — precache enumeration now filters against bundled PokeAPI validity sets
// (skips fakemon / custom moves / form species-endpoints / evo-chain gaps) and
// the dead raw.githubusercontent sprite route was removed. Bumped so existing
// clients adopt the new SW + re-cache the fresh data.bundle.js.
// v7 — manifest.json orientation changed (natural -> any) + a phone-landscape
// rotate-to-portrait guard added in index.html. manifest.json is a cache-first
// shell asset, so bump to re-cache it (index.html is network-first already).
// v105 — TRE Johto added and Unbound's league data rebuilt from the cartridge.
// data.bundle.js is a PRECACHED shell asset, so installed clients keep serving
// the old copy until SHELL_CACHE changes and the activate sweep evicts it. The
// index.html ?v= cache-buster alone is not enough for them: it only helps once
// the new index.html is itself in play. Any deploy that changes bundled DATA has
// to bump this constant — the v5/v6 notes above are the same lesson.
// v8 — manifest.json orientation set to "portrait" (hard lock for installed
// Android PWAs; the JS screen.orientation.lock fallback alone was unreliable).
// Re-cache the new manifest.
// v9 — HTML shell is now CACHE-FIRST + background-revalidate (was network-first):
// the launch navigate serves the cached index.html instantly (no network wait), which
// kills the long iOS launch black screen. Bump forces installed clients to adopt the
// new SW + re-cache the current index.html (boot splash, non-blocking head, body-loaded
// bundle). Deployed HTML now lands one launch later (the bg fetch caches it).
// v10 — sprites are NETWORK-FIRST (browser HTTP cache) with SW-cache offline fallback,
// and the on-launch cache-status enumeration was removed. Both stop the launch/render
// path from touching the huge POKEAPI_CACHE, which is slow on iOS once fully pre-cached
// (was: launch black screen + sprites vanishing on re-render, ONLY with a full pre-cache).
// The activate keep-set preserves POKEAPI_CACHE, so the user's downloaded pre-cache stays.
// v46 — update-reliability + a visible build tag (Rules → Display shows "Build v46")
// so it's unambiguous which version a device is actually running. Registration now
// uses updateViaCache:'none' + reg.update() on load so new deploys aren't masked by a
// cached sw.js. Same code fixes as v45 (the pokeView crash fix) — that just wasn't
// reaching the handheld because the old SW kept serving cached code.
// v45 — pokeView crash fix (pokeInfo stub now complete t/a/id) + modal safety net.
// v44 — SortableJS drag tolerance (secondary).
// v48 — THE fix. The tap debugger (v47) revealed it: the handheld fires a GHOST
// duplicate click ~ms after the opening tap; that phantom click hit the modal
// backdrop / catch-menu outside area and slammed the just-opened modal shut → looked
// like "tapping does nothing". openModal + encActionMenu now stamp an open-time and
// the backdrop/outside close handlers ignore closes for 500ms → the ghost is swallowed.
// v47 — on-screen tap debugger (diagnostic).
// v49 — widen the ghost-click guard to 800ms + log the OPEN/CLOSE/SWALLOW lifecycle in
// the tap debugger so we can see whether the modal/menu opens then gets closed and by
// what (confirms if the guard is catching the handheld's phantom duplicate click).
const SHELL_CACHE = 'nuz-shell-v170';
// v2 — all self-hosted artwork sprites (sprites/art*, sprites/pixel* unchanged)
// were regenerated (trimmed/normalized). Sprites are served cache-first as
// "immutable", so without a bump existing clients would keep the old artwork
// forever. Bumping evicts the old cache (activate sweep) so they re-fetch the
// normalized sprites. Also re-fetches PokeAPI api responses (cheap, network-backed).
const POKEAPI_CACHE = 'nuz-pokeapi-v2';

// Same-origin shell URLs use relative paths so the PWA works at any subpath
// (e.g. github.io/runeshift-pwa/) — they resolve against self.location, which
// is the directory the SW was served from. Cross-origin URLs stay absolute.
const SHELL_URLS = [
  'index.html',
  'tracker.html',       // redirect stub for legacy installs / bookmarks
  'data.bundle.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-1024.png',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap'
];

// Resolved once at SW init so isShellAsset can pathname-compare against the
// actual absolute path (which the runtime sees on the fetch event).
const SHELL_PATHS = new Set(SHELL_URLS.map((u) => {
  try { return new URL(u, self.location).pathname; }
  catch (e) { return u; }
}));
const APP_HTML_PATH = new URL('index.html', self.location).pathname;
const SW_BASE_PATH = new URL('./', self.location).pathname;
// Self-hosted sprite assets live under ./sprites/ — id-keyed and immutable, so
// they're served cache-first (no revalidation) once fetched.
const SPRITES_PATH = new URL('sprites/', self.location).pathname;

// --- Install: pre-cache the shell -------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use individual adds so one failed cross-origin fetch doesn't nuke install.
    await Promise.all(SHELL_URLS.map(async (url) => {
      try {
        // `no-store` to dodge HTTP cache entirely — only Cache Storage holds
        // the shell asset, so we don't double-store. Halves disk footprint.
        const req = new Request(url, { cache: 'no-store' });
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

  // PokeAPI data (species/pokemon/move/evolution/region/location) -> stale-
  // while-revalidate. Sprites are self-hosted under ./sprites/ now (handled
  // below), so the old raw.githubusercontent PokeAPI/sprites route was dead and
  // has been removed.
  if (url.hostname === 'pokeapi.co' && url.pathname.startsWith('/api/v2/')) {
    event.respondWith(staleWhileRevalidate(req, POKEAPI_CACHE));
    return;
  }

  // Self-hosted sprites (same-origin ./sprites/*) -> NETWORK-FIRST via the browser's
  // HTTP cache, with the SW Cache Storage only as an OFFLINE fallback. Sprites are
  // immutable, so the browser HTTP cache serves them instantly when warm — and crucially
  // it does NOT touch the SW Cache Storage, which on iOS WebKit gets slow once a full
  // pre-cache has filled it with thousands of entries. Cache-first there made every
  // sprite lookup slow post-precache → launch black screen + sprites vanishing on
  // re-render. This keeps the online hot path off the big slow cache; offline still
  // resolves from the pre-cached entries.
  if (url.origin === self.location.origin && url.pathname.startsWith(SPRITES_PATH)) {
    event.respondWith(spriteNetworkFirst(req, POKEAPI_CACHE));
    return;
  }

  // Shell HTML -> CACHE-FIRST + background revalidate (app-shell model). The PWA
  // launch (a navigate) is served INSTANTLY from the cached index.html — no network
  // wait — which is what was leaving iOS on a long black screen before the page (and
  // its boot splash) could paint. The network copy is fetched in the background to
  // refresh the cache for the NEXT launch, so updates still land (one launch later).
  if (isShellHtml(req, url)) {
    event.respondWith(cacheFirstRevalidate(req, SHELL_CACHE));
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
      return await fetch(req, { cache: 'no-store' });
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw e;
    }
  })());
});

function isShellHtml(req, url) {
  if (req.mode === 'navigate') return true;
  if (url.pathname === APP_HTML_PATH || url.pathname === SW_BASE_PATH) return true;
  return false;
}

function isShellAsset(url) {
  if (url.origin === self.location.origin) {
    return SHELL_PATHS.has(url.pathname);
  }
  return SHELL_URLS.includes(url.href);
}

// --- Caching strategies -----------------------------------------------------
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Offline + exact-key miss. Retry the lookup ignoring the query string so a
    // request like data.bundle.js?v=<new-ts> still resolves against the bare
    // install-time entry (or a previously-cached ?v=). Without this, a deploy
    // that bumped ?v= leaves offline clients with no bundle → NUZ_DATA undefined
    // → bosses + most features break. Other shell assets carry no query, so the
    // ignoreSearch match is identical to the exact match for them (harmless).
    const alt = await cache.match(req, { ignoreSearch: true });
    if (alt) return alt;
    throw e;
  }
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const matchCached = async () => (await cache.match(req)) || (await cache.match('index.html')) || (await cache.match('/index.html'));
  // Network fetch that also refreshes the cache on success. Kept as a live promise
  // so it can update the cache in the background even when we serve from cache.
  const net = fetch(req, { cache: 'no-store' }).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  });
  // Timeout-bounded network-first for the HTML shell. A PWA launch is a `navigate`
  // request routed here; awaiting the network with NO bound meant a slow/asleep
  // network (classic on an iPad PWA cold-launch, where iOS hasn't reconnected wifi
  // yet) hung the launch on a black screen until the OS fetch timed out. Now: if a
  // cached shell exists, race the network against a short timeout and serve the
  // cache the instant the network is slow — the network promise keeps running and
  // refreshes the cache for the NEXT launch, so we stay fresh without ever hanging.
  if (timeoutMs) {
    const cached = await matchCached();
    if (cached) {
      const TIMED_OUT = Symbol('timeout');
      const winner = await Promise.race([
        net.catch(() => TIMED_OUT),
        new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
      ]);
      if (winner && winner !== TIMED_OUT && winner.ok) return winner;   // network answered in time → freshest
      net.catch(() => {});   // let the background refresh finish + swallow errors
      return cached;          // slow/failed network → instant cached shell
    }
  }
  // No cached shell yet (first-ever load) or no timeout requested → await the network,
  // fall back to any cache on failure.
  try { return await net; }
  catch (e) { const hit = await matchCached(); if (hit) return hit; throw e; }
}

// App-shell HTML strategy: serve the cached index.html INSTANTLY (zero network wait),
// and refresh the cache in the BACKGROUND for the next launch. This is what makes the
// PWA launch instant — a navigate never blocks on the network (the iOS black-screen
// cause). Trade-off: a freshly deployed index.html lands one launch later (the bg
// fetch caches it; the following launch serves it). First-ever load (cold, no cache)
// still awaits the network since there's nothing to serve yet.
// Sprites: serve from the network (= browser HTTP cache for these immutable files) and
// only fall back to the SW Cache Storage when offline. Lets the browser's fast HTTP cache
// satisfy sprites without an iOS-slow Cache Storage match against a huge pre-cache. Uses
// the DEFAULT fetch cache mode (not no-store) so the HTTP cache is actually used. A
// fire-and-forget put keeps the offline copy warm for not-yet-pre-cached sprites without
// blocking the response.
async function spriteNetworkFirst(req, cacheName) {
  let netRes = null;
  try { netRes = await fetch(req); }   // default cache mode → browser HTTP cache hit when warm
  catch (e) { netRes = null; }         // ONLY a thrown fetch means offline/network error
  if (netRes) {
    // We're online (got a response, even a 404). Return it directly and NEVER touch the
    // big SW Cache Storage — that keeps the online path off the iOS-slow cache even for a
    // missing sprite (a 404 → the page's <img onerror> just hides it). Warm the offline
    // copy fire-and-forget only for real hits.
    if (netRes.ok || netRes.type === 'opaque') {
      const copy = netRes.clone();
      caches.open(cacheName).then((c) => c.put(req, copy)).catch(() => {});
    }
    return netRes;
  }
  // Offline ONLY: fall back to the (possibly large, slow-on-iOS) SW cache — acceptable
  // since there's no network and this path isn't hit while online.
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  return hit || new Response('', { status: 504 });
}

async function cacheFirstRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = (await cache.match(req)) || (await cache.match('index.html')) || (await cache.match('/index.html'));
  const net = fetch(req, { cache: 'no-store' }).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) return cached;            // INSTANT — background fetch updates the cache for next time
  const res = await net;                // cold first load → must wait for the network
  if (res) return res;
  throw new Error('offline: no cached shell');
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  let hit = await cache.match(req);
  // Trailing-slash-tolerant lookup. Earlier pre-cache versions stored some
  // PokeAPI URLs without a trailing slash while the runtime always fetches
  // with one (or vice versa). Without this, mismatched entries become
  // permanent cache misses and the renderer falls through to a "show
  // everything" fallback that loses version filtering + percentages.
  if (!hit) {
    const url = new URL(req.url);
    const altPath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname + '/';
    hit = await cache.match(url.origin + altPath + url.search);
  }
  // `cache: 'no-store'` bypasses the browser's HTTP cache entirely so we don't
  // double-store responses (once here in Cache Storage, once in HTTP cache).
  // Halves the on-disk footprint at the cost of revalidation always hitting
  // the network — but we serve from `hit` immediately, so user-visible speed
  // is unchanged. Applied across all strategies for consistency.
  const fetchPromise = fetch(req, { cache: 'no-store' }).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch((e) => {
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
          const res = await fetch(url, { cache: 'no-store' });
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
