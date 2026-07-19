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
 *   3. Arriérés = somme des factures courantes RECALCULÉES pour chaque cycle
 *      passé (asufor_backup) où status === "impaye", pour un même compteur
 *      identifié par (numero_compteur + zone).
 *   4. Total dû à l'instant T = facture_courante + arriere.
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

    // ─────────────────────────────────────────────────────────────
    // INDEXATION DES BACKUPS (pour recherche rapide par compteur)
    // ─────────────────────────────────────────────────────────────

    /**
     * Transforme le noeud asufor_backup en index exploitable :
     *   { cycle: "2026-06", records: { meterKey: record, ... } }, trié par cycle.
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
            Object.keys(donnees).forEach(function (k) {
                var rec = donnees[k];
                if (rec && typeof rec === 'object') {
                    // On conserve la clé Firebase d'origine pour pouvoir écrire dessus plus tard
                    records[meterKey(rec)] = Object.assign({ __fbkey: k, __cycle: cycle }, rec);
                }
            });
            cycles.push({ cycle: cycle, records: records });
        });
        return cycles;
    }

    // ─────────────────────────────────────────────────────────────
    // 2. CUMUL DES ARRIÉRÉS
    // ─────────────────────────────────────────────────────────────

    /**
     * Calcule l'arriéré cumulé d'un compteur en RECALCULANT la facture de chaque
     * cycle passé impayé (option validée : on ne fait jamais confiance à un montant stocké).
     *
     * @param {object} record          - noeud usager courant (base active).
     * @param {Array}  indexedBackups  - sortie de indexBackups().
     * @param {object} [opts]
     * @param {string} [opts.beforeCycle] - ne considérer que les cycles STRICTEMENT
     *                                       antérieurs à celui-ci (ex: "2026-07").
     *                                       Par défaut : tous les cycles du backup.
     * @returns {{
     *   arriere: number,               // somme des impayés passés (>= 0)
     *   details: Array,                // [{cycle, montant, conso, anomalie, raison}]
     *   anomalies: Array               // cycles exclus pour anomalie
     * }}
     */
    function computeArrears(record, indexedBackups, opts) {
        opts = opts || {};
        var mk = meterKey(record);
        var arriere = 0;
        var details = [];
        var anomalies = [];

        for (var i = 0; i < indexedBackups.length; i++) {
            var entry = indexedBackups[i];
            if (opts.beforeCycle && !(entry.cycle < opts.beforeCycle)) continue;

            var old = entry.records[mk];
            if (!old) continue;                 // compteur absent de ce cycle
            if (isPaid(old)) continue;          // cycle réglé → pas d'arriéré

            // Impayé : on RECALCULE la facture de ce cycle
            var calc = computeCurrent(old);
            if (calc.anomalie) {
                // Anomalie → exclu du cumul, mais signalé
                anomalies.push({ cycle: entry.cycle, raison: calc.raison, fbkey: old.__fbkey });
                details.push({
                    cycle: entry.cycle, montant: 0, conso: 0,
                    anomalie: true, raison: calc.raison, fbkey: old.__fbkey
                });
                continue;
            }

            arriere += calc.montant;
            details.push({
                cycle: entry.cycle, montant: calc.montant, conso: calc.conso,
                anomalie: false, raison: null, fbkey: old.__fbkey
            });
        }

        return { arriere: arriere, details: details, anomalies: anomalies };
    }

    // ─────────────────────────────────────────────────────────────
    // BILAN COMPLET D'UN USAGER (courant + arriérés + total)
    // ─────────────────────────────────────────────────────────────

    /**
     * Vue comptable complète d'un compteur à l'instant T.
     *
     * @returns {{
     *   facture_courante:number, arriere:number, total:number,
     *   conso:number, facteur:number,
     *   anomalie:boolean, raison:string|null,   // anomalie du mois COURANT
     *   arrearsDetails:Array, arrearsAnomalies:Array
     * }}
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
    // 3. RÉGULARISATION (PAIEMENT) — génération des updates Firebase
    // ─────────────────────────────────────────────────────────────

    /**
     * Prépare (sans écrire) l'objet d'updates multi-chemins pour régulariser
     * un paiement : nettoyage de la base active + de tous les cycles impayés
     * de l'historique.
     *
     * L'appelant applique ensuite : update(ref(db), updates).
     *
     * @param {object} params
     * @param {string} params.activePath   - ex: "asufor_db_diandioly".
     * @param {string} params.activeKey    - clé Firebase du noeud dans la base active.
     * @param {object} params.record       - noeud usager courant.
     * @param {Array}  params.indexedBackups - sortie de indexBackups().
     * @param {string} [params.paidBy]     - auteur (audit).
     * @param {string} [params.timestamp]  - ISO ; défaut : maintenant.
     * @param {string} [params.backupPath] - chemin du noeud d'archives (défaut: 'asufor_backup').
     *                                        Multi-forage : passer forages/{key}/backup.
     * @returns {{updates:object, cyclesRegularises:Array}}
     */
    function buildPaymentUpdates(params) {
        var activePath = params.activePath;
        var activeKey = params.activeKey;
        var record = params.record;
        var indexedBackups = params.indexedBackups || [];
        var paidBy = params.paidBy || 'système';
        var ts = params.timestamp || new Date().toISOString();
        // ✅ Multi-forage : chemin du noeud d'archives paramétrable (défaut = chemin
        //    historique mono-forage, donc 100 % rétro-compatible).
        var backupPath = params.backupPath || 'asufor_backup';

        var updates = {};
        var cyclesRegularises = [];

        // a) Base active : status → paye, arriere → 0, traçabilité
        var basePrefix = activePath + '/' + activeKey;
        updates[basePrefix + '/status'] = 'paye';
        updates[basePrefix + '/statut'] = true;
        updates[basePrefix + '/arriere'] = 0;
        updates[basePrefix + '/date_paiement'] = ts;
        updates[basePrefix + '/last_modified_by'] = paidBy;
        updates[basePrefix + '/last_modified_at'] = ts;

        // b) Historique : chaque cycle impayé de CE compteur → paye + date_paiement
        var mk = meterKey(record);
        for (var i = 0; i < indexedBackups.length; i++) {
            var entry = indexedBackups[i];
            var old = entry.records[mk];
            if (!old) continue;
            if (isPaid(old)) continue;

            var oldPrefix = backupPath + '/' + entry.cycle + '/donnees/' + old.__fbkey;
            updates[oldPrefix + '/status'] = 'paye';
            updates[oldPrefix + '/statut'] = true;
            updates[oldPrefix + '/date_paiement'] = ts;
            updates[oldPrefix + '/last_modified_by'] = paidBy;
            updates[oldPrefix + '/last_modified_at'] = ts;
            cyclesRegularises.push(entry.cycle);
        }

        return { updates: updates, cyclesRegularises: cyclesRegularises };
    }

    /**
     * Prépare les updates pour RÉVOQUER un paiement (repasser en impayé).
     * Ne touche QUE la base active (l'historique reste tel quel, la révocation
     * est une correction de saisie du mois courant).
     */
    function buildRevokeUpdates(params) {
        var basePrefix = params.activePath + '/' + params.activeKey;
        var ts = params.timestamp || new Date().toISOString();
        var updates = {};
        updates[basePrefix + '/status'] = 'impaye';
        updates[basePrefix + '/statut'] = false;
        updates[basePrefix + '/date_paiement'] = null;
        updates[basePrefix + '/last_modified_by'] = params.paidBy || 'système';
        updates[basePrefix + '/last_modified_at'] = ts;
        return { updates: updates };
    }

    // ─────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────
    return {
        FACTEUR_DEFAUT: FACTEUR_DEFAUT,
        // conversions
        toInt: toInt,
        norm: norm,
        meterKey: meterKey,
        isPaid: isPaid,
        // calculs
        computeCurrent: computeCurrent,
        indexBackups: indexBackups,
        computeArrears: computeArrears,
        computeStatement: computeStatement,
        // paiement
        buildPaymentUpdates: buildPaymentUpdates,
        buildRevokeUpdates: buildRevokeUpdates
    };
});
