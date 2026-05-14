// sw.js - Service Worker avec Stratégie "Network First" (Réseau en priorité)
const CACHE_NAME = 'asufor-cache-v4.3';

self.addEventListener('install', (e) => {
    console.log('[Service Worker] Installation et mise à jour forcée');
    // Force le nouveau SW à s'installer immédiatement sans attendre
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[Service Worker] Activé');
    // Nettoie les anciens caches pour éviter de garder de vieux fichiers en mémoire
    e.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Nettoyage ancien cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim()) // Prend le contrôle de la page immédiatement
    );
});

self.addEventListener('fetch', (e) => {
    // Stratégie "Network First, falling back to cache"
    // 1. L'application essaie TOUJOURS de télécharger la dernière version (HTML, JS, CSS)
    // 2. Si ça échoue (pas de connexion internet), elle utilise la version en cache.
    e.respondWith(
        fetch(e.request)
            .then(response => {
                // Si on a bien récupéré le fichier sur internet, on le sauvegarde dans le cache
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        if (e.request.url.startsWith('http')) {
                            cache.put(e.request, responseClone);
                        }
                    });
                }
                return response;
            })
            .catch(() => {
                // Si on est hors-ligne, on renvoie ce qu'on a en mémoire (cache)
                console.log('[Service Worker] Mode hors-ligne, chargement depuis le cache:', e.request.url);
                return caches.match(e.request);
            })
    );
});
