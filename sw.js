// sw.js — Service Worker Satigué Eau v47 (professionnel)
//
// Stratégie :
//  • App shell (HTML/JS/CSS/icônes locaux) pré-cachés à l'installation.
//  • Network-first pour la navigation et les ressources locales : on privilégie
//    toujours la version en ligne (données Firebase à jour), le cache ne sert
//    que de secours hors-ligne.
//  • Firebase / CDN / Google Fonts : jamais mis en cache (évite conflits d'auth).
//  • Page hors-ligne dédiée (offline.html) si aucune version en cache.
//  • Support SKIP_WAITING → mise à jour immédiate déclenchée par l'utilisateur.

const CACHE_NAME = 'asufor-cache-v62';

// App shell relatif à la racine du scope (le SW est à la racine admin/)
const APP_SHELL = [
    './',
    './index.html',
    './offline.html',
    './manifest.json',
    './pwa.js',
    './billing.js',
    './compta.js',
    './compta-ui.js',
    './loader.js',
    './sync.js',
    './data-cache.js',
    './security.js',
    './biometric.js',
    './crypto.js',
    './admin-config.js',
    './firebase-config.js',
    './forage-context.js',
    './provisioning.js',
    './home/accueil.html',
    './counter/list.html',
    './statistiques/stats.html',
    './statistiques/stats.css',
    './statistiques/stats.js',
    './impression/impression.html',
    './compte/releve.html',
    './compte/recu.html',
    './reset/zero.html',
    './agents/agent.html',
    './admin/admin.html',
    './equipe/equipe.html',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/logo.png',
];

// Domaines à ne JAMAIS mettre en cache localement
const NEVER_CACHE = [
    'firebaseapp.com',
    'googleapis.com',
    'gstatic.com',
    'firebase.io',
    'firebaseio.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'flaticon.com',
];

function shouldCache(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return !NEVER_CACHE.some(d => url.includes(d));
}

// ── INSTALL : pré-cache de l'app shell ──
self.addEventListener('install', (e) => {
    console.log('[SW] Installation v47');
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            // addAll échoue si un seul fichier manque → on tolère les absences
            Promise.allSettled(APP_SHELL.map(u => cache.add(u)))
        ).then(() => self.skipWaiting())
    );
});

// ── ACTIVATE : purge des anciens caches ──
self.addEventListener('activate', (e) => {
    console.log('[SW] Activation v47');
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
                console.log('[SW] Suppression ancien cache :', k);
                return caches.delete(k);
            }))
        ).then(() => self.clients.claim())
    );
});

// ── MESSAGE : mise à jour immédiate demandée par pwa.js ──
self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── FETCH : network-first avec secours cache + page hors-ligne ──
self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = req.url;

    if (req.method !== 'GET' || !shouldCache(url)) return;

    e.respondWith(
        fetch(req).then(response => {
            if (
                response &&
                response.status === 200 &&
                (response.type === 'basic' || response.type === 'cors') &&
                !response.bodyUsed
            ) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(c => c.put(req, clone).catch(() => {}));
            }
            return response;
        }).catch(() =>
            caches.match(req).then(cached => {
                if (cached) return cached;
                if (req.destination === 'document' || req.mode === 'navigate') {
                    return caches.match('./offline.html').then(off =>
                        off || new Response(
                            '<!doctype html><meta charset="utf-8"><title>Hors ligne</title>' +
                            '<body style="font-family:system-ui;text-align:center;padding:48px;background:#0f172a;color:#fff">' +
                            '<h2>📡 Hors ligne</h2><p>Reconnectez-vous pour accéder à Satigué Eau.</p></body>',
                            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                        )
                    );
                }
                return new Response('', { status: 503 });
            })
        )
    );
});
