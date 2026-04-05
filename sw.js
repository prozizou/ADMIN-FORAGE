// sw.js - Service Worker basique pour satisfaire les critères PWA
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Installation');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[Service Worker] Activé');
});

self.addEventListener('fetch', (e) => {
    // Ne fait rien de spécial pour l'instant, laisse passer les requêtes normalement
});

