/**
 * admin-config.js — Configuration centralisée du super-admin ASUFOR
 * ===================================================================
 *
 * ✅ CORRECTION v5 : L'email du super-admin était codé en dur dans 18 fichiers
 *    (pages HTML, scripts JS). Ce fichier devient LA source unique de vérité
 *    côté client.
 *
 * ⚠️  IMPORTANT :
 *   - Les règles Firebase (database.rules.json) doivent rester synchronisées
 *     manuellement : elles ne peuvent pas importer ce fichier.
 *   - Pour changer de super-admin : modifier SUPERADMIN_EMAILS ci-dessous
 *     ET les occurrences dans database.rules.json, puis redéployer les deux.
 *   - À terme, la bonne pratique est de migrer vers Firebase Custom Claims
 *     (auth.token.superadmin === true) posés via l'Admin SDK / Cloud Function,
 *     ce qui supprimerait toute référence à un email dans le code.
 *
 * Double usage :
 *   • Navigateur : <script src="../admin-config.js"></script> → window.ASUFOR_ADMIN
 *   • Node.js    : const ASUFOR_ADMIN = require('./admin-config.js')
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;            // Node.js
    }
    if (root) {
        root.ASUFOR_ADMIN = api;         // Navigateur (window.ASUFOR_ADMIN)
    }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    /**
     * Liste des emails super-admin autorisés (comparaison insensible à la casse).
     * Un seul email aujourd'hui ; le tableau permet d'en ajouter sans refactoring.
     */
    var SUPERADMIN_EMAILS = [
        'prozizou298@gmail.com'
    ];

    /**
     * Vérifie si un email correspond à un super-admin.
     * @param {string} email - L'email à tester (ex: user.email de Firebase Auth)
     * @returns {boolean}
     */
    function isSuperAdmin(email) {
        if (!email || typeof email !== 'string') return false;
        var normalized = email.trim().toLowerCase();
        return SUPERADMIN_EMAILS.some(function (e) {
            return e.toLowerCase() === normalized;
        });
    }

    return {
        SUPERADMIN_EMAILS: SUPERADMIN_EMAILS,
        /** Premier email de la liste (compatibilité avec l'existant). */
        SUPERADMIN_EMAIL: SUPERADMIN_EMAILS[0],
        isSuperAdmin: isSuperAdmin
    };
});
