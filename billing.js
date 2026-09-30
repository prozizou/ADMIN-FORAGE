/**
 * billing.js — Moteur de facturation ASUFOR (source unique de vérité)
 * =====================================================================
 *
 * Centralise TOUTE la logique de calcul pour éviter les divergences entre
 * impression.html, stats.js et les scripts de migration.
 *
 * Règles métier (validées sur données réelles) :
 *   1. Facture courante = (new_index - last_index) * facteur
 *      • Les valeurs Firebase sont souvent des STRINGS → conversion obligatoire.
 *   2. Anomalie si new_index < last_index (ou indices invalides/manquants) :
 *      → la facture n'est PAS calculée, montant = 0, drapeau `anomalie` levé.
 *      → un tel mois est EXCLU du cumul des arriérés.
 *   3. HISTORIQUE (avant la comptabilité v7) : arriérés reconstitués depuis les
 *      archives = somme des factures recalculées de tous les cycles archivés
 *      impayés (payés et anomalies exclus). Sert UNIQUEMENT à la migration
 *      (compta.js → factures « migration_backup ») et à l'affichage des mois
 *      antérieurs à la migration. Après migration, la source de vérité est le
 *      grand livre (factures / paiements / affectations / ajustements, compta.js).
 *   4. Consommation inhabituelle (> 100 m³) : facturée normalement, signalée.
 *
 *   ⚠️ Aucun champ historique (apaid, arriere, arrieres, facture, print, diff)
 *      n'est écrit par ce module.
 *
 * Double usage :
 *   • Navigateur : <script src="../billing.js"></script> → window.Billing
 *   • Node.js    : const Billing = require('./billing.js')
 *
 * Aucune dépendance externe.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;            // Node.js
    }
    if (root) {
        root.Billing = api;              // Navigateur (window.Billing)
    }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    var FACTEUR_DEFAUT = 250;

    // Consommation « inhabituelle » (fuite possible) : au-delà de ce volume (m³) sur un mois.
    // Elle reste FACTURÉE normalement (ce n'est pas une anomalie de relevé) mais elle est signalée.
    var CONSO_INHABITUELLE_M3 = 100;

    // ─────────────────────────────────────────────────────────────
    // OUTILS DE CONVERSION (Firebase mélange String et Number)
    // ─────────────────────────────────────────────────────────────

    /**
     * Convertit une valeur Firebase en entier fiable.
     * Gère "5064", 5064, " 250 ", null, undefined, "".
     * @returns {number|null} l'entier, ou null si non convertible.
     */
    function toInt(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
        var s = String(value).trim();
        if (s === '') return null;
        var n = Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    /** Normalise une chaîne pour comparaison (compteur, zone) : trim + minuscules. */
    function norm(value) {
        return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    }

    /** Clé d'identité d'un compteur : numero_compteur + zone (les numéros ne sont uniques QUE par zone). */
    function meterKey(record) {
        return norm(record && record.numero_compteur) + '|' + norm(record && record.zone);
    }

    /** Statut "payé" tolérant (status="paye" OU statut boolean true OU "true"). */
    function isPaid(record) {
        if (!record) return false;
        if (norm(record.status) === 'paye') return true;
        if (record.statut === true) return true;
        if (norm(record.statut) === 'true') return true;
        return false;
    }

    // ─────────────────────────────────────────────────────────────
    // 1. FACTURE COURANTE + DÉTECTION D'ANOMALIE
    // ─────────────────────────────────────────────────────────────

    /**
     * Calcule la facture courante d'un relevé et détecte les anomalies.
     *
     * @param {object} record - noeud usager Firebase.
     * @returns {{
     *   montant: number,        // facture courante (0 si anomalie)
     *   conso: number,          // volume consommé (0 si anomalie)
     *   facteur: number,        // facteur appliqué
     *   anomalie: boolean,      // true si le calcul a été suspendu
     *   raison: string|null     // libellé de l'anomalie
     * }}
     */
    function computeCurrent(record) {
        var lIdx = toInt(record && record.last_index);
        var nIdx = toInt(record && record.new_index);
        var fRaw = toInt(record && record.facteur);
        var facteur = (fRaw !== null && fRaw > 0) ? fRaw : FACTEUR_DEFAUT;

        // Indices manquants / non numériques
        if (lIdx === null || nIdx === null) {
            return {
                montant: 0, conso: 0, facteur: facteur,
                anomalie: true,
                raison: 'Index manquant ou non numérique (last=' +
                        (record ? record.last_index : '?') + ', new=' +
                        (record ? record.new_index : '?') + ')'
            };
        }

        // Régression d'index : compteur non relevé, remis à zéro, ou remplacé
        if (nIdx < lIdx) {
            return {
                montant: 0, conso: 0, facteur: facteur,
                anomalie: true,
                raison: 'Index décroissant (new_index ' + nIdx + ' < last_index ' + lIdx +
                        ') — compteur non relevé, réinitialisé ou remplacé ?'
            };
        }

        var conso = nIdx - lIdx;
        return {
            montant: conso * facteur,
            conso: conso,
            facteur: facteur,
            anomalie: false,
            raison: null
        };
    }

    /**
     * Consommation inhabituelle du mois : volume réel (nouvel − ancien index) supérieur à
     * CONSO_INHABITUELLE_M3. Un index qui recule ou un relevé absent n'en est PAS un
     * (c'est une anomalie / un compteur non relevé, traités ailleurs).
     */
    function isUnusualConsumption(record) {
        var l = toNum(record && record.last_index);
        var n = toNum(record && record.new_index);
        return (n - l) > CONSO_INHABITUELLE_M3;
    }

    // ─────────────────────────────────────────────────────────────
    // INDEXATION DES BACKUPS (pour recherche rapide par compteur)
    // ─────────────────────────────────────────────────────────────

    /**
     * Transforme le noeud asufor_backup en index exploitable :
     *   { cycle: "2026-06", records: { meterKey: record, ... },
     *     byKey: { cléFirebase: record, ... } }, trié par cycle.
     *
     * `byKey` est l'identifiant fiable : la clôture copie la base active telle
     * quelle dans l'archive, donc un client garde la MÊME clé Firebase d'un
     * cycle à l'autre. `records` (numéro + zone) ne sert que de repli : deux
     * clients sans numéro ou avec le même numéro dans une zone s'y écrasent,
     * et un numéro/une zone corrigé(e) depuis ne s'y retrouve plus.
     *
     * @param {object} backupRoot - contenu de asufor_backup (Firebase).
     * @returns {Array<{cycle:string, records:object}>} cycles triés du + ancien au + récent.
     */
    function indexBackups(backupRoot) {
        var cycles = [];
        if (!backupRoot || typeof backupRoot !== 'object') return cycles;

        Object.keys(backupRoot).sort().forEach(function (cycle) {
            var node = backupRoot[cycle];
            var donnees = node && node.donnees ? node.donnees : null;
            if (!donnees) return;
            var records = {};
            var byKey = {};
            var dups = {};   // meterKey présents plusieurs fois dans ce cycle (ambigus)
            Object.keys(donnees).forEach(function (k) {
                var rec = donnees[k];
                if (rec && typeof rec === 'object') {
                    // On conserve la clé Firebase d'origine pour pouvoir écrire dessus plus tard
                    var entry = Object.assign({ __fbkey: k, __cycle: cycle }, rec);
                    var mk = meterKey(rec);
                    if (records[mk]) dups[mk] = true;
                    records[mk] = entry;
                    byKey[k] = entry;
                }
            });
            cycles.push({ cycle: cycle, records: records, byKey: byKey, dups: dups });
        });
        return cycles;
    }

    /**
     * Relevé d'un compteur dans un cycle archivé.
     *   1. par clé Firebase (identité exacte : la clôture copie la base active
     *      telle quelle, la clé d'un client est stable d'un cycle à l'autre) ;
     *   2. à défaut, par numéro + zone, MAIS seulement si le numéro est renseigné,
     *      unique dans ce cycle, et n'est pas la clé d'un autre client actuel
     *      (opts.currentKeys) — sinon on risque de donner la dette d'un client à un autre.
     */
    function findInCycle(entry, record, fbKey, currentKeys) {
        if (fbKey && entry.byKey && entry.byKey[fbKey]) return entry.byKey[fbKey];
        if (!String((record && record.numero_compteur) == null ? '' : record.numero_compteur).trim()) return null;
        var mk = meterKey(record);
        if (entry.dups && entry.dups[mk]) return null;
        var found = entry.records[mk] || null;
        if (found && currentKeys && Object.prototype.hasOwnProperty.call(currentKeys, found.__fbkey)) return null;
        return found;
    }

    /** Nombre fini (décimal, signé) ou 0. */
    function toNum(value) {
        if (value === null || value === undefined || value === '') return 0;
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    // ─────────────────────────────────────────────────────────────
    // 2. ARRIÉRÉS HISTORIQUES (archives, avant la comptabilité v7)
    // ─────────────────────────────────────────────────────────────

    /**
     * Arriéré historique d'un compteur : somme des factures RECALCULÉES des cycles
     * archivés antérieurs à opts.beforeCycle où il est impayé (payés et anomalies exclus).
     *
     * @param {object} record, {Array} indexedBackups
     * @param {object} [opts] - { beforeCycle, fbKey, currentKeys }
     * @returns {{arriere:number, details:Array, anomalies:Array}}
     */
    function computeArrears(record, indexedBackups, opts) {
        opts = opts || {};
        var details = [];
        var anomalies = [];
        var total = 0;
        for (var i = 0; i < indexedBackups.length; i++) {
            var entry = indexedBackups[i];
            if (opts.beforeCycle && !(entry.cycle < opts.beforeCycle)) continue;
            var old = findInCycle(entry, record, opts.fbKey, opts.currentKeys);
            if (!old || isPaid(old)) continue;
            var calc = computeCurrent(old);
            if (calc.anomalie) {
                anomalies.push({ cycle: entry.cycle, raison: calc.raison, fbkey: old.__fbkey });
                continue;
            }
            if (!(calc.montant > 0)) continue;
            total += calc.montant;
            details.push({ cycle: entry.cycle, montant: calc.montant, conso: calc.conso, fbkey: old.__fbkey, record: old });
        }
        return { arriere: total, details: details, anomalies: anomalies };
    }

    /**
     * Vue historique complète d'un compteur (facture du relevé + arriérés d'archives).
     * @returns {{facture_courante, arriere, total, conso, facteur, anomalie, raison, arrearsDetails, arrearsAnomalies}}
     */
    function computeStatement(record, indexedBackups, opts) {
        var cur = computeCurrent(record);
        var arr = computeArrears(record, indexedBackups || [], opts);
        return {
            facture_courante: cur.montant,
            arriere: arr.arriere,
            total: cur.montant + arr.arriere,
            conso: cur.conso,
            facteur: cur.facteur,
            anomalie: cur.anomalie,
            raison: cur.raison,
            arrearsDetails: arr.details,
            arrearsAnomalies: arr.anomalies
        };
    }

    // ─────────────────────────────────────────────────────────────
    // 3. CLÔTURE DE CYCLE — archive + remise à zéro des compteurs
    //    (les FACTURES du cycle sont ajoutées par compta.js : buildClosureOps)
    // ─────────────────────────────────────────────────────────────

    /**
     * Index à conserver : le nouveau relevé s'il est valide et >= ancien, sinon
     * l'ancien index (un compteur d'eau ne régresse jamais, jamais de retour à 0).
     */
    function indexConserve(val) {
        var lRaw = parseFloat(val && val.last_index);
        var lIdx = Number.isFinite(lRaw) ? lRaw : 0;
        var nRaw = parseFloat(val && val.new_index);
        var nIdx = (Number.isFinite(nRaw) && nRaw >= lIdx) ? nRaw : lIdx;
        return { lIdx: lIdx, nIdx: nIdx };
    }

    /**
     * Écritures de l'archive + remise à zéro de chaque compteur (multi-chemins).
     * Les règles n'autorisent la création d'une archive de cycle qu'une seule fois :
     * une seconde clôture concurrente est refusée EN ENTIER.
     *
     * @param {object} params - compteursPath, backupPath, cycleKey, data (snapshot), dateLabel
     * @returns {{updates:object, keys:Array}}
     */
    function buildClosureUpdates(params) {
        var data = params.data || {};
        var keys = Object.keys(data);
        var updates = {};

        updates[params.backupPath + '/' + params.cycleKey] = {
            info: { date_sauvegarde: params.dateLabel, total_entrees: keys.length, cycle: params.cycleKey },
            donnees: data
        };

        keys.forEach(function (key) {
            var val = data[key];
            if (!val || typeof val !== 'object') return;
            var idx = indexConserve(val);
            var p = params.compteursPath + '/' + key;
            // le NOUVEL index devient l'ANCIEN ; new_index repart à 0 (nombre, règle Firebase >= 0)
            updates[p + '/last_index'] = String(idx.nIdx);
            updates[p + '/new_index'] = 0;
            // statut d'affichage du nouveau cycle (indicatif : la vérité est dans le grand livre)
            updates[p + '/status'] = 'impaye';
            updates[p + '/statut'] = false;
            updates[p + '/last_modified_by'] = null;
            updates[p + '/last_modified_at'] = null;
            updates[p + '/date_paiement'] = null;
        });

        return { updates: updates, keys: keys };
    }

    // ─────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────
    return {
        FACTEUR_DEFAUT: FACTEUR_DEFAUT,
        CONSO_INHABITUELLE_M3: CONSO_INHABITUELLE_M3,
        // conversions
        toInt: toInt,
        toNum: toNum,
        norm: norm,
        meterKey: meterKey,
        isPaid: isPaid,
        // calculs
        computeCurrent: computeCurrent,
        isUnusualConsumption: isUnusualConsumption,
        indexBackups: indexBackups,
        findInCycle: findInCycle,
        computeArrears: computeArrears,
        computeStatement: computeStatement,
        indexConserve: indexConserve,
        // écritures
        buildClosureUpdates: buildClosureUpdates
    };
});
