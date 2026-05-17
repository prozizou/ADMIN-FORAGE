/**
 * ASUFOR - Sécurité Centralisée (Version Stable)
 */

window.logout = function() {
    localStorage.removeItem('asufor_session');
    window.location.replace('../index.html');
};

window.checkAccess = function(authorizedRoles = []) {
    if (window.location.pathname.includes('index.html')) {
        return null;
    }

    const sessionData = localStorage.getItem('asufor_session');

    if (!sessionData) {
        window.location.replace('../index.html');
        return null;
    }

    try {
        const session = JSON.parse(sessionData);
        
        if (!session || !session.role) {
            window.logout();
            return null;
        }

        if (authorizedRoles.length > 0 && !authorizedRoles.includes(session.role)) {
            alert("Accès refusé pour votre rôle.");
            window.location.replace('../home/accueil.html');
            return null;
        }

        return session;
    } catch (e) {
        console.error("Structure de session corrompue :", e);
        window.logout();
        return null;
    }
};
