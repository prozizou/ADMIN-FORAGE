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
 * Calcule le chemin relatif vers index.html (situé à la RACINE du site) depuis
 * la page actuelle.
 *
 * ✅ CORRECTION : l'ancienne version cherchait un segment « admin » dans l'URL
 *    (héritage d'un déploiement sous /admin/). Sur ce déploiement Vercel, l'app
 *    est à la racine (/home/accueil.html, /counter/list.html…), sans segment
 *    « admin » → depth calculé = 0 → retournait « index.html », qui depuis
 *    /home/ se résolvait en /home/index.html → 404 (l'erreur observée).
 *
 *    On compte désormais la profondeur réelle en DOSSIERS depuis la racine :
 *    on ignore le dernier segment quand c'est un fichier (…/xxx.html), et on
 *    remonte d'autant de « ../ ».
 */
function getIndexPath() {
    const path = window.location.pathname;          // ex : /home/accueil.html
    const endsWithSlash = /\/$/.test(path);
    const segments = path.split('/').filter(Boolean); // ex : ['home','accueil.html']
    // Si l'URL finit par '/', tous les segments sont des dossiers.
    // Sinon, le dernier segment est le fichier courant → on ne le compte pas.
    const dirDepth = endsWithSlash ? segments.length : Math.max(0, segments.length - 1);
    return dirDepth > 0 ? '../'.repeat(dirDepth) + 'index.html' : 'index.html';
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

/**
 * ✅ NOUVEAU v4 : Point unique de gestion de la perte de session Firebase.
 *
 * Avant cette correction, chaque page (stats.js, impression.html, zero.html,
 * agent.html, list.html) gérait différemment le cas "onAuthStateChanged(user=null)" :
 * certaines affichaient un message, stats.js redirigeait SILENCIEUSEMENT
 * (juste un console.error) → c'est ce qui causait l'écran d'erreur sans
 * explication visible côté utilisateur.
 *
 * Cette fonction centralise le comportement :
 * 1. Affiche toujours un message visible à l'utilisateur (pas seulement en console)
 * 2. Nettoie systématiquement la session locale (le localStorage 'asufor_session'
 *    pouvait rester valide même quand le token Firebase était perdu — c'est la
 *    désynchronisation à l'origine du bug)
 * 3. Redirige après un court délai pour laisser le temps de lire le message
 *
 * @param {string} [reason] - Message technique à logger en console (debug).
 * @param {Function} [onMessage] - Callback optionnel pour afficher le message
 *        avec l'UI de la page (ex: showToast). Si absent, utilise une alert().
 */
window.handleFirebaseSessionLoss = function (reason, onMessage) {
    console.warn('[ASUFOR] Perte de session Firebase :', reason || 'inconnue');
    safeRemoveItem('asufor_session');

    const message = "⚠️ Session expirée ou invalide. Reconnexion nécessaire.";
    if (typeof onMessage === 'function') {
        try { onMessage(message); } catch (_) { alert(message); }
    } else {
        alert(message);
    }

    setTimeout(() => {
        window.location.replace(getIndexPath());
    }, 900);
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
