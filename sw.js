/* TaskTrack service worker — offline support.
   Bump CACHE version whenever the cached files change so clients update. */
const CACHE = "tasktrack-v11";
// App-shell files served network-first so updates reach clients immediately when
// online (fall back to cache when offline). Everything else is cache-first.
const CORE = ["/", "/index.html", "/app.js", "/styles.css", "/request.html", "/request.js",
  "/supabase-config.js", "/theme-init.js", "/sw-register.js"];
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./request.html",
  "./request.js",
  "./theme-init.js",
  "./sw-register.js",
  "./supabase-config.js",
  "./vendor/supabase.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  // Note: no skipWaiting here — a new version waits until the user taps
  // "Update available", so we never reload out from under them.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks the waiting worker to activate when the user taps refresh.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---- Web Push ----
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || "TaskTrack";
  const options = {
    body: data.body || "You have an update.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: data.tag || "tasktrack",
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCore = sameOrigin && (event.request.mode === "navigate" || CORE.includes(url.pathname));

  if (isCore) {
    // Network-first: always try to get the latest, fall back to cache offline.
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); }
          return res;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for everything else (icons, vendored library, fonts…).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res.ok && sameOrigin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); }
          return res;
        })
        .catch(() => cached);
    })
  );
});
