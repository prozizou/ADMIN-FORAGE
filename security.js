/**
 * ASUFOR - Sécurité Centralisée (Version Robuste v3)
 *
 * CORRECTIONS v3 :
 * 1. Redirection relative correcte selon la profondeur du dossier courant
 * 2. checkAccess retourne la session proprement
 * 3. logout() supprime aussi bien 'asufor_session' que le token Firebase
 * 4. ✅ NOUVEAU : Protection contre XSS — sanitisation du rôle avant affichage
 * 5. ✅ NOUVEAU : Gestion de l'erreur si localStorage est inaccessible (mode privé strict)
 *
 * ✅ La session reste valide tant que l'utilisateur ne se déconnecte pas
 * explicitement (ou que Firebase invalide réellement le jeton, voir
 * handleFirebaseSessionLoss) : plus d'expiration arbitraire après 8h.
 */

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
    // ✅ Vue à 360° super-admin : le village choisi ne doit pas survivre à la
    // déconnexion (sinon le prochain compte connecté sur cet appareil hérite
    // silencieusement du dernier village consulté).
    safeRemoveItem('asufor_superadmin_forageKey');

    const goToIndex = () => window.location.replace(getIndexPath());

    // ✅ CORRECTION : on attend la fin réelle de la déconnexion Firebase avant
    // de naviguer — partir immédiatement (comme avant) pouvait interrompre en
    // plein vol l'écriture IndexedDB de persistance de session, la laissant
    // dans un état incohérent. Symptôme observé : après s'être déconnecté, se
    // reconnecter restait bloqué indéfiniment sur "Vérification en cours…"
    // (l'initialisation Firebase Auth de la page suivante restait accrochée à
    // cet état corrompu). Un filet de sécurité (4s) évite aussi de bloquer la
    // déconnexion elle-même si jamais signOut() ne se résolvait pas.
    if (typeof firebase !== 'undefined' && firebase.auth) {
        let done = false;
        const finish = () => { if (!done) { done = true; goToIndex(); } };
        firebase.auth().signOut().then(finish).catch(finish);
        setTimeout(finish, 4000);
    } else {
        goToIndex();
    }
};

/**
 * ✅ NOUVEAU : "Vider le cache" accessible depuis l'appli (accueil, écran de
 * connexion…). Désinscrit le service worker, purge le Cache Storage géré par
 * l'appli, ET supprime les bases IndexedDB de Firebase (persistance de
 * l'authentification) — le simple vidage du cache HTTP/Service Worker ne
 * suffit pas quand c'est cet état IndexedDB qui est corrompu (voir logout()
 * ci-dessus) : un utilisateur pouvait "vider le cache" sans que rien ne
 * change, précisément parce que le vrai problème vivait ailleurs.
 * La session locale est également purgée : une reconnexion est nécessaire
 * après ce nettoyage complet.
 *
 * @param {string} [targetPath] - Page vers laquelle recharger (par défaut :
 *        l'écran de connexion, calculé depuis la profondeur du dossier).
 */
function clearFirebaseIndexedDb() {
    const knownNames = [
        'firebaseLocalStorageDb',
        'firebase-installations-database',
        'firebase-messaging-database',
        'firebase-heartbeat-database'
    ];
    const collectNames = async () => {
        try {
            if (window.indexedDB && typeof indexedDB.databases === 'function') {
                const dbs = await indexedDB.databases();
                (dbs || []).forEach((d) => { if (d && d.name) knownNames.push(d.name); });
            }
        } catch (_) { /* indexedDB.databases() indisponible sur certains navigateurs */ }
        return Array.from(new Set(knownNames));
    };
    return collectNames().then((names) => Promise.all(names.map((name) => new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            // "blocked" (un autre onglet garde la base ouverte) : on n'attend pas
            // indéfiniment, l'utilisateur ne doit jamais rester bloqué ici.
            req.onblocked = () => resolve();
        } catch (_) { resolve(); }
    }))));
}

window.clearAppCacheAndReload = async function (targetPath) {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
        }
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if (window.indexedDB) {
            await clearFirebaseIndexedDb();
        }
    } catch (err) {
        console.warn('[ASUFOR] Vidage du cache :', err);
    } finally {
        safeRemoveItem('asufor_session');
        safeRemoveItem('asufor_superadmin_forageKey');
        // Réinitialisation complète : le verrouillage biométrique repart de zéro aussi.
        safeRemoveItem('asufor_bio_v1');
        safeRemoveItem('asufor_bio_declined');
        const dest = targetPath || getIndexPath();
        window.location.href = dest + (dest.indexOf('?') === -1 ? '?' : '&') + 'cachebust=' + Date.now();
    }
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
    safeRemoveItem('asufor_superadmin_forageKey');

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

    // ✅ Verrouillage biométrique (biometric.js, si chargé et activé sur cet appareil) : la page reste
    // masquée derrière un écran de verrouillage tant que l'utilisateur n'a pas été vérifié.
    if (window.AsuforBio && typeof window.AsuforBio.guard === 'function') {
        try { window.AsuforBio.guard(session); } catch (e) { console.warn('[ASUFOR] Verrou biométrique :', e); }
    }

    return session;
};
