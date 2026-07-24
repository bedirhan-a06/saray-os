/* AboSaray Service Worker – Offline-Cache + Benachrichtigungen */
const CACHE = "abosaray-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./vendor-supabase.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  // Nur eigene statische Dateien im App-Pfad cachen, API-Calls (Supabase) immer live
  if (url.origin === location.origin && url.pathname.startsWith(scopePath) && e.request.method === "GET") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});

/* Push-Nachrichten (falls später ein Push-Server ergänzt wird) */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data.json(); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title || "AboSaray", {
      body: data.body || "Eine Abo-Zahlung steht an.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png"
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow("./"));
});
