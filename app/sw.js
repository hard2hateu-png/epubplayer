/* App assets only. Generated audio, voice samples, and tokens are never cached. */
const CACHE = "pocket-ios-20260916-1";
const ASSETS = ["/style.css", "/app.js", "/manifest.webmanifest", "/icons/icon-180.png", "/icons/icon-512.png", "/libs/pdf.min.js", "/libs/pdf.worker.min.js", "/libs/jszip.min.js"];
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("pocket-ios-") && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && !response.redirected) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});
