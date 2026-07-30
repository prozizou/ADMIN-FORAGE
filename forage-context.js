/**
 * forage-context.js — Couche d'abstraction multi-forage (Phase 1)
 * ================================================================
 *
 * Objectif : centraliser la résolution du FORAGE courant et la construction de
 * TOUS les chemins Firebase, pour préparer le multi-forage SANS rien changer au
 * comportement actuel.
 *
 * Modèle cible (voir docs/MULTI-FORAGE.md) :
 *   • Chaque président possède une `forageKey` unique, au format `Asufor_<village>`
 *     (ex. `Asufor_diandioly`, `Asufor_ogo`) — lisible, pas de clé opaque.
 *   • Chaque utilisateur hérite de la key de son président → détermine son forage.
 *   • Les données vivent sous  Asufor/{forageKey}/{compteurs,backup,agents,depenses,config}.
 *   • Super-admin (prozizou298@gmail.com) : accès à tous les forages.
 *
 * ⚠️ mode LEGACY (scopé à Diandioly UNIQUEMENT, voir paths()) :
 *   Les données de Diandioly ont été migrées (Phase 4, scripts/migrate-multi-forage.js)
 *   vers Asufor/Asufor_diandioly/{compteurs,backup,agents,depenses} et vérifiées en
 *   console Firebase : LEGACY est donc désormais à false, Diandioly utilise le même
 *   schéma namespacé que tout autre forage. legacyPaths() reste disponible (chemins
 *   historiques encore présents en base jusqu'au retrait, §6/§8 du runbook) et peut
 *   être forcé via paths(key, { legacy: true }) si besoin ponctuel (audit, secours).
 *
 * Double usage :
 *   • Navigateur : <script src="../forage-context.js"></script> → window.ForageContext
 *   • Node.js    : const FC = require('./forage-context.js')
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api; // Node
    if (root) root.ForageContext = api;                                     // Navigateur
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    // Bascule legacy ↔ namespacé, applicable UNIQUEMENT au forage Diandioly
    // (voir paths()). Passée à false : données migrées et vérifiées (Phase 4).
    var LEGACY = false;

    // Forage par défaut tant que l'identité n'est pas encore résolue au login
    // (l'unique forage historique est Diandioly). Format Asufor_<village>,
    // cohérent avec toutes les autres forageKey (voir admin/admin.html).
    var DEFAULT_FORAGE_KEY = 'Asufor_diandioly';

    // Compte super-administrateur (accès à tous les forages).
    // ✅ CORRECTION v5 : source unique de vérité = admin-config.js (window.ASUFOR_ADMIN
    //    dans le navigateur, require en Node). Fallback conservé si le module n'est
    //    pas chargé (page qui n'inclut pas admin-config.js).
    var SUPERADMIN_EMAIL = (function () {
        try {
            if (typeof window !== 'undefined' && window.ASUFOR_ADMIN) return window.ASUFOR_ADMIN.SUPERADMIN_EMAIL;
            if (typeof module === 'object' && module.exports) return require('./admin-config.js').SUPERADMIN_EMAIL;
        } catch (_) {}
        return 'prozizou298@gmail.com';
    })();

    // Village actuellement choisi par le super-admin (vue à 360°), persisté à
    // part de la session — voir setSuperadminForageKey()/superadmin-village.js.
    var SUPERADMIN_FORAGE_STORAGE_KEY = 'asufor_superadmin_forageKey';

    /**
     * Résout la forageKey de la session courante.
     * PHASE 1 : lit une éventuelle `forageKey` déjà posée dans la session locale,
     * sinon retombe sur le forage par défaut. PHASE 3 : la key sera écrite dans la
     * session à la connexion, à partir de users/{uid}.forageKey.
     *
     * Cas super-admin : n'a pas de forageKey propre (accès à tous les forages) —
     * on lit alors le village choisi via le sélecteur (superadmin-village.js),
     * pour lui permettre de naviguer les pages existantes « comme si » il était
     * président du village sélectionné (vue à 360°).
     */
    function getForageKey() {
        try {
            var s = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('asufor_session')) || '{}');
            if (s && s.isSuperadmin) {
                var chosen = (typeof localStorage !== 'undefined' && localStorage.getItem(SUPERADMIN_FORAGE_STORAGE_KEY)) || '';
                if (chosen) return chosen;
            }
            if (s && typeof s.forageKey === 'string' && s.forageKey) return s.forageKey;
        } catch (_) {}
        return DEFAULT_FORAGE_KEY;
    }

    /** Persiste (ou efface, si key est vide) le village choisi par le super-admin. */
    function setSuperadminForageKey(key) {
        try {
            if (typeof localStorage === 'undefined') return;
            if (key) localStorage.setItem(SUPERADMIN_FORAGE_STORAGE_KEY, key);
            else localStorage.removeItem(SUPERADMIN_FORAGE_STORAGE_KEY);
        } catch (_) {}
    }

    /** Vrai si l'e-mail fourni est celui du super-admin. */
    function isSuperadmin(email) {
        return String(email || '').trim().toLowerCase() === SUPERADMIN_EMAIL;
    }

    function legacyPaths() {
        // Chemins historiques (mono-forage Diandioly). NE PAS modifier tant que la
        // migration n'a pas eu lieu : c'est là que vivent les données réelles.
        return {
            compteurs: 'asufor_db_diandioly',
            backup:    'asufor_backup',
            agents:    'db_agents',
            depenses:  'asufor_depenses',
            config:    'asufor_config'   // absent aujourd'hui → l'app retombe sur le branding par défaut
        };
    }

    function namespacedPaths(key) {
        var base = 'Asufor/' + key;
        return {
            compteurs: base + '/compteurs',
            backup:    base + '/backup',
            agents:    base + '/agents',
            depenses:  base + '/depenses',
            config:    base + '/config'
        };
    }

    /**
     * Construit les chemins Firebase du forage.
     *
     * ⚠️ LEGACY ne s'applique QU'AU forage Diandioly (key === DEFAULT_FORAGE_KEY) :
     * c'est le seul à avoir des données aux chemins historiques. Tout autre
     * forage utilise TOUJOURS Asufor/{key}/…, isolé des autres, dès sa création.
     *
     * @param {string} [forageKey] - forage ciblé (défaut : forage de la session).
     * @param {object} [opts] - { legacy?: boolean } pour forcer le mode (tests/migration).
     * @returns {{forageKey:string, compteurs:string, backup:string, agents:string, depenses:string, config:string}}
     */
    function paths(forageKey, opts) {
        var key = forageKey || getForageKey();
        var legacy = (opts && typeof opts.legacy === 'boolean') ? opts.legacy : (LEGACY && key === DEFAULT_FORAGE_KEY);
        var p = legacy ? legacyPaths() : namespacedPaths(key);
        p.forageKey = key;
        return p;
    }

    return {
        LEGACY: LEGACY,
        DEFAULT_FORAGE_KEY: DEFAULT_FORAGE_KEY,
        SUPERADMIN_EMAIL: SUPERADMIN_EMAIL,
        SUPERADMIN_FORAGE_STORAGE_KEY: SUPERADMIN_FORAGE_STORAGE_KEY,
        getForageKey: getForageKey,
        setSuperadminForageKey: setSuperadminForageKey,
        isSuperadmin: isSuperadmin,
        paths: paths
    };
});
