// sw.js - Service worker: permite instalar la página como app y que abra
// aunque no haya conexión. Los datos (/api) nunca se guardan en caché:
// siempre se piden al servidor para que las alertas estén al día.

const VERSION = 'alertas-v2'; // cambiar al publicar cambios en public/
const ARCHIVOS = [
  '/',
  '/index.html',
  '/app.js',
  '/estilos.css',
  '/manifest.webmanifest',
  '/iconos/icono-192.png',
  '/iconos/favicon.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ARCHIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

// Primero la red (para ver siempre la última versión); si no hay conexión, la copia guardada.
self.addEventListener('fetch', (evento) => {
  const { request } = evento;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }
  evento.respondWith(
    fetch(request)
      .then((respuesta) => {
        if (respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copia));
        }
        return respuesta;
      })
      .catch(async () => {
        const guardada = await caches.match(request);
        if (guardada) return guardada;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      })
  );
});
