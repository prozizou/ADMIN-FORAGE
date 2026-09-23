/**
 * Gestionnaire PWA — Satigué Eau (v3, professionnel)
 *
 * Fonctions :
 *  1. Enregistrement du Service Worker (chemin dérivé de CE script → marche à toute profondeur).
 *  2. Bannière d'installation élégante (Android/Chrome/Edge via beforeinstallprompt).
 *  3. Prise en charge iOS/Safari : instructions manuelles "Partager → Sur l'écran d'accueil".
 *  4. Notification de mise à jour : propose de recharger quand une nouvelle version du SW est prête.
 *
 * Aucune dépendance externe. S'auto-injecte proprement, ne casse rien si le DOM n'est pas prêt.
 */
(function () {
    'use strict';

    var PWA_SELF = document.currentScript;

    // ────────────────────────────────────────────────
    // 1. ENREGISTREMENT DU SERVICE WORKER + MISE À JOUR
    // ────────────────────────────────────────────────
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            var swUrl = 'sw.js';
            try {
                var src = (PWA_SELF && PWA_SELF.src) ? PWA_SELF.src : '';
                if (src) swUrl = src.replace(/pwa\.js(\?.*)?$/, 'sw.js');
            } catch (_) { /* fallback 'sw.js' */ }

            navigator.serviceWorker.register(swUrl).then(function (reg) {
                console.log('[PWA] Service Worker enregistré :', reg.scope);

                // Détection d'une nouvelle version en attente
                function watchInstalling(worker) {
                    if (!worker) return;
                    worker.addEventListener('statechange', function () {
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdateToast(reg);
                        }
                    });
                }
                if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg);
                reg.addEventListener('updatefound', function () {
                    watchInstalling(reg.installing);
                });
                // Vérifie les mises à jour périodiquement (toutes les 30 min)
                setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
            }).catch(function (err) {
                console.warn('[PWA] Erreur SW :', err);
            });

            // Rechargement automatique une fois le nouveau SW activé
            var refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', function () {
                if (refreshing) return;
                refreshing = true;
                window.location.reload();
            });
        });
    }

    // ────────────────────────────────────────────────
    // STYLES (injectés une seule fois)
    // ────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('pwa-styles')) return;
        var css = document.createElement('style');
        css.id = 'pwa-styles';
        css.textContent = [
            '@keyframes pwaSlideUp{from{transform:translate(-50%,120%);opacity:0}to{transform:translate(-50%,0);opacity:1}}',
            '.pwa-card{position:fixed;bottom:calc(18px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);',
            'width:92%;max-width:420px;z-index:99999;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
            'background:rgba(17,24,39,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);',
            'border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:16px;',
            'box-shadow:0 18px 40px rgba(0,0,0,.55);animation:pwaSlideUp .35s cubic-bezier(.16,1,.3,1);color:#fff}',
            '.pwa-row{display:flex;align-items:center;justify-content:space-between;gap:14px}',
            '.pwa-left{display:flex;align-items:center;gap:12px;min-width:0}',
            '.pwa-ic{width:44px;height:44px;border-radius:12px;flex:0 0 auto;background:#0c4a6e;',
            'display:flex;align-items:center;justify-content:center;overflow:hidden}',
            '.pwa-ic img{width:100%;height:100%;object-fit:cover}',
            '.pwa-txt{min-width:0}',
            '.pwa-title{display:block;font-size:14.5px;font-weight:700;line-height:1.2}',
            '.pwa-sub{display:block;font-size:11.5px;opacity:.72;margin-top:2px}',
            '.pwa-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
            '.pwa-btn{background:#38bdf8;color:#08131f;border:none;padding:9px 16px;border-radius:22px;',
            'font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:filter .15s}',
            '.pwa-btn:active{filter:brightness(.9)}',
            '.pwa-x{background:transparent;border:none;color:#fff;opacity:.55;font-size:20px;line-height:1;cursor:pointer;padding:4px}',
            '.pwa-ios-steps{margin-top:12px;font-size:12.5px;line-height:1.6;opacity:.9}',
            '.pwa-ios-steps b{color:#38bdf8}'
        ].join('');
        document.head.appendChild(css);
    }

    function iconMarkup() {
        // Icône relative à la racine du scope PWA
        var base = '';
        try {
            var src = (PWA_SELF && PWA_SELF.src) ? PWA_SELF.src : '';
            if (src) base = src.replace(/pwa\.js(\?.*)?$/, '');
        } catch (_) {}
        return '<div class="pwa-ic"><img src="' + base + 'icons/icon-192.png" alt="Satigué Eau" onerror="this.parentNode.textContent=\'💧\'"></div>';
    }

    function whenBody(fn) {
        if (document.body) fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    // ────────────────────────────────────────────────
    // 2 & 3. BANNIÈRE D'INSTALLATION
    // ────────────────────────────────────────────────
    var isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;

    if (!isStandalone) {
        injectStyles();
        var deferredPrompt = null;
        var DISMISS_KEY = 'pwa_install_dismissed_at';

        function recentlyDismissed() {
            try {
                var t = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
                // Ne pas re-proposer avant 7 jours
                return t && (Date.now() - t) < 7 * 24 * 3600 * 1000;
            } catch (_) { return false; }
        }
        function markDismissed() {
            try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
        }

        function removeBanner() {
            var b = document.getElementById('pwa-install-banner');
            if (b) b.remove();
        }

        function showAndroidBanner() {
            if (document.getElementById('pwa-install-banner') || recentlyDismissed()) return;
            whenBody(function () {
                var b = document.createElement('div');
                b.id = 'pwa-install-banner';
                b.className = 'pwa-card';
                b.innerHTML =
                    '<div class="pwa-row">' +
                        '<div class="pwa-left">' + iconMarkup() +
                            '<div class="pwa-txt">' +
                                '<span class="pwa-title">Installer Satigué Eau</span>' +
                                '<span class="pwa-sub">Accès rapide depuis l\'écran d\'accueil</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="pwa-actions">' +
                            '<button class="pwa-btn" id="pwa-install-btn">Installer</button>' +
                            '<button class="pwa-x" id="pwa-close-btn" aria-label="Fermer">&times;</button>' +
                        '</div>' +
                    '</div>';
                document.body.appendChild(b);

                document.getElementById('pwa-install-btn').addEventListener('click', function () {
                    if (!deferredPrompt) return;
                    deferredPrompt.prompt();
                    deferredPrompt.userChoice.then(function (r) {
                        if (r && r.outcome === 'accepted') console.log('[PWA] Installée');
                        deferredPrompt = null;
                        removeBanner();
                    });
                });
                document.getElementById('pwa-close-btn').addEventListener('click', function () {
                    markDismissed();
                    removeBanner();
                });
            });
        }

        function showIosBanner() {
            if (document.getElementById('pwa-install-banner') || recentlyDismissed()) return;
            whenBody(function () {
                var b = document.createElement('div');
                b.id = 'pwa-install-banner';
                b.className = 'pwa-card';
                b.innerHTML =
                    '<div class="pwa-row">' +
                        '<div class="pwa-left">' + iconMarkup() +
                            '<div class="pwa-txt">' +
                                '<span class="pwa-title">Installer Satigué Eau</span>' +
                                '<span class="pwa-sub">Ajoutez l\'app à votre écran d\'accueil</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="pwa-actions">' +
                            '<button class="pwa-x" id="pwa-close-btn" aria-label="Fermer">&times;</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="pwa-ios-steps">' +
                        '1. Touchez <b>Partager</b> &#x2191; en bas de Safari<br>' +
                        '2. Choisissez <b>Sur l\'écran d\'accueil</b>' +
                    '</div>';
                document.body.appendChild(b);
                document.getElementById('pwa-close-btn').addEventListener('click', function () {
                    markDismissed();
                    removeBanner();
                });
            });
        }

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            deferredPrompt = e;
            showAndroidBanner();
        });
        window.addEventListener('appinstalled', function () {
            removeBanner();
            deferredPrompt = null;
        });

        // iOS : pas de beforeinstallprompt → détecter Safari iOS et proposer les instructions
        var ua = window.navigator.userAgent || '';
        var isIOS = /iphone|ipad|ipod/i.test(ua);
        var isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
        if (isIOS && isSafari) {
            // léger délai pour ne pas gêner le chargement
            setTimeout(showIosBanner, 2500);
        }
    }

    // ────────────────────────────────────────────────
    // 4. TOAST DE MISE À JOUR
    // ────────────────────────────────────────────────
    function showUpdateToast(reg) {
        injectStyles();
        if (document.getElementById('pwa-update-banner')) return;
        whenBody(function () {
            var b = document.createElement('div');
            b.id = 'pwa-update-banner';
            b.className = 'pwa-card';
            b.innerHTML =
                '<div class="pwa-row">' +
                    '<div class="pwa-left">' + iconMarkup() +
                        '<div class="pwa-txt">' +
                            '<span class="pwa-title">Mise à jour disponible</span>' +
                            '<span class="pwa-sub">Une nouvelle version de Satigué Eau est prête</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="pwa-actions">' +
                        '<button class="pwa-btn" id="pwa-update-btn">Actualiser</button>' +
                        '<button class="pwa-x" id="pwa-update-close" aria-label="Fermer">&times;</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(b);
            document.getElementById('pwa-update-btn').addEventListener('click', function () {
                if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                b.remove();
            });
            document.getElementById('pwa-update-close').addEventListener('click', function () { b.remove(); });
        });
    }
})();
