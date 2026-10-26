// Кэш для работы без интернета в зале. При изменении файлов увеличь номер версии.
const CACHE = "zal-v4";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => fetch(new Request(f, { cache: "reload" })).then(r => c.put(f, r))))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Сначала сеть без браузерного кэша (чтобы обновления приходили сразу), без сети: из кэша
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then(r => { const copy = r.clone(); if (r.ok && new URL(e.request.url).origin === location.origin) caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
