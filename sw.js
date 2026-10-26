/* HIPCO Deals service worker: opens fast and works offline.
   App files: newest from the network, but if the network takes more than 3 s use the saved copy.
   Change VERSION on every release so phones pick up the new files. */
const VERSION = "hipco-deals-v6";
const SHELL = ["./", "index.html", "config.js", "db.js", "manifest.json", "vendor/supabase.js",
  "icons/logo.png", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req, ms = 3000) {
  return new Promise(resolve => {
    let done = false;
    const fallback = () => caches.match(req).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : undefined));
    const timer = setTimeout(() => fallback().then(r => { if (r && !done) { done = true; resolve(r); } }), ms);
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => fallback().then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r || new Response("Offline", {status: 503, statusText: "Offline"})); } }));
  });
}
function staleWhileRevalidate(req) {
  return caches.open(VERSION + "-ext").then(c => c.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
}

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(staleWhileRevalidate(req)); return; }
  /* database, login and file requests always go straight to the network */
});

/* a notification from the server: show it */
self.addEventListener("push", e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (err) { m = {body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(m.title || "HIPCO Deals", {
    body: m.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: {url: m.url || "./"}
  }));
});
/* tapping a notification opens the app on that deal */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  const id = new URL(url, self.location.href).searchParams.get("deal");
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for (const c of list) { if ("focus" in c) { if (id) c.postMessage({openDeal: id}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
