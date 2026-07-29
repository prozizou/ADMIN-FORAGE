/**
 * forage-context.js — Couche d'abstraction multi-forage (Phase 1)
 * ================================================================
 *
 * Objectif : centraliser la résolution du FORAGE courant et la construction de
 * TOUS les chemins Firebase, pour préparer le multi-forage SANS rien changer au
 * comportement actuel.
 *
 * Modèle cible (voir docs/MULTI-FORAGE.md) :
 *   • Chaque président possède une `forageKey` unique (invisible pour lui).
 *   • Chaque utilisateur hérite de la key de son président → détermine son forage.
 *   • Les données vivent sous  forages/{forageKey}/{compteurs,backup,agents,depenses,config}.
 *   • Super-admin (prozizou298@gmail.com) : accès à tous les forages.
 *
 * ⚠️ PHASE 1 — mode LEGACY (scopé à Diandioly UNIQUEMENT, voir paths()) :
 *   Les données de Diandioly sont ENCORE aux chemins historiques (asufor_db_diandioly,
 *   asufor_backup, db_agents, asufor_depenses) : c'est le SEUL forage qui utilise
 *   legacyPaths(), tant que sa migration (Phase 4) n'a pas eu lieu. Tout AUTRE
 *   forage (créé via admin/admin.html après la mise en place du multi-forage) n'a
 *   jamais eu de données aux chemins historiques : il utilise TOUJOURS
 *   forages/{forageKey}/… dès sa création, même si LEGACY reste à true pour
 *   Diandioly. Sans cette distinction, un président d'un AUTRE forage se
 *   retrouvait à lire/écrire les données de Diandioly (bug constaté en prod).
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
    // (voir paths()). Reste à true tant que sa migration n'a pas eu lieu.
    // Passera à false une fois les données de Diandioly migrées (Phase 4).
    var LEGACY = true;

    // Forage par défaut tant que l'identité n'est pas encore résolue au login
    // (l'unique forage existant est Diandioly).
    var DEFAULT_FORAGE_KEY = 'diandioly';

    // Compte super-administrateur (accès à tous les forages).
    var SUPERADMIN_EMAIL = 'prozizou298@gmail.com';

    /**
     * Résout la forageKey de la session courante.
     * PHASE 1 : lit une éventuelle `forageKey` déjà posée dans la session locale,
     * sinon retombe sur le forage par défaut. PHASE 3 : la key sera écrite dans la
     * session à la connexion, à partir de users/{uid}.forageKey.
     */
    function getForageKey() {
        try {
            var s = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('asufor_session')) || '{}');
            if (s && typeof s.forageKey === 'string' && s.forageKey) return s.forageKey;
        } catch (_) {}
        return DEFAULT_FORAGE_KEY;
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
        var base = 'forages/' + key;
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
     * forage utilise TOUJOURS forages/{key}/…, isolé des autres, dès sa création.
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
        getForageKey: getForageKey,
        isSuperadmin: isSuperadmin,
        paths: paths
    };
});
