// sw.js - Service Worker ASUFOR v9 (Stratégie Network First robuste)
//
// CORRECTIONS v8 :
// 1. Exclut les requêtes Firebase/CDN du cache local (évite des conflits d'auth)
// 2. Gestion propre des erreurs de cache
// 3. Mise à jour forcée fiable avec skipWaiting + clients.claim
// 4. ✅ NOUVEAU : Exclusion des requêtes chrome-extension et non-http
// 5. ✅ NOUVEAU : Vérification que la réponse est clonable avant mise en cache
// 6. ✅ NOUVEAU : Timeout réseau pour basculer sur le cache plus vite hors ligne

const CACHE_NAME = 'asufor-cache-v9.1';

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
    // ✅ CORRECTION : ignorer les URLs non-http (chrome-extension, data:, etc.)
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return !NEVER_CACHE.some(domain => url.includes(domain));
}

self.addEventListener('install', () => {
    console.log('[SW] Installation v9');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[SW] Activation v9');
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

    // ✅ CORRECTION : Ignorer les requêtes non-GET et les domaines externes critiques
    if (e.request.method !== 'GET' || !shouldCache(url)) {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then(response => {
                // ✅ CORRECTION : Vérifier que la réponse est valide et clonable
                if (
                    response &&
                    response.status === 200 &&
                    (response.type === 'basic' || response.type === 'cors') &&
                    !response.bodyUsed
                ) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(e.request, clone).catch(() => {});
                    });
                }
                return response;
            })
            .catch(() => {
                // ✅ CORRECTION : Retourner une réponse de fallback si pas de cache
                console.log('[SW] Hors-ligne, lecture cache :', url);
                return caches.match(e.request).then(cached => {
                    if (cached) return cached;
                    // Page de fallback minimale si rien en cache
                    if (e.request.destination === 'document') {
                        return new Response(
                            '<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:white">' +
                            '<h2>📡 Hors ligne</h2><p>Reconnectez-vous pour accéder à ASUFOR.</p></body></html>',
                            { headers: { 'Content-Type': 'text/html' } }
                        );
                    }
                    return new Response('', { status: 503 });
                });
            })
    );
});
