/**
 * ASUFOR - Sécurité Centralisée (Version Robuste v2)
 *
 * CORRECTIONS :
 * 1. Expiration de session après 8h (évite les sessions éternelles)
 * 2. Redirection relative correcte selon la profondeur du dossier courant
 * 3. checkAccess retourne la session proprement
 * 4. logout() supprime aussi bien 'asufor_session' que le token Firebase
 */

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 heures

/**
 * Calcule le chemin relatif vers index.html depuis la page actuelle.
 * Fonctionne pour admin/ (depth 0) et admin/xxx/ (depth 1).
 */
function getIndexPath() {
    const path = window.location.pathname;
    // Compte les segments après "admin/"
    const segments = path.replace(/\/$/, '').split('/').filter(Boolean);
    // On cherche l'index du dossier "admin" dans l'URL
    const adminIdx = segments.indexOf('admin');
    const depth = adminIdx >= 0 ? segments.length - adminIdx - 1 : 0;
    return depth > 0 ? '../index.html' : 'index.html';
}

window.logout = function () {
    localStorage.removeItem('asufor_session');
    // Déconnexion Firebase si le SDK compat est chargé
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut().catch(() => {});
    }
    window.location.replace(getIndexPath());
};

window.checkAccess = function (authorizedRoles = []) {
    // Ne pas vérifier sur la page de login elle-même
    if (window.location.pathname.includes('index.html')) {
        return null;
    }

    const sessionData = localStorage.getItem('asufor_session');

    if (!sessionData) {
        window.location.replace(getIndexPath());
        return null;
    }

    let session;
    try {
        session = JSON.parse(sessionData);
    } catch (e) {
        console.error('Session corrompue :', e);
        window.logout();
        return null;
    }

    if (!session || !session.role || typeof session.role !== 'string') {
        window.logout();
        return null;
    }

    // ✅ CORRECTION : Vérification de l'expiration de session
    const now = Date.now();
    if (session.time && (now - session.time) > SESSION_DURATION_MS) {
        alert('Votre session a expiré. Veuillez vous reconnecter.');
        window.logout();
        return null;
    }

    // ✅ CORRECTION : Vérification des rôles autorisés
    if (authorizedRoles.length > 0 && !authorizedRoles.includes(session.role)) {
        alert('Accès refusé pour votre rôle.');
        const homePath = getIndexPath().replace('index.html', 'home/accueil.html');
        window.location.replace(homePath);
        return null;
    }

    return session;
};
