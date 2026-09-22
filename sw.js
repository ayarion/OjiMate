const CACHE_NAME='ojimate-shell-v3';
const APP_SHELL=[
  './','./index.html','./tokens.css','./manifest.webmanifest','./icon.svg',
  './icon-192.png','./icon-512.png','./apple-touch-icon.png','./vendor/three.r128.min.js',
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ojimate-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  if(request.mode==='navigate'){
    const scopePath=new URL(self.registration.scope).pathname;
    const isAppEntry=url.origin===self.location.origin&&
      (url.pathname===scopePath||url.pathname===scopePath+'index.html');
    event.respondWith(fetch(request).then(response=>{
      if(isAppEntry&&response.ok&&response.type==='basic'){
        const copy=response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy)));
      }
      return response;
    }).catch(async()=>isAppEntry?(await caches.match('./index.html')||Response.error()):Response.error()));
    return;
  }
  const cacheable=url.origin===self.location.origin;
  if(!cacheable) return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok||response.type==='opaque'){
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(request,copy)));
    }
    return response;
  })));
});
