// Service worker : l'application s'ouvre HORS LIGNE. Les fichiers de l'application sont mis en cache à l'installation sous une version
// (__BUILD__ est remplacé par le serveur par une empreinte des fichiers : dès qu'un fichier change, le service worker change et la nouvelle
// version s'installe d'un bloc, jamais un mélange d'anciens et de nouveaux fichiers). L'API n'est JAMAIS mise en cache ni interceptée.
const BUILD = "__BUILD__";
const CACHE = `lx-shell-${BUILD}`;
const SHELL = ["/", "/index.html", "/app.js", "/store.js", "/sync.js", "/local.js", "/engine.js", "/i18n.js", "/styles.css", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("lx-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  // Seuls les fichiers de l'application sont servis par le cache (les autres pages, comme la démonstration passager, passent par le réseau).
  if (!SHELL.includes(url.pathname)) return;
  const key = req.mode === "navigate" ? "/index.html" : req;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return req.mode === "navigate" ? (await cache.match("/index.html")) ?? Response.error() : Response.error();
      }
    })
  );
});
