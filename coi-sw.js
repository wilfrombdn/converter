// Gives the page cross-origin isolation (needed for SharedArrayBuffer, which the LibreOffice
// engine uses) on hosts like GitHub Pages that can't set COOP/COEP headers.
// Only same-origin responses (the page and its worker scripts) need the headers. Cross-origin
// requests are left to the browser: with COEP "credentialless" it strips credentials from no-cors
// loads itself, and proxying the 150 MB engine files through here truncated them.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  if (new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(fetch(r).then(res => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set("Cross-Origin-Embedder-Policy", "credentialless");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(err => { console.error(err); return Response.error(); }));
});
