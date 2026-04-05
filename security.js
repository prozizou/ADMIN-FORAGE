/**
 * ASUFOR - Sécurité Centralisée (Version Stable)
 */

window.logout = function() {
    localStorage.removeItem('asufor_session');
    window.location.replace('index.html');
};

window.checkAccess = function(authorizedRoles = []) {
    // 1. NE RIEN FAIRE si on est déjà sur la page de connexion
    // Cela évite que la page se fige ou boucle à l'infini
    if (window.location.pathname.includes('index.html')) {
        return null;
    }

    const sessionData = localStorage.getItem('asufor_session');

    // 2. Si aucune session, redirection vers le login
    if (!sessionData) {
        window.location.replace('index.html');
        return null;
    }

    try {
        const session = JSON.parse(sessionData);
        
        // 3. Vérification de la validité de l'objet session
        if (!session || !session.role) {
            window.logout();
            return null;
        }

        // 4. Vérification des droits (si des rôles sont spécifiés)
        if (authorizedRoles.length > 0 && !authorizedRoles.includes(session.role)) {
            alert("Accès refusé pour votre rôle.");
            window.location.replace('accueil.html');
            return null;
        }

        return session;
    } catch (e) {
        window.logout();
        return null;
    }
};
