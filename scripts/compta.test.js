/**
 * compta.test.js — Tests du moteur comptable (compta.js)
 *
 * Exécution :  node scripts/compta.test.js
 *   COMPTA_JSON=/chemin/export.json  → vérifie aussi la migration sur un export Firebase réel
 *   (jamais commité : contient des données personnelles).
 *
 * Les opérations sont appliquées sur une base simulée en mémoire avec la même sémantique
 * que update(ref(db), updates) de Firebase (multi-chemins, null = suppression).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const C = require(path.join(__dirname, '..', 'compta.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); passed++; console.log('  ✓ ' + name); }
    catch (err) { failures.push({ name, err }); console.error('  ✗ ' + name + '\n    ' + (err.stack || err.message).split('\n').slice(0, 3).join('\n    ')); }
}

// ── Base simulée ─────────────────────────────────────────────
const BASE = 'Asufor/F';
const P = C.pathsFor(BASE);
function newDb(tree) { return { tree: tree || {} }; }
function setAt(tree, p, v) {
    const parts = p.split('/'); let n = tree;
    for (let i = 0; i < parts.length - 1; i++) { if (n[parts[i]] == null || typeof n[parts[i]] !== 'object') n[parts[i]] = {}; n = n[parts[i]]; }
    const last = parts[parts.length - 1];
    if (v === null || v === undefined) delete n[last]; else n[last] = JSON.parse(JSON.stringify(v));
}
function getAt(tree, p) { let n = tree; for (const s of p.split('/')) { if (n == null) return undefined; n = n[s]; } return n; }
function apply(db, updates) { Object.keys(updates).forEach(k => setAt(db.tree, k, updates[k])); }
function state(db) {
    const f = getAt(db.tree, BASE) || {};
    return { factures: f.factures || {}, paiements: f.paiements || {}, affectations: f.affectations || {}, ajustements: f.ajustements || {}, soldes: f.soldes || {} };
}
let seq = 0;
const newId = () => 'id' + String(++seq).padStart(5, '0');
const USER_T = { uid: 'uT', nom: 'Trésorier', role: 'trésorier' };
const USER_P = { uid: 'uP', nom: 'Président', role: 'président' };
let clock = Date.parse('2026-06-01T08:00:00Z');
const tick = (d) => new Date(clock += (d || 3600e3)).toISOString();
const rel = (l, n, over) => Object.assign({ name: 'Awa', numero_compteur: '7', zone: 'Nord', last_index: String(l), new_index: n, facteur: 250, status: 'impaye', statut: false }, over || {});

function close(db, cycle, compteurs) {
    const r = C.buildClosureOps(state(db), { paths: P, cycleKey: cycle, compteurs, now: tick(), dateLabel: cycle, user: USER_P, newId });
    apply(db, r.updates); return r;
}
function pay(db, cid, montant, over) {
    const r = C.buildPaymentOps(state(db), Object.assign({ paths: P, compteurId: cid, montant, mode: 'especes', numero_recu: 'R-' + (++seq), user: USER_T, now: tick(), newId }, over || {}));
    apply(db, r.updates); return r;
}
const acc = (db, cid) => C.computeAccount(state(db), cid);
const LEGACY = /\/(apaid|arriere|arrieres|facture|print|diff|phone_service|last_modified|releve_date|tel|anomaly_date|gps|photo_url)$/;
// Champs historiques interdits dans les compteurs et les archives (le cache « soldes » a, lui, le droit
// d'exposer « arrieres » : c'est une valeur dérivée, recalculable).
function noLegacy(updates) {
    const BAD = ['apaid', 'arriere', 'arrieres', 'facture', 'print', 'diff', 'phone_service', 'last_modified', 'releve_date', 'tel', 'anomaly_date', 'gps', 'photo_url'];
    Object.keys(updates).forEach(k => {
        if (!/\/(compteurs|backup)\//.test(k)) return;
        assert.ok(!LEGACY.test(k), 'champ historique écrit : ' + k);
        const v = updates[k];
        if (v && typeof v === 'object') JSON.stringify(v, (kk, vv) => { assert.ok(!BAD.includes(kk), 'champ historique ' + kk + ' dans ' + k); return vv; });
    });
}

// ═════════════════════════════════════════════════════════════
test('exemple du cahier des charges : juin→septembre = 5 000 / 5 000 / 8 000 / 3 000', () => {
    const db = newDb();
    let idx = 0;
    const month = (cycle, paiement) => {
        if (paiement) pay(db, 'c1', paiement);
        close(db, cycle, { c1: rel(idx, idx + 20) });   // 20 m³ × 250 = 5 000
        idx += 20;
        return acc(db, 'c1');
    };
    assert.strictEqual(month('2026-06', 0).arrieres, 5000);
    assert.strictEqual(month('2026-07', 5000).arrieres, 5000);
    assert.strictEqual(month('2026-08', 2000).arrieres, 8000);
    const a = month('2026-09', 10000);
    assert.strictEqual(a.arrieres, 3000);
    assert.strictEqual(a.avance, 0);
    assert.strictEqual(a.solde, 3000);
    // juin (le plus ancien) a été soldé par le paiement de juillet (FIFO) : il n'a jamais « disparu »
    assert.strictEqual(a.factures.find(f => f.cycle === '2026-06').statut, 'payee');
});

test('ancien arriéré qui ne disparaît jamais : juin impayé reste dû quel que soit le sort de juillet', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    close(db, '2026-07', { c1: rel(20, 40) });
    pay(db, 'c1', 5000);          // un seul paiement : il règle JUIN (le plus ancien), pas juillet
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 5000);
    assert.deepStrictEqual(a.factures.map(f => [f.cycle, f.statut]), [['2026-06', 'payee'], ['2026-07', 'ouverte']]);
});

test('paiement total : facture payée, arriérés 0, audit PAIEMENT_CREE, pas de champ historique', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const r = pay(db, 'c1', 5000);
    noLegacy(r.updates);
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 0); assert.strictEqual(a.avance, 0);
    assert.strictEqual(a.factures[0].statut, 'payee');
    assert.ok(Object.values(getAt(db.tree, P.audit)).some(e => e.action === 'PAIEMENT_CREE' && e.entite_id === r.paiementId && e.utilisateur === 'uT' && e.role === 'trésorier'));
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c1/reste_a_payer'), 0);
});

test('paiement partiel : facture « partielle », reste exact', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    pay(db, 'c1', 1500);
    const f = acc(db, 'c1').factures[0];
    assert.strictEqual(f.statut, 'partielle'); assert.strictEqual(f.montant_paye, 1500); assert.strictEqual(f.reste_a_payer, 3500);
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c1/statut'), 'partielle');
});

test('FIFO : juin 5 000 + juillet 5 000, paiement 7 000 → juin payé, juillet 2 000 payé / 3 000 restant', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    close(db, '2026-07', { c1: rel(20, 40) });
    const r = pay(db, 'c1', 7000);
    assert.deepStrictEqual(r.affectations.map(x => [x.cycle, x.montant, x.ordre, x.reste_apres]), [['2026-06', 5000, 1, 0], ['2026-07', 2000, 2, 3000]]);
    const aff = getAt(db.tree, P.affectations + '/' + r.paiementId);
    assert.strictEqual(aff['2026-06_c1'].montant, 5000); assert.strictEqual(aff['2026-06_c1'].ordre, 1);
    assert.strictEqual(aff['2026-07_c1'].montant, 2000); assert.strictEqual(aff['2026-07_c1'].cycle, '2026-07');
    assert.strictEqual(acc(db, 'c1').arrieres, 3000);
});

test('paiement supérieur à la dette : 5 000 affectés, 5 000 d\'avance (solde négatif = crédit)', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const r = pay(db, 'c1', 10000);
    assert.strictEqual(r.avance, 5000);
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 0); assert.strictEqual(a.avance, 5000); assert.strictEqual(a.solde, -5000);
    assert.strictEqual(getAt(db.tree, P.soldes + '/c1/avance'), 5000);
});

test('avance utilisée automatiquement à la facture suivante (clôture)', () => {
    const db = newDb();
    pay(db, 'c1', 3000);                               // payé avant toute facture : avance
    const r = close(db, '2026-06', { c1: rel(0, 20) });
    assert.strictEqual(r.resume.avances_utilisees, 3000);
    const a = acc(db, 'c1');
    assert.strictEqual(a.avance, 0); assert.strictEqual(a.arrieres, 2000);
    assert.strictEqual(a.factures[0].statut, 'partielle');
});

test('annulation d\'un paiement : contre-écriture, factures rouvertes, paiement conservé, autres avances réaffectées', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const p1 = pay(db, 'c1', 5000);
    const p2 = pay(db, 'c1', 4000);                    // avance 4 000
    assert.throws(() => C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p1.paiementId, motif: '', user: USER_P, now: tick(), newId }), /motif/);
    const r = C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p1.paiementId, motif: 'Billet faux', user: USER_P, now: tick(), newId });
    apply(db, r.updates);
    const pay1 = getAt(db.tree, P.paiements + '/' + p1.paiementId);
    assert.strictEqual(pay1.statut, 'annule'); assert.strictEqual(pay1.montant, 5000); assert.strictEqual(pay1.motif_annulation, 'Billet faux');
    assert.strictEqual(getAt(db.tree, P.affectations + '/' + p1.paiementId + '/2026-06_c1/statut'), 'annulee');
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 1000);                 // l'avance de 4 000 a été réaffectée à juin
    assert.strictEqual(a.avance, 0);
    assert.strictEqual(getAt(db.tree, P.affectations + '/' + p2.paiementId + '/2026-06_c1/montant'), 4000);
    assert.throws(() => C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p1.paiementId, motif: 'x', user: USER_P, now: tick(), newId }), /déjà annulé/);
    assert.ok(Object.values(getAt(db.tree, P.audit)).some(e => e.action === 'PAIEMENT_ANNULE'));
});

test('remise : réduit le montant net (motif obligatoire, pas au-delà du reste), en attente puis validée', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const fid = '2026-06_c1';
    assert.throws(() => C.buildAdjustmentOps(state(db), { paths: P, factureId: fid, type: 'remise', montant: 1000, motif: '', user: USER_T, now: tick(), newId }), /motif/);
    assert.throws(() => C.buildAdjustmentOps(state(db), { paths: P, factureId: fid, type: 'remise', montant: 9000, motif: 'Geste', user: USER_P, valider: true, now: tick(), newId }), /reste à payer/);
    const r = C.buildAdjustmentOps(state(db), { paths: P, factureId: fid, type: 'remise', montant: 1000, motif: 'Fuite réparée', user: USER_T, now: tick(), newId });
    apply(db, r.updates);
    assert.strictEqual(acc(db, 'c1').arrieres, 5000);     // en attente : aucun effet
    const v = C.buildAdjustmentValidationOps(state(db), { paths: P, ajustementId: r.ajustementId, decision: 'valide', user: USER_P, now: tick(), newId });
    apply(db, v.updates);
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 4000); assert.strictEqual(a.total_ajustements, -1000);
    assert.strictEqual(a.factures[0].montant_initial, 5000);        // la facture figée n'est jamais réécrite
    assert.strictEqual(getAt(db.tree, P.factures + '/' + fid + '/montant_net'), 4000);
    const ev = Object.values(getAt(db.tree, P.audit)).map(e => e.action);
    assert.ok(ev.includes('AJUSTEMENT_CREE') && ev.includes('AJUSTEMENT_VALIDE'));
});

test('majoration : augmente la facture et consomme l\'avance disponible', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    pay(db, 'c1', 6000);                                  // avance 1 000
    const r = C.buildAdjustmentOps(state(db), { paths: P, factureId: '2026-06_c1', type: 'majoration', montant: 1500, motif: 'Frais de réouverture', user: USER_P, valider: true, now: tick(), newId });
    apply(db, r.updates);
    const a = acc(db, 'c1');
    assert.strictEqual(a.arrieres, 500); assert.strictEqual(a.avance, 0); assert.strictEqual(a.total_ajustements, 1500);
});

test('annulation de facture : net 0, statut « annulee », refusée si déjà payée', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20), c2: rel(0, 8) });
    pay(db, 'c2', 500);
    assert.throws(() => C.buildAdjustmentOps(state(db), { paths: P, factureId: '2026-06_c2', type: 'annulation', motif: 'Erreur', user: USER_P, valider: true, now: tick(), newId }), /déjà \(partiellement\) payée/);
    const r = C.buildAdjustmentOps(state(db), { paths: P, factureId: '2026-06_c1', type: 'annulation', motif: 'Compteur de test', user: USER_P, valider: true, now: tick(), newId });
    apply(db, r.updates);
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c1/statut'), 'annulee');
    assert.strictEqual(acc(db, 'c1').arrieres, 0);
    assert.ok(Object.values(getAt(db.tree, P.audit)).some(e => e.action === 'FACTURE_ANNULEE'));
});

test('surconsommation > 100 m³ IMPAYÉE : facturée normalement, 1 problème + 37 500 d\'arriérés (pas 75 000)', () => {
    const db = newDb();
    const r = close(db, '2026-06', { c1: rel(0, 150), c2: rel(0, 10) });
    const f = getAt(db.tree, P.factures + '/2026-06_c1');
    assert.strictEqual(f.montant_initial, 37500);
    assert.deepStrictEqual(Object.assign({}, f.probleme), { actif: true, type: 'surconsommation', niveau: 'alerte', seuil_m3: 100, valeur_m3: 150, detecte_automatiquement: true, resolu: false });
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c2/probleme'), undefined);
    assert.strictEqual(r.resume.problemes, 1);
    const st = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.strictEqual(st.problemes, 1);
    assert.strictEqual(st.arrieres, 37500 + 2500);        // chaque montant une seule fois
    assert.strictEqual(st.facture, 37500 + 2500);
});

test('surconsommation PAYÉE : reste dans Problèmes tant que non résolue, arriéré 0 ; résoudre ≠ payer', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 150) });
    pay(db, 'c1', 37500);
    let st = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.strictEqual(st.problemes, 1); assert.strictEqual(st.arrieres, 0);
    // résolution technique d'une facture impayée : ne paie rien
    const db2 = newDb();
    close(db2, '2026-06', { c1: rel(0, 150) });
    const r = C.buildProblemResolutionOps(state(db2), { paths: P, factureId: '2026-06_c1', motif: 'Fuite réparée par le plombier', user: USER_P, now: tick(), newId });
    apply(db2, r.updates);
    const f = getAt(db2.tree, P.factures + '/2026-06_c1');
    assert.strictEqual(f.probleme.resolu, true); assert.strictEqual(f.probleme.resolution.resolu_par, 'uP');
    assert.strictEqual(acc(db2, 'c1').arrieres, 37500);
    st = C.periodStats(state(db2), { cycle: '2026-06', start: 0, end: Infinity });
    assert.strictEqual(st.problemes, 0); assert.strictEqual(st.arrieres, 37500);
    assert.ok(Object.values(getAt(db2.tree, P.audit)).some(e => e.action === 'PROBLEME_RESOLU'));
});

test('index qui régresse : aucune facture, montant 0, pas d\'arriéré (signalé à la clôture)', () => {
    const db = newDb();
    const r = close(db, '2026-06', { c1: rel(500, 50), c2: rel(300, 0), c3: rel(10, 10) });
    assert.strictEqual(getAt(db.tree, P.factures), undefined);
    assert.strictEqual(r.resume.nb_factures, 0);
    assert.strictEqual(r.resume.anomalies.length, 2);          // index qui recule + non relevé
    assert.strictEqual(r.resume.sans_consommation, 1);
    assert.strictEqual(acc(db, 'c1').arrieres, 0);
    // correction ultérieure du relevé archivé → facture « correction_releve »
    const c = C.buildArchiveCorrectionOps(state(db), { paths: P, cycle: '2026-06', compteurId: 'c1', newRecord: rel(500, 520), user: USER_P, now: tick(), newId });
    assert.strictEqual(c.action, 'facture');
    apply(db, c.updates);
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c1/source'), 'correction_releve');
    assert.strictEqual(acc(db, 'c1').arrieres, 5000);
});

test('correction d\'index d\'une facture figée : ajustement « correction » validé, jamais de réécriture', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const c = C.buildArchiveCorrectionOps(state(db), { paths: P, cycle: '2026-06', compteurId: 'c1', newRecord: rel(0, 16), user: USER_P, now: tick(), newId });
    assert.strictEqual(c.action, 'ajustement'); assert.strictEqual(c.ecart, -1000);
    apply(db, c.updates);
    assert.ok(!Object.keys(c.updates).some(k => /factures\/2026-06_c1\/(montant_initial|nouvel_index|consommation)$/.test(k)));
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-06_c1/montant_initial'), 5000);
    assert.strictEqual(acc(db, 'c1').arrieres, 4000);
    // re-correction vers la valeur initiale : l'écart se calcule par rapport aux corrections déjà validées
    const c2 = C.buildArchiveCorrectionOps(state(db), { paths: P, cycle: '2026-06', compteurId: 'c1', newRecord: rel(0, 20), user: USER_P, now: tick(), newId });
    assert.strictEqual(c2.ecart, 1000);
    apply(db, c2.updates);
    assert.strictEqual(acc(db, 'c1').arrieres, 5000);
});

test('clôture : archive + factures + remise à zéro + audit, sans champ historique ; seconde clôture refusée', () => {
    const db = newDb();
    const r = close(db, '2026-06', { c1: rel(0, 20), c2: rel(5, 5) });
    noLegacy(r.updates);
    assert.ok(getAt(db.tree, P.backup + '/2026-06/donnees/c1'));
    assert.ok(getAt(db.tree, P.backup + '/2026-06/info/date_iso'));
    assert.strictEqual(getAt(db.tree, P.compteurs + '/c1/new_index'), 0);
    assert.strictEqual(getAt(db.tree, P.compteurs + '/c1/last_index'), '20');
    const f = getAt(db.tree, P.factures + '/2026-06_c1');
    ['facture_id', 'compteur_id', 'numero_compteur', 'client', 'cycle', 'ancien_index', 'nouvel_index', 'consommation', 'facteur', 'montant_initial', 'montant_net', 'montant_paye', 'reste_a_payer', 'statut', 'date_creation', 'date_echeance', 'source', 'verrouillee']
        .forEach(k => assert.ok(f[k] !== undefined, 'champ facture manquant : ' + k));
    assert.strictEqual(f.source, 'cloture'); assert.strictEqual(f.verrouillee, true); assert.strictEqual(f.consommation, 20);
    assert.ok(Object.values(getAt(db.tree, P.audit)).some(e => e.action === 'CLOTURE_EFFECTUEE' && e.entite_id === '2026-06'));
    assert.ok(Object.values(getAt(db.tree, P.audit)).some(e => e.action === 'FACTURE_CREEE'));
    assert.throws(() => C.buildClosureOps(state(db), { paths: P, cycleKey: '2026-06', compteurs: { c1: rel(0, 20) }, now: tick(), dateLabel: 'x', user: USER_P, newId }), /existe déjà/);
});

test('statistiques : une facture de juin réglée en octobre réduit l\'arriéré mais compte dans « Encaissé octobre »', () => {
    const db = newDb();
    clock = Date.parse('2026-06-30T12:00:00Z');
    close(db, '2026-06', { c1: rel(0, 20) });
    const juin = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Date.parse('2026-07-01') });
    assert.deepStrictEqual([juin.facture, juin.encaisse, juin.arrieres], [5000, 0, 5000]);
    clock = Date.parse('2026-10-10T12:00:00Z');
    pay(db, 'c1', 5000, { mode: 'wave' });
    const oct = C.periodStats(state(db), { cycle: '2026-10', start: Date.parse('2026-09-30'), end: Infinity });
    assert.deepStrictEqual([oct.facture, oct.encaisse, oct.arrieres, oct.nb_paiements], [0, 5000, 0, 1]);
    assert.strictEqual(oct.par_mode.wave, 5000);
    // vue « fin juin » : juin reste dû (le paiement d'octobre n'existait pas encore)
    const juinApres = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Date.parse('2026-07-01') });
    assert.strictEqual(juinApres.arrieres, 5000); assert.strictEqual(juinApres.encaisse, 0);
});

test('statistiques : un paiement annulé ne compte pas dans l\'encaissé ; avances comptées une seule fois', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const p = pay(db, 'c1', 8000);
    let st = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.deepStrictEqual([st.encaisse, st.arrieres, st.avances], [8000, 0, 3000]);
    apply(db, C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p.paiementId, motif: 'Erreur de saisie', user: USER_P, now: tick(), newId }).updates);
    st = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.deepStrictEqual([st.encaisse, st.arrieres, st.avances], [0, 5000, 0]);
});

test('Statistiques — « Annuler encaissement » : paiement de 11 500 F, Encaissé -11 500, dette +11 500, audit et KPI recalculés', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 46) });                           // 46 m³ × 250 F = 11 500 F
    const p = pay(db, 'c1', 11500);                                     // facture soldée par un seul paiement
    let avant = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.deepStrictEqual([avant.encaisse, avant.arrieres], [11500, 0]);
    assert.strictEqual(acc(db, 'c1').arrieres, 0);

    const r = C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p.paiementId, motif: 'Montant saisi par erreur', user: USER_P, now: tick(), newId });
    apply(db, r.updates);

    // Encaissé -11 500 F, dette (arriérés) +11 500 F, sur les KPI de la période comme sur le compte client.
    const apres = C.periodStats(state(db), { cycle: '2026-06', start: 0, end: Infinity });
    assert.deepStrictEqual([apres.encaisse - avant.encaisse, apres.arrieres - avant.arrieres], [-11500, 11500]);
    assert.strictEqual(acc(db, 'c1').arrieres, 11500);
    assert.strictEqual(acc(db, 'c1').solde, 11500);

    // Le paiement n'est jamais supprimé : historique, auteur et motif conservés.
    const pAnnule = state(db).paiements[p.paiementId];
    assert.strictEqual(pAnnule.montant, 11500);
    assert.strictEqual(pAnnule.statut, 'annule');
    assert.strictEqual(pAnnule.annule_par, USER_P.uid);
    assert.strictEqual(pAnnule.motif_annulation, 'Montant saisi par erreur');

    // Audit tracé (PAIEMENT_ANNULE), rien d'autre supprimé.
    const audit = Object.values(state(db).affectations[p.paiementId] || {});
    assert.ok(audit.every(a => a.statut === 'annulee'), 'affectations FIFO annulées');
    const events = Object.values(getAt(db.tree, BASE + '/audit_comptable') || {});
    const evt = events.find(e => e.action === 'PAIEMENT_ANNULE' && e.entite_id === p.paiementId);
    assert.ok(evt, 'PAIEMENT_ANNULE absent du journal d\'audit');
    assert.strictEqual(evt.role, 'président');

    // Double annulation refusée (jamais de suppression, jamais un second contre-passage silencieux).
    assert.throws(() => C.buildPaymentCancelOps(state(db), { paths: P, paiementId: p.paiementId, motif: 'x', user: USER_P, now: tick(), newId }), /déjà annulé/);
});

test('invariants : solde = arriérés − avance, Σ affectations ≤ paiement, cache soldes = recalcul intégral', () => {
    const db = newDb();
    let i = 0;
    ['2026-05', '2026-06', '2026-07', '2026-08'].forEach((cy, k) => {
        if (k === 1) pay(db, 'c1', 3000);
        if (k === 2) { pay(db, 'c2', 12000); pay(db, 'c1', 700); }
        if (k === 3) { const pz = pay(db, 'c3', 900); apply(db, C.buildPaymentCancelOps(state(db), { paths: P, paiementId: pz.paiementId, motif: 'Doublon', user: USER_P, now: tick(), newId }).updates); }
        close(db, cy, { c1: rel(i, i + 12), c2: rel(i, i + 30), c3: rel(i, i + 7) });
        i += 40;
    });
    const S = state(db);
    ['c1', 'c2', 'c3'].forEach(cid => {
        const a = C.computeAccount(S, cid);
        assert.strictEqual(a.solde, a.arrieres - a.avance, cid);
        a.paiements.forEach(p => assert.ok(p.affecte <= p.montant, 'sur-affectation ' + p.paiement_id));
        a.factures.forEach(f => assert.ok(f.montant_paye <= f.montant_net, 'sur-paiement ' + f.facture_id));
    });
    assert.deepStrictEqual(C.checkSoldes(S), []);                  // cache incrémental = recalcul intégral
    // cache corrompu → détecté puis reconstruit entièrement
    setAt(db.tree, P.soldes + '/c1/arrieres', 999999);
    setAt(db.tree, P.soldes + '/c2', null);
    assert.ok(C.checkSoldes(state(db)).length >= 2);
    const rb = C.buildSoldesRebuild(state(db), { paths: P, now: tick() });
    apply(db, rb.updates);
    assert.deepStrictEqual(C.checkSoldes(state(db)), []);
    assert.ok(Object.keys(rb.soldes).length === 3);
});

test('concurrence : chaque opération incrémente soldes.rev (verrou exigé par les règles)', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    const rev0 = getAt(db.tree, P.soldes + '/c1/rev');
    const r = C.buildPaymentOps(state(db), { paths: P, compteurId: 'c1', montant: 100, mode: 'especes', numero_recu: 'R1', user: USER_T, now: tick(), newId });
    assert.strictEqual(r.updates[P.soldes + '/c1'].rev, rev0 + 1);
    assert.strictEqual(r.updates[P.factures + '/2026-06_c1/rev'], 2);
});

test('validation des saisies : montant > 0, mode connu, n° de reçu obligatoire', () => {
    const S = C.emptyState();
    const base = { paths: P, compteurId: 'c1', mode: 'especes', numero_recu: 'R', user: USER_T, now: tick(), newId };
    assert.throws(() => C.buildPaymentOps(S, Object.assign({}, base, { montant: 0 })), /supérieur à 0/);
    assert.throws(() => C.buildPaymentOps(S, Object.assign({}, base, { montant: 10, mode: 'cheque' })), /Mode/);
    assert.throws(() => C.buildPaymentOps(S, Object.assign({}, base, { montant: 10, numero_recu: ' ' })), /reçu/);
    assert.deepStrictEqual(C.MODES, ['especes', 'wave', 'orange_money', 'virement', 'autre']);
});

test('montant dû maintenant (relevé en cours) : arriérés + facture provisoire − avance', () => {
    const db = newDb();
    close(db, '2026-06', { c1: rel(0, 20) });
    pay(db, 'c1', 1000);
    const d = C.amountDueNow(state(db), 'c1', rel(20, 30));       // 10 m³ en cours = 2 500
    assert.deepStrictEqual([d.arrieres, d.facture_provisoire, d.avance, d.total_du], [4000, 2500, 0, 6500]);
    const d2 = C.amountDueNow(state(db), 'c1', rel(20, 0));        // non relevé : pas de provisoire
    assert.strictEqual(d2.total_du, 4000);
});

// ── Migration ────────────────────────────────────────────────
test('migration : une facture par ligne d\'archive impayée, aucun paiement créé, lignes payées historiques', () => {
    const backup = {
        '2026-05': { info: {}, donnees: { a: rel(0, 6), b: rel(0, 10, { status: 'paye', statut: true }), c: rel(500, 50) } },
        '2026-06': { info: {}, donnees: { a: rel(6, 10), b: rel(10, 14), d: rel(0, 0) } }
    };
    const db = newDb();
    const r = C.buildMigrationOps(state(db), { paths: P, backup, now: tick(), user: USER_P, newId });
    apply(db, r.updates);
    noLegacy(r.updates);
    assert.strictEqual(r.resume.total_arrieres, 1500 + 1000 + 1000);
    assert.strictEqual(r.resume.nb_factures_migrees, 3);
    assert.strictEqual(r.resume.anomalies_exclues, 1);
    assert.strictEqual(getAt(db.tree, P.paiements), undefined);
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-05_a/source'), 'migration_backup');
    assert.strictEqual(getAt(db.tree, P.factures + '/2026-05_b'), undefined);        // payée : reste historique
    const m = getAt(db.tree, P.migration + '/v1');
    ['date', 'source', 'total_arrieres', 'nb_factures_migrees', 'statut', 'execute_par'].forEach(k => assert.ok(m[k] !== undefined, k));
    assert.strictEqual(m.statut, 'terminee');
    assert.strictEqual(acc(db, 'a').arrieres, 2500);
    // rejouer la migration ne crée aucun doublon
    const again = C.buildMigrationOps(state(db), { paths: P, backup, now: tick(), user: USER_P, newId });
    assert.strictEqual(again.resume.nb_factures_migrees, 0);
});

const REAL = process.env.COMPTA_JSON;
if (REAL && fs.existsSync(REAL)) {
    test('migration sur l\'export réel : total recalculé depuis les archives, identique au calcul historique', () => {
        const data = JSON.parse(fs.readFileSync(REAL, 'utf8'));
        Object.keys(data.Asufor || {}).forEach(fk => {
            const F = data.Asufor[fk];
            const B = require(path.join(__dirname, '..', 'billing.js'));
            const idx = B.indexBackups(F.backup || {});
            let historique = 0;
            Object.keys(F.compteurs || {}).forEach(k => { historique += B.computeArrears(F.compteurs[k], idx, { fbKey: k }).arriere; });
            const paths = C.pathsFor('Asufor/' + fk);
            const r = C.buildMigrationOps(C.emptyState(), { paths, backup: F.backup || {}, now: '2026-10-01T00:00:00Z', user: USER_P, newId });
            console.log('    ' + fk + ' : ' + r.resume.total_arrieres + ' F, ' + r.resume.nb_factures_migrees + ' factures, ' + r.resume.nb_compteurs + ' compteurs ; par cycle ' + JSON.stringify(r.resume.par_cycle));
            assert.strictEqual(r.resume.total_arrieres, historique);
            assert.ok(!Object.keys(r.updates).some(k => k.indexOf('/paiements/') !== -1));
        });
    });
}

console.log('\n' + passed + ' test(s) réussi(s), ' + failures.length + ' échec(s).');
if (failures.length) process.exit(1);
