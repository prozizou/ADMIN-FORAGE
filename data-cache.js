/**
 * data-cache.js — Cache local partagé des données Firebase ASUFOR
 *
 * Objectif : permettre un affichage INSTANTANÉ (avant même la réponse
 * réseau) en réutilisant la dernière copie connue des données, et la
 * conserver d'une session à l'autre (localStorage, pas seulement en
 * mémoire) — voir home/accueil.html "Vider le cache" pour la purge
 * manuelle complète (service worker + IndexedDB), indépendante de ceci.
 *
 * Volontairement minimal : lecture/écriture JSON sécurisées, une clé par
 * jeu de données (ex. un chemin Firebase précis), aucune dépendance.
 *
 * API globale :
 *   AsuforCache.read(key)        → valeur désérialisée, ou null si absente/corrompue
 *   AsuforCache.write(key, val)  → sérialise et persiste (silencieux si échec, ex. quota)
 *   AsuforCache.remove(key)      → supprime l'entrée
 */
(function () {
    'use strict';

    var PREFIX = 'asufor_cache_v1:';

    function read(key) {
        try {
            var raw = localStorage.getItem(PREFIX + key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch (_) {
            // Quota dépassé ou stockage indisponible (mode privé strict) : on
            // dégrade silencieusement — l'app reste fonctionnelle sans cache.
        }
    }

    function remove(key) {
        try { localStorage.removeItem(PREFIX + key); } catch (_) {}
    }

    window.AsuforCache = { read: read, write: write, remove: remove };
})();
