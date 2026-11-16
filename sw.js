/* Hasan Enterprise Attendance - Service Worker
   Strategy:
   - Precache the app shell (local files) on install.
   - Cache-first for everything else (face-api.js CDN script + model weight
     files included) so that once a resource has been fetched successfully
     while online, it works forever offline. This is what makes 100% offline
     face recognition possible after the first successful app load.
*/

const CACHE_VERSION = "hasan-attendance-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db.js",
  "./sync.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept calls to the Google Apps Script backend - those must
  // always hit the network (or fail fast) so sync logic can detect offline
  // state correctly and queue the record instead of serving a stale cache.
  if (req.url.includes("script.google.com")) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((networkResponse) => {
          // Only cache successful, basic/cors responses (covers CDN assets
          // like face-api.js and its model weight files).
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (networkResponse.type === "basic" || networkResponse.type === "cors")
          ) {
            const clone = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Nothing cached and no network - let it fail; app.js handles
          // the "models not cached yet" case with an on-screen message.
          return new Response("", { status: 503, statusText: "Offline" });
        });
    })
  );
});
