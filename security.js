/**
 * ASUFOR - Sécurité Centralisée (Version Robuste v3)
 *
 * CORRECTIONS v3 :
 * 1. Expiration de session après 8h (évite les sessions éternelles)
 * 2. Redirection relative correcte selon la profondeur du dossier courant
 * 3. checkAccess retourne la session proprement
 * 4. logout() supprime aussi bien 'asufor_session' que le token Firebase
 * 5. ✅ NOUVEAU : Vérification que session.time existe avant calcul d'expiration
 * 6. ✅ NOUVEAU : Protection contre XSS — sanitisation du rôle avant affichage
 * 7. ✅ NOUVEAU : Gestion de l'erreur si localStorage est inaccessible (mode privé strict)
 */

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 heures

/**
 * Sanitise un texte pour éviter toute injection HTML.
 */
function sanitizeText(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

/**
 * ✅ NOUVEAU : Échappement HTML partagé, exposé globalement.
 * À utiliser pour TOUTE valeur dynamique injectée dans innerHTML
 * (noms de propriétaires, numéros de compteur, zones, etc.).
 * Couvre & < > " ' pour neutraliser le XSS stocké.
 */
window.escHtml = function (str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

/**
 * Calcule le chemin relatif vers index.html depuis la page actuelle.
 * Fonctionne pour admin/ (depth 0) et admin/xxx/ (depth 1).
 */
function getIndexPath() {
    const path = window.location.pathname;
    const segments = path.replace(/\/$/, '').split('/').filter(Boolean);
    const adminIdx = segments.indexOf('admin');
    const depth = adminIdx >= 0 ? segments.length - adminIdx - 1 : 0;
    return depth > 0 ? '../index.html' : 'index.html';
}

/**
 * Lecture sécurisée de localStorage (résiste au mode privé strict).
 */
function safeGetItem(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('[ASUFOR] localStorage inaccessible :', e);
        return null;
    }
}

/**
 * Écriture sécurisée de localStorage.
 */
function safeRemoveItem(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.warn('[ASUFOR] Impossible de supprimer la clé localStorage :', key);
    }
}

window.logout = function () {
    safeRemoveItem('asufor_session');
    // Déconnexion Firebase si le SDK compat est chargé
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut().catch(() => {});
    }
    window.location.replace(getIndexPath());
};

window.checkAccess = function (authorizedRoles = []) {
    // Ne pas vérifier sur la page de login elle-même
    if (window.location.pathname.includes('index.html') ||
        window.location.pathname.endsWith('/')) {
        return null;
    }

    const sessionData = safeGetItem('asufor_session');

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

    // ✅ CORRECTION : Validation stricte des champs de la session
    if (!session ||
        typeof session.role !== 'string' ||
        session.role.trim() === '' ||
        typeof session.time !== 'number') {
        window.logout();
        return null;
    }

    // ✅ CORRECTION : Vérification robuste de l'expiration
    const now = Date.now();
    if ((now - session.time) > SESSION_DURATION_MS) {
        alert('Votre session a expiré. Veuillez vous reconnecter.');
        window.logout();
        return null;
    }

    // ✅ CORRECTION : Validation des rôles
    const validRoles = ['président', 'secrétaire', 'trésorier'];
    if (!validRoles.includes(session.role)) {
        window.logout();
        return null;
    }

    if (authorizedRoles.length > 0 && !authorizedRoles.includes(session.role)) {
        alert('Accès refusé pour votre rôle.');
        const homePath = getIndexPath().replace('index.html', 'home/accueil.html');
        window.location.replace(homePath);
        return null;
    }

    return session;
};
