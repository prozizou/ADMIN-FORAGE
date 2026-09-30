/**
 * compta.js — Moteur comptable ADMIN-FORAGE (v7) : grand livre client
 * ====================================================================
 *
 * Source de vérité financière (sous Asufor/{forageKey}/) :
 *   factures/{factureId}                    ce que le client doit (figée à la clôture)
 *   paiements/{paiementId}                  ce qu'il a réellement payé (immuable, annulable)
 *   affectations/{paiementId}/{factureId}   répartition FIFO d'un paiement sur les factures
 *   ajustements/{ajustementId}              remise / majoration / correction / annulation (motivés, validés)
 * Dérivés (jamais source de vérité, recalculables) :
 *   soldes/{compteurId}                     cache de performance (+ verrou `rev` anti-concurrence)
 *   factures/*.montant_net|montant_paye|reste_a_payer|statut
 * Traçabilité :
 *   audit_comptable/{eventId}, migration_comptable/v1
 *
 * Règles :
 *   montant_net   = montant_initial + Σ ajustements validés (remise −, majoration +, correction ±)
 *   montant_paye  = Σ affectations valides (paiement valide, affectation non annulée)
 *   reste_a_payer = montant_net − montant_paye
 *   arriérés      = Σ reste_a_payer des factures échues (échéance = création : un cycle clôturé est dû)
 *   avance        = Σ (paiement valide − ses affectations valides)
 *   solde         = total facturé net − total payé  (= arriérés − avance)  → > 0 : dette, < 0 : crédit
 *   Chaque paiement est affecté aux factures les plus anciennes d'abord ; le surplus reste en avance
 *   et est affecté automatiquement aux factures suivantes (clôture, majoration, annulation d'un autre paiement).
 *   Anomalie d'index (nouvel < ancien, relevé manquant) : AUCUNE facture tant que le relevé n'est pas corrigé.
 *   Surconsommation (> 100 m³) : facturée normalement + bloc `probleme` (résoudre ≠ payer).
 *
 * Toutes les opérations renvoient UN objet de mises à jour multi-chemins (update(ref(db), updates)) :
 * Firebase l'applique en tout ou rien. Chaque opération incrémente soldes/{compteur}.rev ; les règles
 * exigent rev = ancien + 1, donc deux opérations simultanées sur un même client ne peuvent pas passer
 * toutes les deux avec des calculs périmés.
 *
 * Double usage : navigateur (window.Compta, après billing.js) / Node (require('./compta.js')).
 */
