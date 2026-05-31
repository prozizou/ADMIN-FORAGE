/**
 * Gestionnaire PWA - Installation de l'application ASUFOR
 */

// 1. Enregistrement du Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.log('Erreur SW:', err));
    });
}

// 2. Logique de la bannière d'installation
let deferredPrompt;

// Vérifier si l'app est déjà installée (en mode autonome)
const isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (!isInstalled) {
    // Création de la bannière (masquée par défaut)
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 15px;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <div style="background: #38bdf8; width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px;">💧</div>
                <div>
                    <strong style="display: block; font-size: 14px; color: white;">ASUFOR App</strong>
                    <span style="font-size: 11px; opacity: 0.7; color: white;">Installer sur l'écran d'accueil</span>
                </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button id="pwa-install-btn" style="background: #38bdf8; color: #1a1e21; border: none; padding: 8px 15px; border-radius: 20px; font-weight: bold; cursor: pointer; font-size: 12px;">Installer</button>
                <button id="pwa-close-btn" style="background: transparent; border: none; color: white; opacity: 0.5; font-size: 16px; cursor: pointer;">✕</button>
            </div>
        </div>
    `;

    // Style Glassmorphism pour la bannière
    Object.assign(banner.style, {
        position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: '400px', background: 'rgba(25, 30, 36, 0.85)',
        backdropFilter: 'blur(10px)', border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '16px', padding: '15px', zIndex: '9999', display: 'none',
        boxShadow: '0 10px 25px rgba(0,0,0,0.5)', fontFamily: 'system-ui, sans-serif'
    });

    document.body.appendChild(banner);

    // Écouteur pour déclencher l'affichage de la bannière
    window.addEventListener('beforeinstallprompt', (e) => {
        // Empêcher l'affichage de la bannière par défaut de Google Chrome
        e.preventDefault();
        // Sauvegarder l'événement pour le déclencher au clic
        deferredPrompt = e;
        // Afficher notre jolie bannière
        banner.style.display = 'block';
    });

    // Action du bouton "Installer"
    document.getElementById('pwa-install-btn').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                console.log('App installée avec succès');
                banner.style.display = 'none'; // Masquer la bannière
            }
            deferredPrompt = null;
        }
    });

    // Action du bouton "Fermer" (X)
    document.getElementById('pwa-close-btn').addEventListener('click', () => {
        banner.style.display = 'none';
    });

    // Si l'utilisateur l'installe via le menu du navigateur
    window.addEventListener('appinstalled', () => {
        banner.style.display = 'none';
        deferredPrompt = null;
    });
}

