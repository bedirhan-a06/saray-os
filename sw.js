/* Saray OS Service Worker – Offline-Cache + Benachrichtigungen */
const CACHE = "sarayos-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./brands.js",
  "./vendor-supabase.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
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

/* Push-Nachrichten vom Server (Supabase Edge Function "push") */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data.json(); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title || "Saray OS", {
      body: data.body || "Eine Abo-Zahlung steht an.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      // Gleiches tag: eine neue Erinnerung ersetzt die alte, statt sie zu stapeln
      tag: data.tag || "sarayos-faellig",
      renotify: true
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Ist die App schon offen, dorthin wechseln statt ein zweites Fenster zu oeffnen
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((liste) => {
      for (const c of liste) {
        if (c.url.includes(self.registration.scope) && "focus" in c) return c.focus();
      }
      return clients.openWindow("./");
    })
  );
});
