// sw.js - Service Worker ASUFOR v6 (Stratégie Network First améliorée)
//
// CORRECTIONS :
// 1. Exclut les requêtes Firebase/CDN du cache local (évite des conflits d'auth)
// 2. Gestion propre des erreurs de cache
// 3. Mise à jour forcée fiable avec skipWaiting + clients.claim

const CACHE_NAME = 'asufor-cache-v6.3';

// Ressources à ne JAMAIS mettre en cache localement
const NEVER_CACHE = [
    'firebaseapp.com',
    'googleapis.com',
    'gstatic.com',
    'firebase.io',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
];

function shouldCache(url) {
    return !NEVER_CACHE.some(domain => url.includes(domain));
}

self.addEventListener('install', () => {
    console.log('[SW] Installation v6');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[SW] Activation v6');
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => {
                    console.log('[SW] Suppression ancien cache :', k);
                    return caches.delete(k);
                })
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = e.request.url;

    // Ignorer les requêtes non-GET et les domaines externes critiques
    if (e.request.method !== 'GET' || !shouldCache(url)) {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then(response => {
                // Mettre en cache uniquement les réponses valides de notre domaine
                if (
                    response &&
                    response.status === 200 &&
                    (response.type === 'basic' || response.type === 'cors')
                ) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(e.request, clone).catch(() => {});
                    });
                }
                return response;
            })
            .catch(() => {
                console.log('[SW] Hors-ligne, lecture cache :', url);
                return caches.match(e.request);
            })
    );
});