(function (root, factory) {
    var Billing = (typeof module === 'object' && module.exports) ? require('./billing.js') : root.Billing;
    var api = factory(Billing);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Compta = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function (Billing) {
    'use strict';

    var MODES = ['especes', 'wave', 'orange_money', 'virement', 'autre'];
    var MODES_LABEL = { especes: 'Espèces', wave: 'Wave', orange_money: 'Orange Money', virement: 'Virement', autre: 'Autre' };
    var TYPES_AJUSTEMENT = ['remise', 'majoration', 'correction', 'annulation'];
    var STATUTS_FACTURE = ['ouverte', 'partielle', 'payee', 'annulee'];
    var SEUIL_M3 = Billing.CONSO_INHABITUELLE_M3;

    // ─────────────────────────────────────────────────────────────
    // Utilitaires
    // ─────────────────────────────────────────────────────────────
    function r0(x) { var n = Math.round(Number(x) || 0); return n === 0 ? 0 : n; }   // FCFA entiers (pas de « -0 »)
    function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
    function vals(obj) { return obj ? Object.keys(obj).map(function (k) { return obj[k]; }) : []; }
    function str(x) { return x === null || x === undefined ? '' : String(x); }
    function t(iso) { var v = Date.parse(iso); return isNaN(v) ? 0 : v; }

    function emptyState() { return { factures: {}, paiements: {}, affectations: {}, ajustements: {}, soldes: {} }; }

    /** Normalise l'état lu depuis Firebase (nœuds absents → {}). */
    function normState(S) {
        S = S || {};
        return {
            factures: S.factures || {}, paiements: S.paiements || {}, affectations: S.affectations || {},
            ajustements: S.ajustements || {}, soldes: S.soldes || {}
        };
    }

    /** Chemins comptables d'un forage (base = "Asufor/{forageKey}"). */
    function pathsFor(base) {
        return {
            factures: base + '/factures', paiements: base + '/paiements', affectations: base + '/affectations',
            ajustements: base + '/ajustements', soldes: base + '/soldes', audit: base + '/audit_comptable',
            migration: base + '/migration_comptable', compteurs: base + '/compteurs', backup: base + '/backup'
        };
    }

    function factureId(cycle, compteurId) { return cycle + '_' + compteurId; }

    function isValidPayment(p) { return !!p && p.statut === 'valide'; }
    function isValidAdjustment(j) { return !!j && j.statut === 'valide'; }

    /** Montant signé d'un ajustement validé sur le montant de la facture. */
    function signedAdjustment(j) {
        var m = Number(j.montant) || 0;
        if (j.type === 'remise') return -Math.abs(m);
        if (j.type === 'majoration') return Math.abs(m);
        if (j.type === 'correction') return m;
        return 0;   // annulation : traitée à part (facture → 0, statut « annulee »)
    }

    // ─────────────────────────────────────────────────────────────
    // Facture d'un relevé
    // ─────────────────────────────────────────────────────────────
    /** Bloc « probleme » (surconsommation détectée automatiquement), ou null. */
    function detectProbleme(conso) {
        if (!(conso > SEUIL_M3)) return null;
        return {
            actif: true, type: 'surconsommation', niveau: conso > 2 * SEUIL_M3 ? 'critique' : 'alerte',
            seuil_m3: SEUIL_M3, valeur_m3: conso, detecte_automatiquement: true, resolu: false
        };
    }

    /**
     * Facture figée d'un relevé (ou raison de l'absence de facture).
     * @returns {{facture:object|null, anomalie:boolean, raison:string|null}}
     */
    function buildFacture(p) {
        var rec = p.record || {};
        var cur = Billing.computeCurrent(rec);
        if (cur.anomalie) return { facture: null, anomalie: true, raison: cur.raison };
        var montant = r0(cur.montant);
        if (!(montant > 0)) return { facture: null, anomalie: false, raison: 'Aucune consommation facturable' };
        var id = factureId(p.cycle, p.compteurId);
        var f = {
            facture_id: id,
            compteur_id: p.compteurId,
            numero_compteur: str(rec.numero_compteur),
            client: str(rec.name),
            zone: str(rec.zone),
            agent_id: str(rec.agent_id),
            cycle: p.cycle,
            ancien_index: Billing.toInt(rec.last_index),
            nouvel_index: Billing.toInt(rec.new_index),
            consommation: cur.conso,
            facteur: cur.facteur,
            montant_initial: montant,
            montant_net: montant,
            montant_paye: 0,
            reste_a_payer: montant,
            statut: 'ouverte',
            date_creation: p.now,
            date_echeance: p.dateEcheance || p.now,
            source: p.source,
            verrouillee: true,
            rev: 1
        };
        var prob = detectProbleme(cur.conso);
        if (prob) f.probleme = prob;
        return { facture: f, anomalie: false, raison: null };
    }

    // ─────────────────────────────────────────────────────────────
    // État dérivé
    // ─────────────────────────────────────────────────────────────
    /** Affectations valides d'une facture : [{paiement_id, montant, date}] (option asOf). */
    function facturePayments(S, fid, asOf) {
        var out = [];
        Object.keys(S.affectations).forEach(function (pid) {
            var a = S.affectations[pid] && S.affectations[pid][fid];
            var p = S.paiements[pid];
            if (!a || a.statut === 'annulee' || !isValidPayment(p)) return;
            if (asOf && (t(p.date_paiement) > asOf || t(a.date) > asOf)) return;
            out.push({ paiement_id: pid, montant: Number(a.montant) || 0, date: a.date, ordre: a.ordre });
        });
        return out;
    }

    /** Montant net, payé, reste et statut d'une facture, recalculés depuis le grand livre. */
    function factureState(S, f, asOf) {
        var adjs = vals(S.ajustements).filter(function (j) {
            return j.facture_id === f.facture_id && isValidAdjustment(j) && (!asOf || t(j.date_validation) <= asOf);
        });
        var annulee = adjs.some(function (j) { return j.type === 'annulation'; });
        var net = annulee ? 0 : Math.max(0, r0((Number(f.montant_initial) || 0) + adjs.reduce(function (s, j) { return s + signedAdjustment(j); }, 0)));
        var paye = r0(facturePayments(S, f.facture_id, asOf).reduce(function (s, a) { return s + a.montant; }, 0));
        var reste = Math.max(0, net - paye);
        var statut = annulee ? 'annulee' : (reste <= 0 ? 'payee' : (paye > 0 ? 'partielle' : 'ouverte'));
        return { montant_net: net, montant_paye: paye, reste_a_payer: reste, statut: statut, annulee: annulee };
    }

    /** Montant d'un paiement déjà affecté (affectations valides). */
    function paymentAllocated(S, pid, asOf) {
        var m = S.affectations[pid] || {};
        return r0(Object.keys(m).reduce(function (s, fid) {
            var a = m[fid];
            if (!a || a.statut === 'annulee') return s;
            if (asOf && t(a.date) > asOf) return s;
            return s + (Number(a.montant) || 0);
        }, 0));
    }

    function sortFactures(a, b) {
        return a.cycle < b.cycle ? -1 : a.cycle > b.cycle ? 1 : (t(a.date_creation) - t(b.date_creation)) || (a.facture_id < b.facture_id ? -1 : 1);
    }
    function sortPaiements(a, b) {
        return (t(a.date_paiement) - t(b.date_paiement)) || (t(a.created_at) - t(b.created_at)) || (a.paiement_id < b.paiement_id ? -1 : 1);
    }

    /**
     * Compte d'un client (compteur) : factures, paiements, ajustements et totaux.
     * @param {object} S - état comptable ; @param {string} cid ; @param {object} [opts] - { asOf: ms }
     */
    function computeAccount(S, cid, opts) {
        S = normState(S);
        var asOf = opts && opts.asOf;
        var factures = vals(S.factures)
            .filter(function (f) { return f.compteur_id === cid && (!asOf || t(f.date_creation) <= asOf || (opts.cycleMax && f.cycle <= opts.cycleMax)); })
            .map(function (f) { return Object.assign({}, f, factureState(S, f, asOf)); })
            .sort(sortFactures);
        var paiements = vals(S.paiements)
            .filter(function (p) { return p.compteur_id === cid && (!asOf || t(p.date_paiement) <= asOf); })
            .map(function (p) {
                var aff = isValidPayment(p) ? paymentAllocated(S, p.paiement_id, asOf) : 0;
                return Object.assign({}, p, { affecte: aff, disponible: isValidPayment(p) ? Math.max(0, r0(p.montant) - aff) : 0 });
            })
            .sort(sortPaiements);
        var ajustements = vals(S.ajustements).filter(function (j) { return j.compteur_id === cid; })
            .sort(function (a, b) { return t(a.created_at) - t(b.created_at); });

        var totalFacture = 0, totalAjust = 0, arrieres = 0, nbImpayees = 0, plusAncienne = null;
        factures.forEach(function (f) {
            if (f.annulee) return;
            totalFacture += Number(f.montant_initial) || 0;
            totalAjust += f.montant_net - (Number(f.montant_initial) || 0);
            if (f.reste_a_payer > 0) {
                arrieres += f.reste_a_payer;
                nbImpayees++;
                if (plusAncienne === null || f.cycle < plusAncienne) plusAncienne = f.cycle;
            }
        });
        var totalPaye = paiements.reduce(function (s, p) { return s + (isValidPayment(p) ? r0(p.montant) : 0); }, 0);
        var avance = paiements.reduce(function (s, p) { return s + p.disponible; }, 0);
        return {
            compteur_id: cid, factures: factures, paiements: paiements, ajustements: ajustements,
            total_facture: r0(totalFacture), total_paye: r0(totalPaye), total_ajustements: r0(totalAjust),
            solde: r0(totalFacture + totalAjust - totalPaye), arrieres: r0(arrieres), avance: r0(avance),
            plus_ancienne_dette: plusAncienne, nb_factures_impayees: nbImpayees
        };
    }

    /** Cache soldes/{cid} (sans rev ni date). */
    function soldeCache(acc) {
        return {
            total_facture: acc.total_facture, total_paye: acc.total_paye, total_ajustements: acc.total_ajustements,
            solde: acc.solde, arrieres: acc.arrieres, avance: acc.avance,
            plus_ancienne_dette: acc.plus_ancienne_dette, nb_factures_impayees: acc.nb_factures_impayees
        };
    }

    /**
     * Affectations FIFO à créer : avances disponibles (paiements les plus anciens d'abord) sur les
     * factures ouvertes (les plus anciennes d'abord).
     * @returns {Array<{paiement_id, facture_id, cycle, montant}>}
     */
    function planAllocations(S, cid) {
        var acc = computeAccount(S, cid);
        var open = acc.factures.filter(function (f) { return !f.annulee && f.reste_a_payer > 0; })
            .map(function (f) { return { f: f, reste: f.reste_a_payer }; });
        var pays = acc.paiements.filter(function (p) { return p.disponible > 0; })
            .map(function (p) { return { p: p, dispo: p.disponible }; });
        var plan = [];
        var i = 0, j = 0;
        while (i < open.length && j < pays.length) {
            var m = Math.min(open[i].reste, pays[j].dispo);
            if (m > 0) plan.push({ paiement_id: pays[j].p.paiement_id, facture_id: open[i].f.facture_id, cycle: open[i].f.cycle, montant: m });
            open[i].reste -= m; pays[j].dispo -= m;
            if (open[i].reste <= 0) i++;
            if (pays[j].dispo <= 0) j++;
        }
        return plan;
    }

    // ─────────────────────────────────────────────────────────────
    // Transactions : état de travail + émission des mises à jour
    // ─────────────────────────────────────────────────────────────
    function Tx(S, paths, now, user) {
        this.S = clone(normState(S));
        this.orig = normState(S);
        this.paths = paths;
        this.now = now;
        this.user = user || {};
        this.updates = {};
        this.touched = {};       // compteurs dont le solde doit être réécrit
        this.facturesTouched = {};
        this.audits = [];
        this.idSeq = 0;
    }
    Tx.prototype.set = function (path, value) { this.updates[path] = value; };
    Tx.prototype.touch = function (cid) { this.touched[cid] = true; };
    Tx.prototype.audit = function (newId, action, entite, entiteId, cid, details) {
        var ev = {
            action: action, entite: entite, entite_id: entiteId, compteur_id: cid || null,
            utilisateur: this.user.uid || 'inconnu', utilisateur_nom: this.user.nom || null,
            role: this.user.role || 'inconnu', date: this.now
        };
        if (details) ev.details = details;
        this.set(this.paths.audit + '/' + newId(), ev);
    };
    /** Affecte les avances disponibles de ce client (FIFO) et enregistre les affectations. */
    Tx.prototype.allocate = function (cid) {
        var self = this;
        var plan = planAllocations(this.S, cid);
        plan.forEach(function (it) {
            var byPay = self.S.affectations[it.paiement_id] = self.S.affectations[it.paiement_id] || {};
            var ex = byPay[it.facture_id];
            if (ex && ex.statut !== 'annulee') {
                ex.montant = r0(Number(ex.montant) + it.montant);
                ex.updated_at = self.now;
            } else {
                var ordre = Object.keys(byPay).length + 1;
                byPay[it.facture_id] = { facture_id: it.facture_id, cycle: it.cycle, montant: it.montant, ordre: ordre, date: self.now, statut: 'valide', compteur_id: cid };
            }
            self.set(self.paths.affectations + '/' + it.paiement_id + '/' + it.facture_id, clone(byPay[it.facture_id]));
            self.facturesTouched[it.facture_id] = true;
        });
        this.touch(cid);
        return plan;
    };
    /** Réécrit les champs dérivés des factures touchées (+ rev) et le cache des soldes. */
    Tx.prototype.finish = function () {
        var self = this;
        Object.keys(this.facturesTouched).forEach(function (fid) {
            var f = self.S.factures[fid];
            if (!f) return;
            var st = factureState(self.S, f);
            var o = self.orig.factures[fid];
            var p = self.paths.factures + '/' + fid;
            if (!o) {                              // facture créée dans cette opération
                Object.assign(f, { montant_net: st.montant_net, montant_paye: st.montant_paye, reste_a_payer: st.reste_a_payer, statut: st.statut });
                self.set(p, clone(f));
                return;
            }
            f.montant_net = st.montant_net; f.montant_paye = st.montant_paye;
            f.reste_a_payer = st.reste_a_payer; f.statut = st.statut;
            f.rev = (Number(o.rev) || 0) + 1;
            f.updated_at = self.now;
            ['montant_net', 'montant_paye', 'reste_a_payer', 'statut', 'rev', 'updated_at'].forEach(function (k) { self.set(p + '/' + k, f[k]); });
        });
        Object.keys(this.touched).forEach(function (cid) {
            var c = soldeCache(computeAccount(self.S, cid));
            var old = self.orig.soldes[cid];
            c.rev = (old && Number(old.rev) || 0) + 1;
            c.updated_at = self.now;
            self.S.soldes[cid] = c;
            self.set(self.paths.soldes + '/' + cid, c);
        });
        return this.updates;
    };

    function assert(cond, msg) { if (!cond) { var e = new Error(msg); e.metier = true; throw e; } }

    function makeIdGen(newId, prefix) {
        var n = 0;
        return newId || function () { n++; return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + n; };
    }

    /** Statut d'affichage du relevé courant (indicatif, dans compteurs) après une opération. */
    function releveStatusUpdates(tx, cid, releve) {
        if (!releve) return;
        var acc = computeAccount(tx.S, cid);
        var cur = Billing.computeCurrent(releve);
        var du = r0(acc.arrieres + (cur.anomalie ? 0 : cur.montant) - acc.avance);
        var paid = du <= 0 && (acc.total_paye > 0);
        var p = tx.paths.compteurs + '/' + cid;
        tx.set(p + '/status', paid ? 'paye' : 'impaye');
        tx.set(p + '/statut', paid);
        tx.set(p + '/date_paiement', paid ? tx.now : null);
        tx.set(p + '/last_modified_by', tx.user.role || tx.user.nom || 'inconnu');
        tx.set(p + '/last_modified_at', tx.now);
    }

    /** Somme due aujourd'hui pour un relevé en cours : arriérés + facture provisoire − avance. */
    function amountDueNow(S, cid, releve) {
        var acc = computeAccount(S, cid);
        var cur = releve ? Billing.computeCurrent(releve) : { montant: 0, anomalie: true };
        var provisoire = cur.anomalie ? 0 : r0(cur.montant);
        return {
            arrieres: acc.arrieres, avance: acc.avance, facture_provisoire: provisoire,
            total_du: Math.max(0, r0(acc.arrieres + provisoire - acc.avance)),
            credit: Math.max(0, r0(acc.avance - acc.arrieres - provisoire)),
            account: acc
        };
    }

    // ─────────────────────────────────────────────────────────────
    // OPÉRATIONS
    // ─────────────────────────────────────────────────────────────

    /**
     * Encaissement : paiement immuable + affectations FIFO + factures + soldes + audit (+ statut du relevé).
     * @param {object} S
     * @param {object} o - { paths, compteurId, montant, mode, reference, numero_recu, releve, user:{uid,nom,role}, now, newId, paiementId }
     * @returns {{updates, paiementId, affectations:Array, avance:number, apres:object}}
     */
    function buildPaymentOps(S, o) {
        var montant = r0(o.montant);
        assert(montant > 0, 'Le montant doit être supérieur à 0.');
        assert(MODES.indexOf(o.mode) !== -1, 'Mode de paiement invalide.');
        assert(str(o.numero_recu).trim().length > 0, 'Le numéro de reçu est obligatoire.');
        assert(o.compteurId, 'Compteur inconnu.');
        var newId = makeIdGen(o.newId, 'ev');
        var tx = new Tx(S, o.paths, o.now, o.user);
        var pid = o.paiementId || newId();
        var pay = {
            paiement_id: pid, compteur_id: o.compteurId, montant: montant,
            date_paiement: o.date_paiement || o.now, mode: o.mode,
            reference: str(o.reference).trim() || null, numero_recu: str(o.numero_recu).trim(),
            encaisse_par: tx.user.uid || 'inconnu', encaisse_par_nom: tx.user.nom || null, role: tx.user.role || null,
            statut: 'valide', source: o.source || 'encaissement', created_at: o.now
        };
        if (o.client) pay.client = str(o.client);
        tx.S.paiements[pid] = pay;
        tx.set(o.paths.paiements + '/' + pid, pay);
        var plan = tx.allocate(o.compteurId).filter(function (x) { return x.paiement_id === pid; });
        var dispo = montant - plan.reduce(function (s, x) { return s + x.montant; }, 0);
        tx.audit(newId, 'PAIEMENT_CREE', 'paiement', pid, o.compteurId, {
            montant: montant, mode: o.mode, numero_recu: pay.numero_recu,
            affecte: montant - dispo, avance: dispo, factures: plan.map(function (x) { return x.facture_id; })
        });
        releveStatusUpdates(tx, o.compteurId, o.releve);
        var updates = tx.finish();
        var apres = computeAccount(tx.S, o.compteurId);
        return {
            updates: updates, paiementId: pid, avance: dispo, apres: apres,
            affectations: plan.map(function (x, i) {
                var f = apres.factures.filter(function (ff) { return ff.facture_id === x.facture_id; })[0] || {};
                return { facture_id: x.facture_id, cycle: x.cycle, montant: x.montant, ordre: i + 1, reste_apres: f.reste_a_payer || 0 };
            })
        };
    }

    /**
     * Annulation (contre-écriture) d'un paiement : statut « annule » + affectations annulées, factures
     * rouvertes, puis ré-affectation FIFO des autres avances du client. Le paiement n'est jamais supprimé.
     */
    function buildPaymentCancelOps(S, o) {
        S = normState(S);
        var p = S.paiements[o.paiementId];
        assert(p, 'Paiement introuvable.');
        assert(isValidPayment(p), 'Ce paiement est déjà annulé.');
        assert(str(o.motif).trim().length > 0, "Le motif d'annulation est obligatoire.");
        var newId = makeIdGen(o.newId, 'ev');
        var tx = new Tx(S, o.paths, o.now, o.user);
        var np = tx.S.paiements[o.paiementId];
        np.statut = 'annule';
        np.annule_par = tx.user.uid || 'inconnu';
        np.annule_par_nom = tx.user.nom || null;
        np.annule_le = o.now;
        np.motif_annulation = str(o.motif).trim();
        ['statut', 'annule_par', 'annule_par_nom', 'annule_le', 'motif_annulation'].forEach(function (k) {
            tx.set(o.paths.paiements + '/' + o.paiementId + '/' + k, np[k]);
        });
        var affs = tx.S.affectations[o.paiementId] || {};
        Object.keys(affs).forEach(function (fid) {
            var a = affs[fid];
            if (a.statut === 'annulee') return;
            a.statut = 'annulee'; a.annulee_le = o.now;
            tx.set(o.paths.affectations + '/' + o.paiementId + '/' + fid + '/statut', 'annulee');
            tx.set(o.paths.affectations + '/' + o.paiementId + '/' + fid + '/annulee_le', o.now);
            tx.facturesTouched[fid] = true;
        });
        tx.allocate(p.compteur_id);
        tx.audit(newId, 'PAIEMENT_ANNULE', 'paiement', o.paiementId, p.compteur_id, { montant: r0(p.montant), motif: np.motif_annulation });
        releveStatusUpdates(tx, p.compteur_id, o.releve);
        return { updates: tx.finish(), apres: computeAccount(tx.S, p.compteur_id) };
    }

    function checkAdjustment(S, j) {
        var f = S.factures[j.facture_id];
        assert(f, 'Facture introuvable.');
        assert(f.compteur_id === j.compteur_id, 'La facture n\'appartient pas à ce compteur.');
        var st = factureState(S, f);
        assert(!st.annulee, 'Cette facture est déjà annulée.');
        if (j.type === 'annulation') {
            assert(st.montant_paye === 0, 'Facture déjà (partiellement) payée : annulez d\'abord les paiements concernés.');
        } else {
            var d = signedAdjustment(j);
            assert(d !== 0, 'Le montant doit être non nul.');
            if (d < 0) assert(-d <= st.reste_a_payer, 'Réduction supérieure au reste à payer (' + st.reste_a_payer + ' F) : annulez d\'abord les paiements concernés.');
        }
        return st;
    }

    /**
     * Ajustement (remise, majoration, correction, annulation). Motif obligatoire.
     * o.valider = true (président) → validé immédiatement ; sinon « en_attente » (validation par le président).
     */
    function buildAdjustmentOps(S, o) {
        S = normState(S);
        assert(TYPES_AJUSTEMENT.indexOf(o.type) !== -1, "Type d'ajustement invalide.");
        assert(str(o.motif).trim().length >= 3, 'Le motif est obligatoire.');
        var newId = makeIdGen(o.newId, 'ev');
        var f = S.factures[o.factureId];
        assert(f, 'Facture introuvable.');
        var montant = o.type === 'annulation' ? r0(factureState(S, f).montant_net) : r0(o.type === 'correction' ? o.montant : Math.abs(Number(o.montant) || 0));
        var aid = o.ajustementId || newId();
        var j = {
            ajustement_id: aid, compteur_id: f.compteur_id, facture_id: o.factureId, cycle: f.cycle,
            type: o.type, montant: montant, motif: str(o.motif).trim(),
            cree_par: (o.user && o.user.uid) || 'inconnu', cree_par_nom: (o.user && o.user.nom) || null,
            created_at: o.now, statut: 'en_attente', valide_par: null, date_validation: null
        };
        checkAdjustment(S, j);
        var tx = new Tx(S, o.paths, o.now, o.user);
        if (o.valider) { j.statut = 'valide'; j.valide_par = j.cree_par; j.valide_par_nom = j.cree_par_nom; j.date_validation = o.now; }
        tx.S.ajustements[aid] = j;
        tx.set(o.paths.ajustements + '/' + aid, j);
        tx.audit(newId, 'AJUSTEMENT_CREE', 'ajustement', aid, f.compteur_id, { type: o.type, montant: montant, facture_id: o.factureId, motif: j.motif });
        if (o.valider) applyValidatedAdjustment(tx, newId, j);
        tx.touch(f.compteur_id);
        releveStatusUpdates(tx, f.compteur_id, o.releve);
        return { updates: tx.finish(), ajustementId: aid, apres: computeAccount(tx.S, f.compteur_id) };
    }

    function applyValidatedAdjustment(tx, newId, j) {
        tx.facturesTouched[j.facture_id] = true;
        tx.audit(newId, 'AJUSTEMENT_VALIDE', 'ajustement', j.ajustement_id, j.compteur_id, { type: j.type, montant: j.montant, facture_id: j.facture_id });
        if (j.type === 'annulation') tx.audit(newId, 'FACTURE_ANNULEE', 'facture', j.facture_id, j.compteur_id, { motif: j.motif });
        tx.allocate(j.compteur_id);          // une majoration peut être couverte par une avance disponible
    }

    /** Validation (ou rejet) d'un ajustement en attente — président. */
    function buildAdjustmentValidationOps(S, o) {
        S = normState(S);
        var j0 = S.ajustements[o.ajustementId];
        assert(j0, 'Ajustement introuvable.');
        assert(j0.statut === 'en_attente', 'Cet ajustement a déjà été traité.');
        assert(o.decision === 'valide' || o.decision === 'rejete', 'Décision invalide.');
        var newId = makeIdGen(o.newId, 'ev');
        if (o.decision === 'valide') checkAdjustment(S, j0);
        var tx = new Tx(S, o.paths, o.now, o.user);
        var j = tx.S.ajustements[o.ajustementId];
        j.statut = o.decision; j.valide_par = tx.user.uid || 'inconnu'; j.valide_par_nom = tx.user.nom || null; j.date_validation = o.now;
        ['statut', 'valide_par', 'valide_par_nom', 'date_validation'].forEach(function (k) { tx.set(o.paths.ajustements + '/' + o.ajustementId + '/' + k, j[k]); });
        if (o.decision === 'valide') applyValidatedAdjustment(tx, newId, j);
        else tx.audit(newId, 'AJUSTEMENT_REJETE', 'ajustement', o.ajustementId, j.compteur_id, { type: j.type, montant: j.montant });
        tx.touch(j.compteur_id);
        releveStatusUpdates(tx, j.compteur_id, o.releve);
        return { updates: tx.finish(), apres: computeAccount(tx.S, j.compteur_id) };
    }

    /** Résolution TECHNIQUE d'un problème de facture (≠ paiement : aucun montant ne change). */
    function buildProblemResolutionOps(S, o) {
        S = normState(S);
        var f = S.factures[o.factureId];
        assert(f && f.probleme && f.probleme.actif, 'Aucun problème actif sur cette facture.');
        assert(!f.probleme.resolu, 'Problème déjà résolu.');
        assert(str(o.motif).trim().length >= 3, 'Le motif de résolution est obligatoire.');
        var newId = makeIdGen(o.newId, 'ev');
        var tx = new Tx(S, o.paths, o.now, o.user);
        var p = o.paths.factures + '/' + o.factureId;
        var res = { motif: str(o.motif).trim(), resolu_par: tx.user.uid || 'inconnu', resolu_par_nom: tx.user.nom || null, resolu_le: o.now };
        tx.set(p + '/probleme/resolu', true);
        tx.set(p + '/probleme/resolution', res);
        tx.set(p + '/rev', (Number(f.rev) || 0) + 1);
        tx.set(p + '/updated_at', o.now);
        tx.audit(newId, 'PROBLEME_RESOLU', 'facture', o.factureId, f.compteur_id, { type: f.probleme.type, motif: res.motif });
        return { updates: tx.updates };
    }

    /**
     * Clôture mensuelle : archive + remise à zéro des compteurs (billing.js) + une facture figée par
     * relevé valide + affectation automatique des avances + soldes + audit. Un seul objet de mises à jour.
     * @param {object} o - { paths, cycleKey, compteurs (snapshot), now, dateLabel, user, newId }
     */
    function buildClosureOps(S, o) {
        S = normState(S);
        var newId = makeIdGen(o.newId, 'ev');
        var base = Billing.buildClosureUpdates({
            compteursPath: o.paths.compteurs, backupPath: o.paths.backup, cycleKey: o.cycleKey,
            data: o.compteurs, dateLabel: o.dateLabel
        });
        var tx = new Tx(S, o.paths, o.now, o.user);
        Object.keys(base.updates).forEach(function (k) { tx.set(k, base.updates[k]); });
        tx.updates[o.paths.backup + '/' + o.cycleKey].info.date_iso = o.now;

        var resume = { nb_factures: 0, total_facture: 0, anomalies: [], sans_consommation: 0, problemes: 0, avances_utilisees: 0 };
        Object.keys(o.compteurs || {}).forEach(function (cid) {
            var built = buildFacture({ record: o.compteurs[cid], cycle: o.cycleKey, compteurId: cid, now: o.now, source: 'cloture' });
            if (!built.facture) {
                if (built.anomalie) resume.anomalies.push({ compteur_id: cid, client: str(o.compteurs[cid].name), raison: built.raison });
                else resume.sans_consommation++;
                return;
            }
            var f = built.facture;
            assert(!S.factures[f.facture_id], 'La facture ' + f.facture_id + ' existe déjà : clôture annulée.');
            tx.S.factures[f.facture_id] = f;
            tx.facturesTouched[f.facture_id] = true;
            resume.nb_factures++; resume.total_facture += f.montant_initial;
            if (f.probleme) resume.problemes++;
            tx.audit(newId, 'FACTURE_CREEE', 'facture', f.facture_id, cid, { cycle: o.cycleKey, montant: f.montant_initial, source: 'cloture' });
            var plan = tx.allocate(cid);
            resume.avances_utilisees += plan.reduce(function (s, x) { return s + x.montant; }, 0);
        });
        tx.audit(newId, 'CLOTURE_EFFECTUEE', 'cycle', o.cycleKey, null, {
            nb_factures: resume.nb_factures, total_facture: resume.total_facture,
            anomalies: resume.anomalies.length, avances_utilisees: resume.avances_utilisees
        });
        return { updates: tx.finish(), resume: resume, keys: base.keys };
    }

    /**
     * Migration des arriérés historiques : UNE facture « migration_backup » par ligne d'archive
     * réellement impayée (hors anomalies, montant > 0). Aucun paiement rétroactif n'est créé ;
     * les lignes « payé » des archives restent historiques.
     * @param {object} o - { paths, backup, now, user, newId, source?, compteurs? }
     *   compteurs (facultatif) : relevés du mois en cours ; ceux déjà marqués « payé » AVANT la migration
     *   sont seulement SIGNALÉS (releves_marques_payes) — aucun paiement n'est inventé pour eux.
     */
    function buildMigrationOps(S, o) {
        S = normState(S);
        var newId = makeIdGen(o.newId, 'ev');
        var tx = new Tx(S, o.paths, o.now, o.user);
        var cycles = Object.keys(o.backup || {}).sort();
        var total = 0, n = 0, compteurs = {}, anomaliesExclues = 0, parCycle = {};
        cycles.forEach(function (cycle) {
            var rows = (o.backup[cycle] && o.backup[cycle].donnees) || {};
            Object.keys(rows).forEach(function (cid) {
                var rec = rows[cid];
                if (!rec || typeof rec !== 'object' || Billing.isPaid(rec)) return;
                var built = buildFacture({ record: rec, cycle: cycle, compteurId: cid, now: o.now, source: 'migration_backup' });
                if (!built.facture) { if (built.anomalie) anomaliesExclues++; return; }
                var f = built.facture;
                if (S.factures[f.facture_id]) return;      // déjà facturée : jamais deux fois
                tx.S.factures[f.facture_id] = f;
                tx.facturesTouched[f.facture_id] = true;
                total += f.montant_initial; n++; compteurs[cid] = true;
                parCycle[cycle] = (parCycle[cycle] || 0) + f.montant_initial;
                tx.audit(newId, 'FACTURE_CREEE', 'facture', f.facture_id, cid, { cycle: cycle, montant: f.montant_initial, source: 'migration_backup' });
            });
        });
        Object.keys(compteurs).forEach(function (cid) { tx.allocate(cid); });
        var mig = {
            date: o.now, source: o.source || 'backup', total_arrieres: r0(total), nb_factures_migrees: n,
            nb_compteurs: Object.keys(compteurs).length, cycles: cycles, dernier_cycle: cycles[cycles.length - 1] || null,
            par_cycle: parCycle, anomalies_exclues: anomaliesExclues, statut: 'terminee',
            releves_marques_payes: Object.keys(o.compteurs || {}).filter(function (k) { return o.compteurs[k] && Billing.isPaid(o.compteurs[k]); }).length,
            execute_par: (o.user && o.user.uid) || 'inconnu', execute_par_nom: (o.user && o.user.nom) || null
        };
        tx.set(o.paths.migration + '/v1', mig);
        tx.audit(newId, 'MIGRATION_EFFECTUEE', 'migration', 'v1', null, { total_arrieres: mig.total_arrieres, nb_factures: n });
        return { updates: tx.finish(), resume: mig };
    }

    /**
     * Correction d'un relevé ARCHIVÉ (index) après la migration : la facture figée n'est jamais
     * modifiée ; l'écart devient un ajustement « correction » validé (président), ou une facture
     * « correction_releve » est créée si le relevé était en anomalie (et donc sans facture).
     * @param {object} o - { paths, cycle, compteurId, newRecord, user, now, newId, motif }
     * @returns {{updates, action:'aucune'|'ajustement'|'facture'|'annulation', ecart:number}}
     */
    function buildArchiveCorrectionOps(S, o) {
        S = normState(S);
        var newId = makeIdGen(o.newId, 'ev');
        var fid = factureId(o.cycle, o.compteurId);
        var f = S.factures[fid];
        var cur = Billing.computeCurrent(o.newRecord || {});
        var base = cur.anomalie ? 0 : r0(cur.montant);
        var tx = new Tx(S, o.paths, o.now, o.user);
        var motif = str(o.motif).trim() || ('Correction du relevé archivé ' + o.cycle);
        if (!f) {
            if (Billing.isPaid(o.newRecord) || !(base > 0)) return { updates: {}, action: 'aucune', ecart: 0 };
            var built = buildFacture({ record: o.newRecord, cycle: o.cycle, compteurId: o.compteurId, now: o.now, source: 'correction_releve' });
            tx.S.factures[fid] = built.facture;
            tx.facturesTouched[fid] = true;
            tx.audit(newId, 'FACTURE_CREEE', 'facture', fid, o.compteurId, { cycle: o.cycle, montant: built.facture.montant_initial, source: 'correction_releve' });
            tx.allocate(o.compteurId);
            return { updates: tx.finish(), action: 'facture', ecart: built.facture.montant_initial };
        }
        var st = factureState(S, f);
        if (st.annulee) return { updates: {}, action: 'aucune', ecart: 0 };
        var corrections = vals(S.ajustements).filter(function (j) {
            return j.facture_id === fid && j.type === 'correction' && isValidAdjustment(j);
        }).reduce(function (s, j) { return s + (Number(j.montant) || 0); }, 0);
        var ecart = r0(base - (Number(f.montant_initial) || 0) - corrections);
        if (ecart === 0) return { updates: {}, action: 'aucune', ecart: 0 };
        var r = buildAdjustmentOps(S, {
            paths: o.paths, factureId: fid, type: 'correction', montant: ecart, motif: motif,
            valider: true, user: o.user, now: o.now, newId: newId
        });
        return { updates: r.updates, action: 'ajustement', ecart: ecart };
    }

    /** Recalcul intégral du cache soldes (tous les compteurs du grand livre + ceux fournis). */
    function buildSoldesRebuild(S, o) {
        S = normState(S);
        var ids = {};
        vals(S.factures).forEach(function (f) { ids[f.compteur_id] = true; });
        vals(S.paiements).forEach(function (p) { ids[p.compteur_id] = true; });
        Object.keys(S.soldes).forEach(function (k) { ids[k] = true; });
        (o.compteurIds || []).forEach(function (k) { ids[k] = true; });
        var updates = {}, soldes = {};
        Object.keys(ids).forEach(function (cid) {
            var c = soldeCache(computeAccount(S, cid));
            c.rev = ((S.soldes[cid] && Number(S.soldes[cid].rev)) || 0) + 1;
            c.updated_at = o.now;
            soldes[cid] = c;
            updates[o.paths.soldes + '/' + cid] = c;
        });
        return { updates: updates, soldes: soldes };
    }

    /** Écarts entre le cache soldes et le recalcul (contrôle d'intégrité). */
    function checkSoldes(S) {
        S = normState(S);
        var diffs = [];
        var ids = {};
        vals(S.factures).forEach(function (f) { ids[f.compteur_id] = true; });
        vals(S.paiements).forEach(function (p) { ids[p.compteur_id] = true; });
        Object.keys(S.soldes).forEach(function (k) { ids[k] = true; });
        Object.keys(ids).forEach(function (cid) {
            var c = soldeCache(computeAccount(S, cid));
            var s = S.soldes[cid] || {};
            ['solde', 'arrieres', 'avance', 'total_facture', 'total_paye'].forEach(function (k) {
                if (r0(s[k]) !== c[k]) diffs.push({ compteur_id: cid, champ: k, cache: s[k], calcule: c[k] });
            });
        });
        return diffs;
    }

    // ─────────────────────────────────────────────────────────────
    // STATISTIQUES
    // ─────────────────────────────────────────────────────────────
    /** "31/05/2026 19:09:44" (fr-FR) ou ISO → ms. */
    function parseDate(s) {
        if (!s) return 0;
        var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s));
        if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
        return t(s);
    }

    /** Fenêtre temporelle de chaque cycle : de la clôture précédente à sa clôture ; « ouvert » ensuite. */
    function cycleWindows(backup) {
        var cycles = Object.keys(backup || {}).sort();
        var w = {}, prev = 0;
        cycles.forEach(function (c) {
            var info = (backup[c] && backup[c].info) || {};
            var end = t(info.date_iso) || parseDate(info.date_sauvegarde) || 0;
            w[c] = { start: prev, end: end };
            prev = end || prev;
        });
        return { windows: w, openStart: prev, lastCycle: cycles[cycles.length - 1] || null };
    }

    /**
     * Indicateurs d'une période (ledger) : chaque montant n'est compté qu'une fois.
     * @param {object} o - { start, end (ms, Infinity = maintenant), cycle (période : factures émises),
     *                       compteurIds? ({id:true} : restreindre à ces compteurs, ex. filtre par agent) }
     * @returns {{facture, encaisse, arrieres, avances, ajustements, problemes, nb_paiements, par_mode}}
     */
    function periodStats(S, o) {
        S = normState(S);
        var end = o.end === undefined || o.end === Infinity ? Infinity : o.end;
        var asOf = end === Infinity ? null : end;
        var facture = 0, encaisse = 0, ajust = 0, nbPay = 0, parMode = {}, problemes = 0;
        var keep = function (cid) { return !o.compteurIds || !!o.compteurIds[cid]; };
        vals(S.factures).forEach(function (f) {
            if (f.cycle !== o.cycle || !keep(f.compteur_id)) return;
            var st = factureState(S, f);
            if (!st.annulee) facture += Number(f.montant_initial) || 0;
            if (f.probleme && f.probleme.actif && !f.probleme.resolu) problemes++;
        });
        vals(S.paiements).forEach(function (p) {
            if (!isValidPayment(p) || !keep(p.compteur_id)) return;
            var d = t(p.date_paiement);
            if (d <= o.start || d > end) return;
            encaisse += r0(p.montant); nbPay++;
            parMode[p.mode] = (parMode[p.mode] || 0) + r0(p.montant);
        });
        vals(S.ajustements).forEach(function (j) {
            if (!isValidAdjustment(j) || j.type === 'annulation' || !keep(j.compteur_id)) return;
            var d = t(j.date_validation);
            if (d <= o.start || d > end) return;
            ajust += signedAdjustment(j);
        });
        var ids = {};
        vals(S.factures).forEach(function (f) { ids[f.compteur_id] = true; });
        vals(S.paiements).forEach(function (p) { ids[p.compteur_id] = true; });
        var arrieres = 0, avances = 0;
        Object.keys(ids).forEach(function (cid) {
            if (!keep(cid)) return;
            var acc = computeAccount(S, cid, asOf ? { asOf: asOf, cycleMax: o.cycle } : null);
            arrieres += acc.arrieres; avances += acc.avance;
        });
        return {
            facture: r0(facture), encaisse: r0(encaisse), arrieres: r0(arrieres), avances: r0(avances),
            ajustements: r0(ajust), problemes: problemes, nb_paiements: nbPay, par_mode: parMode
        };
    }

    /**
     * Indicateurs HISTORIQUES d'un cycle archivé antérieur à la comptabilité (reconstitués depuis l'archive).
     * Facturé = relevés valides du cycle ; Encaissé (historique) = relevés marqués payés ;
     * Arriérés = relevés impayés des cycles ≤ ce cycle tels qu'enregistrés aujourd'hui dans les archives.
     */
    function historicStats(backup, cycle) {
        var rows = (backup[cycle] && backup[cycle].donnees) || {};
        var facture = 0, encaisse = 0, problemes = 0;
        Object.keys(rows).forEach(function (k) {
            var r = rows[k], c = Billing.computeCurrent(r);
            if (c.anomalie) { if (Billing.toNum(r.new_index) > 0) problemes++; return; }
            facture += c.montant;
            if (Billing.isPaid(r)) encaisse += c.montant;
            if (Billing.isUnusualConsumption(r)) problemes++;
        });
        var arrieres = 0;
        Object.keys(backup).forEach(function (cy) {
            if (cy > cycle) return;
            var rr = backup[cy].donnees || {};
            Object.keys(rr).forEach(function (k) {
                if (Billing.isPaid(rr[k])) return;
                var c = Billing.computeCurrent(rr[k]);
                if (!c.anomalie) arrieres += c.montant;
            });
        });
        return { facture: r0(facture), encaisse: r0(encaisse), arrieres: r0(arrieres), avances: 0, ajustements: 0, problemes: problemes, historique: true };
    }

    return {
        MODES: MODES, MODES_LABEL: MODES_LABEL, TYPES_AJUSTEMENT: TYPES_AJUSTEMENT, STATUTS_FACTURE: STATUTS_FACTURE,
        emptyState: emptyState, normState: normState, pathsFor: pathsFor, factureId: factureId,
        detectProbleme: detectProbleme, buildFacture: buildFacture,
        factureState: factureState, computeAccount: computeAccount, planAllocations: planAllocations,
        amountDueNow: amountDueNow, soldeCache: soldeCache,
        buildPaymentOps: buildPaymentOps, buildPaymentCancelOps: buildPaymentCancelOps,
        buildAdjustmentOps: buildAdjustmentOps, buildAdjustmentValidationOps: buildAdjustmentValidationOps,
        buildProblemResolutionOps: buildProblemResolutionOps, buildClosureOps: buildClosureOps,
        buildMigrationOps: buildMigrationOps, buildArchiveCorrectionOps: buildArchiveCorrectionOps,
        buildSoldesRebuild: buildSoldesRebuild, checkSoldes: checkSoldes,
        parseDate: parseDate, cycleWindows: cycleWindows, periodStats: periodStats, historicStats: historicStats
    };
});
