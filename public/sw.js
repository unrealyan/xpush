// XPush Service Worker —— network-first 壳（联网必取最新，离线回退缓存）+ Web Push
const CACHE = "xpush-v6";
const SHELL = [
  "/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon.svg",
  "/vendor/markdown-it.min.js", "/vendor/purify.min.js", "/vendor/highlight.min.js", "/vendor/hljs-github-dark.css",
];

self.addEventListener("install", (e) => {
  // 立即接管，确保新版尽快生效（配合页面 controllerchange 自动重载）
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (/^\/(api|ws|w|tg|ding)\b/.test(url.pathname)) return; // 动态接口走网络，不缓存
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // vendor / icons：体积大、极少变 → 缓存优先
  const cacheFirst = url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/icons/");

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (cacheFirst) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.status === 200) cache.put(e.request, res.clone());
        return res;
      } catch {
        return cache.match("/");
      }
    }
    // 应用壳（html/js/css/manifest）：network-first，联网必取最新
    try {
      const res = await fetch(e.request);
      if (res && res.status === 200 && res.type === "basic") cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request)) || (await cache.match("/"));
    }
  })());
});

// 与页面通信：立即接管 / 强制刷新壳缓存
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (e.data === "REFRESH") {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map(async (u) => {
          try {
            const r = await fetch(u, { cache: "reload" });
            if (r.ok) await cache.put(u, r.clone());
          } catch {}
        })
      );
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.postMessage({ type: "REFRESHED" }));
    })());
  }
});

// Web Push（M4）：服务端发推 → 这里展示系统通知
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || "XPush";
  const options = {
    body: data.body || "你有一条新消息",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
    tag: data.id || undefined,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(url);
    })
  );
});
