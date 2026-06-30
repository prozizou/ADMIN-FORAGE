/**
 * Gestionnaire PWA - ASUFOR (Version robuste v2)
 *
 * CORRECTIONS :
 * 1. Enregistrement SW avec chemin absolu depuis la racine admin/
 * 2. Vérification existence des boutons avant ajout d'écouteurs
 * 3. Pas d'erreurs si les éléments DOM ne sont pas encore prêts
 */

// 1. Enregistrement du Service Worker
// ✅ CORRECTION : on dérive le chemin du SW depuis le src de CE script (pwa.js → sw.js).
// pwa.js et sw.js étant côte à côte à la racine, ça résout correctement le bon URL
// quelle que soit la profondeur de la page (racine, /reset/, /home/, ...) ET en local.
// On capture document.currentScript de façon SYNCHRONE (il est null dans le handler 'load').
const PWA_SELF = document.currentScript;
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        let swUrl = 'sw.js';
        try {
            const src = (PWA_SELF && PWA_SELF.src) ? PWA_SELF.src : '';
            if (src) swUrl = src.replace(/pwa\.js(\?.*)?$/, 'sw.js');
        } catch (_) { /* fallback sur 'sw.js' */ }

        navigator.serviceWorker.register(swUrl)
            .then(reg => {
                console.log('[PWA] Service Worker enregistré :', reg.scope);
                reg.update();
            })
            .catch(err => console.warn('[PWA] Erreur SW :', err));
    });
}

// 2. Bannière d'installation (uniquement si pas encore installée)
(function initInstallBanner() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;

    if (isStandalone) return; // Déjà installé, rien à faire

    let deferredPrompt = null;

    // Créer la bannière
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:15px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="background:#38bdf8;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;">💧</div>
                <div>
                    <strong style="display:block;font-size:14px;color:white;">ASUFOR App</strong>
                    <span style="font-size:11px;opacity:0.7;color:white;">Installer sur l'écran d'accueil</span>
                </div>
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
                <button id="pwa-install-btn" style="background:#38bdf8;color:#1a1e21;border:none;padding:8px 15px;border-radius:20px;font-weight:bold;cursor:pointer;font-size:12px;">Installer</button>
                <button id="pwa-close-btn" style="background:transparent;border:none;color:white;opacity:0.5;font-size:20px;cursor:pointer;line-height:1;">✕</button>
            </div>
        </div>
    `;

    Object.assign(banner.style, {
        position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: '400px',
        background: 'rgba(25, 30, 36, 0.9)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px', padding: '15px',
        zIndex: '9999', display: 'none',
        boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
        fontFamily: 'system-ui, sans-serif'
    });

    // Attendre que le DOM soit prêt pour ajouter la bannière
    function appendBanner() {
        document.body.appendChild(banner);

        const installBtn = document.getElementById('pwa-install-btn');
        const closeBtn = document.getElementById('pwa-close-btn');

        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    console.log('[PWA] App installée');
                }
                deferredPrompt = null;
                banner.style.display = 'none';
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                banner.style.display = 'none';
            });
        }
    }

    if (document.body) {
        appendBanner();
    } else {
        document.addEventListener('DOMContentLoaded', appendBanner);
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        banner.style.display = 'block';
    });

    window.addEventListener('appinstalled', () => {
        banner.style.display = 'none';
        deferredPrompt = null;
    });
})();
