const CACHE_NAME = 'asufor-v1';
self.addEventListener('install', (event) => {
    self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
    // Laisse les requêtes passer normalement
});
