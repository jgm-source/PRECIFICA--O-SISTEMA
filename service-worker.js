const VERSION = 'precocerto-v1';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const APP_SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/offline.html',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => ![STATIC_CACHE,RUNTIME_CACHE].includes(key)).map(key => caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname === '/api/config' || url.hostname.endsWith('.supabase.co')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => { const copy=response.clone();caches.open(RUNTIME_CACHE).then(cache=>cache.put('/index.html',copy));return response; }).catch(async()=>await caches.match('/index.html')||await caches.match('/offline.html')));
    return;
  }

  event.respondWith(caches.match(request,{ignoreSearch:true}).then(cached => cached || fetch(request).then(response => {
    if (response.ok || response.type === 'opaque') { const copy=response.clone();caches.open(RUNTIME_CACHE).then(cache=>cache.put(request,copy)); }
    return response;
  })));
});
