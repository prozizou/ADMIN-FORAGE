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
 *   3. Arriérés = CUMUL INTÉGRAL : somme des factures recalculées de TOUS les
 *      cycles archivés antérieurs où le compteur est impayé (les mois payés et
 *      les mois en anomalie sont exclus). Compteur identifié par sa clé
 *      Firebase, à défaut par numéro + zone (seulement si le numéro est
 *      renseigné, unique dans le cycle et non pris par un autre client actuel).
 *      Une correction manuelle est enregistrée sous forme d'AJUSTEMENT
 *      (arrieres_ajustement, en FCFA, signé) ajouté au cumul : elle survit au
 *      rechargement, à la clôture (l'archive la conserve) et sert à tous les écrans.
 *   4. Total dû à l'instant T = facture_courante + arriere.
 *   5. Régulariser un paiement solde le mois courant ET tous les cycles impayés
 *      (hors anomalies), et mémorise ce qui a été réglé (arrieres_regles,
 *      cycles_regles) : le total « encaissé » compte donc les arriérés réglés,
 *      et corriger le paiement remet exactement ces cycles à impayé.
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

    // ─────────────────────────────────────────────────────────────
    // AJUSTEMENT MANUEL DES ARRIÉRÉS (correction persistante)
    // ─────────────────────────────────────────────────────────────

    /** Nombre fini (décimal, signé) ou 0. */
    function toNum(value) {
        if (value === null || value === undefined || value === '') return 0;
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    /** Ajustement manuel d'arriérés enregistré sur un relevé (FCFA, signé, 0 si absent). */
    function adjustmentOf(record) {
        return toNum(record && record.arrieres_ajustement);
    }

    // ─────────────────────────────────────────────────────────────
    // 2. CUMUL DES ARRIÉRÉS
    // ─────────────────────────────────────────────────────────────

    /**
     * Arriéré cumulé d'un compteur (avant ajustement propre du relevé) : somme,
     * pour chaque cycle archivé antérieur, de la facture RECALCULÉE (jamais un
     * montant stocké) des cycles impayés, + l'éventuel ajustement enregistré
     * sur ces cycles. Payés et anomalies sont exclus.
     *
     * @param {object} record          - noeud usager courant.
     * @param {Array}  indexedBackups  - sortie de indexBackups().
     * @param {object} [opts]
     * @param {string} [opts.beforeCycle] - cycles STRICTEMENT antérieurs à celui-ci
     *                                       (défaut : tous les cycles archivés).
     * @param {string} [opts.fbKey]       - clé Firebase du compteur (recherche exacte).
     * @param {object} [opts.currentKeys] - { clé: true } des clients du mois affiché
     *                                       (évite le repli numéro+zone sur le relevé d'un autre).
     * @returns {{
     *   arriere: number,                // cumul (>= 0)
     *   details: Array,                 // [{cycle, montant, facture, ajustement, conso, anomalie, raison, fbkey}]
     *   anomalies: Array                // cycles exclus pour anomalie
     * }}
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
            if (!old) continue;                 // compteur absent de ce cycle
            if (isPaid(old)) continue;          // cycle réglé → pas d'arriéré

            var calc = computeCurrent(old);
            if (calc.anomalie) {
                // Anomalie → exclu du cumul (et des règlements automatiques), mais signalé
                anomalies.push({ cycle: entry.cycle, raison: calc.raison, fbkey: old.__fbkey });
                details.push({
                    cycle: entry.cycle, montant: 0, facture: 0, ajustement: 0, conso: 0,
                    anomalie: true, raison: calc.raison, fbkey: old.__fbkey
                });
                continue;
            }

            var adj = adjustmentOf(old);
            total += calc.montant + adj;
            details.push({
                cycle: entry.cycle, montant: calc.montant + adj, facture: calc.montant, ajustement: adj,
                conso: calc.conso, anomalie: false, raison: null, fbkey: old.__fbkey
            });
        }

        return { arriere: Math.max(0, total), details: details, anomalies: anomalies };
    }

    // ─────────────────────────────────────────────────────────────
    // BILAN COMPLET D'UN USAGER (courant + arriérés + total)
    // ─────────────────────────────────────────────────────────────

    /**
     * Vue comptable complète d'un compteur à l'instant T.
     *
     * @returns {{
     *   facture_courante:number, arriere:number, total:number,
     *   arriere_calcule:number,  // cumul des archives, sans l'ajustement du relevé
     *   ajustement:number,       // ajustement manuel enregistré sur CE relevé
     *   conso:number, facteur:number,
     *   anomalie:boolean, raison:string|null,   // anomalie du mois COURANT
     *   arrearsDetails:Array, arrearsAnomalies:Array
     * }}
     */
    function computeStatement(record, indexedBackups, opts) {
        var cur = computeCurrent(record);
        var arr = computeArrears(record, indexedBackups || [], opts);
        var adj = adjustmentOf(record);
        var arriere = Math.max(0, arr.arriere + adj);
        return {
            facture_courante: cur.montant,
            arriere: arriere,
            arriere_calcule: arr.arriere,
            ajustement: adj,
            total: cur.montant + arriere,
            conso: cur.conso,
            facteur: cur.facteur,
            anomalie: cur.anomalie,
            raison: cur.raison,
            arrearsDetails: arr.details,
            arrearsAnomalies: arr.anomalies
        };
    }

    /**
     * Correction manuelle d'un arriéré → updates à écrire sur le relevé
     * (recordPath = base active OU archive). On enregistre l'AJUSTEMENT
     * (souhaité − cumul calculé), pas un montant figé : si le cumul change
     * ensuite (paiement d'un ancien mois…), la correction reste cohérente.
     *
     * @param {object} params
     * @param {string} params.recordPath  - ex "Asufor/k/compteurs/ID" ou ".../backup/2026-08/donnees/ID".
     * @param {object} params.record      - relevé (avec son éventuel ajustement actuel).
     * @param {number|null} params.desiredArrears - arriéré voulu ; null = annuler la correction.
     * @param {Array}  params.indexedBackups
     * @param {string} [params.beforeCycle] - cycle du relevé ("9999-99" ou absent = base active).
     * @param {string} [params.fbKey]
     * @param {object} [params.currentKeys]
     * @param {string} [params.by] @param {string} [params.timestamp]
     * @returns {{updates:object, ajustement:number, arriereCalcule:number, arriereFinal:number}}
     */
    function buildArrearsAdjustmentUpdates(params) {
        var base = computeArrears(params.record, params.indexedBackups || [], {
            beforeCycle: params.beforeCycle, fbKey: params.fbKey, currentKeys: params.currentKeys
        }).arriere;
        var ts = params.timestamp || new Date().toISOString();
        var adj = 0;
        if (params.desiredArrears !== null && params.desiredArrears !== undefined) {
            adj = Math.round(Math.max(0, toNum(params.desiredArrears)) - base);
        }
        var p = params.recordPath;
        var updates = {};
        updates[p + '/arrieres_ajustement'] = adj === 0 ? null : adj;
        updates[p + '/arrieres_ajuste_par'] = adj === 0 ? null : (params.by || 'système');
        updates[p + '/arrieres_ajuste_le'] = adj === 0 ? null : ts;
        return { updates: updates, ajustement: adj, arriereCalcule: base, arriereFinal: Math.max(0, base + adj) };
    }

    // ─────────────────────────────────────────────────────────────
    // 3. RÉGULARISATION (PAIEMENT) — génération des updates Firebase
    // ─────────────────────────────────────────────────────────────

    function stampFields(prefix, updates, status, ts, by) {
        var paid = status === 'paye';
        updates[prefix + '/status'] = status;
        updates[prefix + '/statut'] = paid;
        updates[prefix + '/date_paiement'] = paid ? ts : null;
        updates[prefix + '/last_modified_by'] = by;
        updates[prefix + '/last_modified_at'] = ts;
    }

    /**
     * Prépare (sans écrire) l'objet d'updates multi-chemins pour régulariser
     * un paiement : mois courant + TOUS les cycles archivés impayés du client
     * (les cycles en ANOMALIE sont exclus : ils n'ont pas été comptés, on ne
     * les déclare pas payés). Mémorise ce qui a été réglé (arrieres_regles,
     * cycles_regles) pour le bilan « encaissé » et pour une éventuelle correction.
     *
     * L'appelant applique ensuite : update(ref(db), updates).
     *
     * @param {object} params
     * @param {string} params.activePath   - ex: "Asufor/k/compteurs".
     * @param {string} params.activeKey    - clé Firebase du noeud dans la base active.
     * @param {object} params.record       - noeud usager courant.
     * @param {Array}  params.indexedBackups - sortie de indexBackups() (COMPLÈTE).
     * @param {object} [params.currentKeys] - { clé: true } des clients actuels (voir computeArrears).
     * @param {string} [params.paidBy]     - auteur (audit).
     * @param {string} [params.timestamp]  - ISO ; défaut : maintenant.
     * @param {string} [params.backupPath] - chemin du noeud d'archives (défaut: 'asufor_backup').
     * @returns {{updates:object, cyclesRegularises:Array, cyclesIgnores:Array, arrieresRegles:number}}
     */
    function buildPaymentUpdates(params) {
        var activePath = params.activePath;
        var activeKey = params.activeKey;
        var record = params.record;
        var indexedBackups = params.indexedBackups || [];
        var paidBy = params.paidBy || 'système';
        var ts = params.timestamp || new Date().toISOString();
        var backupPath = params.backupPath || 'asufor_backup';

        var updates = {};
        var cyclesRegularises = [];
        var cyclesIgnores = [];
        var regles = [];

        // b) Historique : chaque cycle impayé de CE compteur → paye + date_paiement
        //    (même recherche que computeArrears : on solde exactement ce qui a été compté)
        for (var i = 0; i < indexedBackups.length; i++) {
            var entry = indexedBackups[i];
            var old = findInCycle(entry, record, activeKey, params.currentKeys);
            if (!old) continue;
            if (isPaid(old)) continue;

            var calc = computeCurrent(old);
            if (calc.anomalie) {
                cyclesIgnores.push({ cycle: entry.cycle, raison: calc.raison, fbkey: old.__fbkey });
                continue;
            }
            stampFields(backupPath + '/' + entry.cycle + '/donnees/' + old.__fbkey, updates, 'paye', ts, paidBy);
            cyclesRegularises.push(entry.cycle);
            regles.push(entry.cycle + '|' + old.__fbkey);
        }

        // Ce qui est réglé = arriérés affichés (cumul + ajustement du relevé).
        var arrieresRegles = computeStatement(record, indexedBackups, {
            fbKey: activeKey, currentKeys: params.currentKeys
        }).arriere;

        // a) Base active : status → paye, arriere → 0, traçabilité + mémoire du réglé
        var basePrefix = activePath + '/' + activeKey;
        stampFields(basePrefix, updates, 'paye', ts, paidBy);
        updates[basePrefix + '/arriere'] = 0;
        updates[basePrefix + '/arrieres_regles'] = arrieresRegles;
        updates[basePrefix + '/cycles_regles'] = regles.length ? regles : null;
        var adj = adjustmentOf(record);
        updates[basePrefix + '/arrieres_ajustement_regle'] = adj === 0 ? null : adj;
        updates[basePrefix + '/arrieres_ajustement'] = null;
        updates[basePrefix + '/arrieres_ajuste_par'] = null;
        updates[basePrefix + '/arrieres_ajuste_le'] = null;

        return {
            updates: updates,
            cyclesRegularises: cyclesRegularises,
            cyclesIgnores: cyclesIgnores,
            arrieresRegles: arrieresRegles
        };
    }

    /**
     * Cycles réglés mémorisés sur un relevé : ["2026-06|clé", …] (tableau ou objet Firebase).
     */
    function settledCyclesOf(record) {
        var raw = record && record.cycles_regles;
        if (!raw) return [];
        var list = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
        return list.filter(function (x) { return typeof x === 'string' && x.indexOf('|') > 0; })
            .map(function (x) { var j = x.indexOf('|'); return { cycle: x.slice(0, j), key: x.slice(j + 1) }; });
    }

    /**
     * Prépare les updates pour RÉVOQUER un paiement (repasser en impayé) :
     * base active + remise à impayé des cycles archivés que CE paiement avait
     * réglés (cycles_regles) et retour de l'ajustement d'arriérés d'origine.
     *
     * @param {object} params - activePath, activeKey, record, indexedBackups,
     *                          backupPath, paidBy, timestamp
     * @returns {{updates:object, cyclesRestaures:Array}}
     */
    function buildRevokeUpdates(params) {
        var basePrefix = params.activePath + '/' + params.activeKey;
        var ts = params.timestamp || new Date().toISOString();
        var by = params.paidBy || 'système';
        var backupPath = params.backupPath || 'asufor_backup';
        var record = params.record || {};
        var updates = {};
        var restaures = [];

        stampFields(basePrefix, updates, 'impaye', ts, by);
        updates[basePrefix + '/arrieres_regles'] = null;
        updates[basePrefix + '/cycles_regles'] = null;
        updates[basePrefix + '/arrieres_ajustement_regle'] = null;
        var adjAvant = toNum(record.arrieres_ajustement_regle);
        if (adjAvant !== 0) updates[basePrefix + '/arrieres_ajustement'] = adjAvant;

        var idx = params.indexedBackups || [];
        settledCyclesOf(record).forEach(function (c) {
            var entry = null;
            for (var i = 0; i < idx.length; i++) if (idx[i].cycle === c.cycle) { entry = idx[i]; break; }
            var row = entry && entry.byKey[c.key];
            if (!row || !isPaid(row)) return;   // absent ou déjà remis à impayé : rien à restaurer
            stampFields(backupPath + '/' + c.cycle + '/donnees/' + c.key, updates, 'impaye', ts, by);
            restaures.push(c.cycle);
        });

        return { updates: updates, cyclesRestaures: restaures };
    }

    /**
     * Marquer « payé » le mois ARCHIVÉ d'un client (correction depuis la
     * maintenance) règle aussi ses mois archivés plus anciens encore impayés
     * (hors anomalies) — comme le bouton Encaisser — pour que ses arriérés ne
     * disparaissent pas sans avoir été payés.
     *
     * @param {object} params - backupPath, key, uptoCycle (exclu), indexedBackups, by, timestamp
     * @returns {{updates:object, cyclesRegularises:Array, cyclesIgnores:Array}}
     */
    function buildArchiveSettleUpdates(params) {
        var ts = params.timestamp || new Date().toISOString();
        var by = params.by || 'système';
        var backupPath = params.backupPath || 'asufor_backup';
        var updates = {};
        var ok = [];
        var ignores = [];
        (params.indexedBackups || []).forEach(function (entry) {
            if (!(entry.cycle < params.uptoCycle)) return;
            var old = entry.byKey[params.key];      // même clé Firebase d'un cycle à l'autre
            if (!old || isPaid(old)) return;
            var calc = computeCurrent(old);
            if (calc.anomalie) { ignores.push({ cycle: entry.cycle, raison: calc.raison }); return; }
            stampFields(backupPath + '/' + entry.cycle + '/donnees/' + params.key, updates, 'paye', ts, by);
            ok.push(entry.cycle);
        });
        return { updates: updates, cyclesRegularises: ok, cyclesIgnores: ignores };
    }

    // ─────────────────────────────────────────────────────────────
    // BILAN (encaissé / à réclamer) — source unique pour Statistiques
    // ─────────────────────────────────────────────────────────────

    /**
     * @param {Array<{record:object, statement:object}>} items - relevés et leur computeStatement().
     * @returns {{paye:number, impaye:number, arrieresRegles:number, nbPaye:number, nbImpaye:number}}
     *   paye   = factures du mois payées + arriérés réglés avec elles (arrieres_regles)
     *   impaye = totaux dus (mois + arriérés) des relevés non payés
     */
    function summarizeRecap(items) {
        var r = { paye: 0, impaye: 0, arrieresRegles: 0, nbPaye: 0, nbImpaye: 0 };
        (items || []).forEach(function (it) {
            var st = it.statement;
            if (!st || isNaN(st.total)) return;
            if (isPaid(it.record)) {
                var reg = Math.max(0, toNum(it.record && it.record.arrieres_regles));
                r.paye += st.facture_courante + reg;
                r.arrieresRegles += reg;
                r.nbPaye++;
            } else {
                r.impaye += st.total;
                r.nbImpaye++;
            }
        });
        return r;
    }

    /**
     * Lignes d'archive impayées (cycles antérieurs à beforeCycle) qu'AUCUN
     * relevé actuel ne reprend : dette qui n'apparaît sur aucune facture.
     *
     * @param {Array} indexedBackups
     * @param {object} opts - { beforeCycle, claimed } ; claimed = { "cycle|clé": true }
     *        (lignes reprises par un compteur actuel, via computeArrears().details).
     * @returns {{rows:Array<{cycle,fbKey,nom,montant}>, total:number}}
     */
    function findOrphanArrears(indexedBackups, opts) {
        opts = opts || {};
        var claimed = opts.claimed || {};
        var rows = [];
        var total = 0;
        (indexedBackups || []).forEach(function (entry) {
            if (opts.beforeCycle && !(entry.cycle < opts.beforeCycle)) return;
            Object.keys(entry.byKey).forEach(function (k) {
                var rec = entry.byKey[k];
                if (isPaid(rec) || claimed[entry.cycle + '|' + k]) return;
                var calc = computeCurrent(rec);
                if (calc.anomalie) return;
                var montant = calc.montant + adjustmentOf(rec);
                if (!(montant > 0)) return;
                rows.push({ cycle: entry.cycle, fbKey: k, nom: rec.name || k, montant: montant });
                total += montant;
            });
        });
        return { rows: rows, total: total };
    }

    // ─────────────────────────────────────────────────────────────
    // 4. CLÔTURE DE CYCLE — updates atomiques (archive + remise à zéro)
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
     * Toutes les écritures de la clôture d'un cycle dans UN SEUL objet
     * multi-chemins (à appliquer par update(ref(db), updates)) : création de
     * l'archive + remise à zéro de chaque compteur. Firebase applique tout ou
     * rien ; les règles n'autorisent la création d'une archive de cycle qu'une
     * seule fois (create-only) : une seconde clôture concurrente est refusée
     * EN ENTIER, sans écraser l'archive ni réinitialiser deux fois les compteurs.
     *
     * @param {object} params
     * @param {string} params.compteursPath, params.backupPath, params.cycleKey
     * @param {object} params.data      - contenu lu de la base active (snapshot).
     * @param {string} params.dateLabel - date lisible de sauvegarde.
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
            var fRaw = parseFloat(val.facteur);
            var facteur = Number.isFinite(fRaw) ? fRaw : 250;
            var montantMois = Math.max(0, idx.nIdx - idx.lIdx) * facteur;
            var estPaye = isPaid(val);
            var aRaw = parseFloat(val.arrieres !== undefined && val.arrieres !== null ? val.arrieres : val._impaye_anterieur);
            var arrieresCourants = Number.isFinite(aRaw) ? aRaw : 0;
            var p = params.compteursPath + '/' + key;

            // le NOUVEL index devient l'ANCIEN ; new_index repart à 0 (nombre, règle Firebase >= 0)
            updates[p + '/last_index'] = String(idx.nIdx);
            updates[p + '/new_index'] = 0;
            updates[p + '/status'] = 'impaye';
            updates[p + '/statut'] = false;
            updates[p + '/apaid'] = estPaye ? 0 : (montantMois + arrieresCourants);
            updates[p + '/arrieres'] = 0;
            updates[p + '/facture'] = 'false';
            updates[p + '/print'] = 'false';
            updates[p + '/last_modified_by'] = null;
            updates[p + '/last_modified_at'] = null;
            updates[p + '/date_paiement'] = null;
            // Les mémoires de règlement / d'ajustement appartiennent au cycle qui
            // se ferme (déjà copiées dans l'archive) : le nouveau cycle repart propre.
            updates[p + '/arrieres_regles'] = null;
            updates[p + '/cycles_regles'] = null;
            updates[p + '/arrieres_ajustement'] = null;
            updates[p + '/arrieres_ajustement_regle'] = null;
            updates[p + '/arrieres_ajuste_par'] = null;
            updates[p + '/arrieres_ajuste_le'] = null;
        });

        return { updates: updates, keys: keys };
    }

    // ─────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────
    return {
        FACTEUR_DEFAUT: FACTEUR_DEFAUT,
        // conversions
        toInt: toInt,
        toNum: toNum,
        norm: norm,
        meterKey: meterKey,
        isPaid: isPaid,
        // calculs
        computeCurrent: computeCurrent,
        isUnusualConsumption: isUnusualConsumption,
        CONSO_INHABITUELLE_M3: CONSO_INHABITUELLE_M3,
        indexBackups: indexBackups,
        findInCycle: findInCycle,
        computeArrears: computeArrears,
        computeStatement: computeStatement,
        adjustmentOf: adjustmentOf,
        summarizeRecap: summarizeRecap,
        findOrphanArrears: findOrphanArrears,
        settledCyclesOf: settledCyclesOf,
        // écritures
        buildArrearsAdjustmentUpdates: buildArrearsAdjustmentUpdates,
        buildPaymentUpdates: buildPaymentUpdates,
        buildRevokeUpdates: buildRevokeUpdates,
        buildArchiveSettleUpdates: buildArchiveSettleUpdates,
        buildClosureUpdates: buildClosureUpdates,
        indexConserve: indexConserve
    };
});
