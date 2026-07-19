/**
 * billing.test.js — Tests unitaires du moteur de facturation (billing.js)
 *
 * Exécution :  node scripts/billing.test.js   (ou  npm test  depuis scripts/)
 *
 * Sans dépendance externe : utilise le module `assert` intégré à Node.
 * Le processus sort avec un code != 0 si un test échoue (utilisable en CI).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Billing = require(path.join(__dirname, '..', 'billing.js'));

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓ ' + name);
    } catch (err) {
        failures.push({ name, err });
        console.error('  ✗ ' + name + '\n    ' + err.message);
    }
}

// ── Conversions ──────────────────────────────────────────────
test('toInt gère strings, nombres, espaces, vides et null', () => {
    assert.strictEqual(Billing.toInt('5064'), 5064);
    assert.strictEqual(Billing.toInt(5064), 5064);
    assert.strictEqual(Billing.toInt(' 250 '), 250);
    assert.strictEqual(Billing.toInt(''), null);
    assert.strictEqual(Billing.toInt(null), null);
    assert.strictEqual(Billing.toInt(undefined), null);
    assert.strictEqual(Billing.toInt('abc'), null);
    assert.strictEqual(Billing.toInt(12.9), 12); // tronqué
});

test('norm normalise trim + minuscules', () => {
    assert.strictEqual(Billing.norm('  ZoneA '), 'zonea');
    assert.strictEqual(Billing.norm(null), '');
});

test('meterKey combine numero_compteur + zone', () => {
    assert.strictEqual(Billing.meterKey({ numero_compteur: '00123', zone: 'Nord' }), '00123|nord');
});

test('isPaid tolère status="paye", statut=true et "true"', () => {
    assert.strictEqual(Billing.isPaid({ status: 'paye' }), true);
    assert.strictEqual(Billing.isPaid({ statut: true }), true);
    assert.strictEqual(Billing.isPaid({ statut: 'true' }), true);
    assert.strictEqual(Billing.isPaid({ status: 'impaye' }), false);
    assert.strictEqual(Billing.isPaid(null), false);
});

// ── Facture courante + anomalies ─────────────────────────────
test('computeCurrent : facture normale', () => {
    const r = Billing.computeCurrent({ last_index: '100', new_index: '150', facteur: '250' });
    assert.strictEqual(r.anomalie, false);
    assert.strictEqual(r.conso, 50);
    assert.strictEqual(r.montant, 12500);
    assert.strictEqual(r.facteur, 250);
});

test('computeCurrent : facteur par défaut si absent/invalide', () => {
    const r = Billing.computeCurrent({ last_index: 0, new_index: 10, facteur: '' });
    assert.strictEqual(r.facteur, Billing.FACTEUR_DEFAUT);
    assert.strictEqual(r.montant, 10 * Billing.FACTEUR_DEFAUT);
});

test('computeCurrent : anomalie si index manquant', () => {
    const r = Billing.computeCurrent({ last_index: '100', new_index: '', facteur: 250 });
    assert.strictEqual(r.anomalie, true);
    assert.strictEqual(r.montant, 0);
});

test('computeCurrent : anomalie si index décroissant', () => {
    const r = Billing.computeCurrent({ last_index: 200, new_index: 150, facteur: 250 });
    assert.strictEqual(r.anomalie, true);
    assert.strictEqual(r.montant, 0);
    assert.strictEqual(r.conso, 0);
});

// ── Arriérés ─────────────────────────────────────────────────
const backupRoot = {
    '2026-05': { donnees: {
        k1: { numero_compteur: '001', zone: 'N', last_index: '0',   new_index: '10', facteur: '250', status: 'impaye' }
    }},
    '2026-06': { donnees: {
        k2: { numero_compteur: '001', zone: 'N', last_index: '10',  new_index: '20', facteur: '250', status: 'paye' },
        k3: { numero_compteur: '001', zone: 'N', last_index: '20',  new_index: '5',  facteur: '250', status: 'impaye' } // anomalie
    }}
};

test('indexBackups trie les cycles et indexe par meterKey', () => {
    const idx = Billing.indexBackups(backupRoot);
    assert.strictEqual(idx.length, 2);
    assert.strictEqual(idx[0].cycle, '2026-05');
    assert.ok(idx[0].records['001|n']);
});

test('computeArrears : additionne les impayés, ignore payés et anomalies', () => {
    const idx = Billing.indexBackups(backupRoot);
    const rec = { numero_compteur: '001', zone: 'N' };
    const res = Billing.computeArrears(rec, idx);
    // 2026-05 impayé (10*250=2500) compte ; 2026-06 k2 payé ignoré ;
    // le cycle 2026-06 pour ce compteur est représenté par k2 (payé) → pas d'arriéré.
    assert.strictEqual(res.arriere, 2500);
});

test('computeArrears : beforeCycle exclut le mois courant et suivants', () => {
    const idx = Billing.indexBackups(backupRoot);
    const rec = { numero_compteur: '001', zone: 'N' };
    const res = Billing.computeArrears(rec, idx, { beforeCycle: '2026-05' });
    assert.strictEqual(res.arriere, 0); // rien avant 2026-05
});

test('computeStatement : total = facture courante + arriérés', () => {
    const idx = Billing.indexBackups(backupRoot);
    const current = { numero_compteur: '001', zone: 'N', last_index: '20', new_index: '30', facteur: '250', status: 'impaye' };
    const st = Billing.computeStatement(current, idx, { beforeCycle: '9999-99' });
    assert.strictEqual(st.facture_courante, 2500);
    assert.strictEqual(st.arriere, 2500);
    assert.strictEqual(st.total, 5000);
});

// ── Paiement / révocation ────────────────────────────────────
test('buildPaymentUpdates : régularise base active + cycles impayés', () => {
    const idx = Billing.indexBackups(backupRoot);
    const record = { numero_compteur: '001', zone: 'N' };
    const { updates, cyclesRegularises } = Billing.buildPaymentUpdates({
        activePath: 'asufor_db_diandioly', activeKey: 'ACT1', record,
        indexedBackups: idx, paidBy: 'test', timestamp: '2026-07-01T00:00:00Z'
    });
    assert.strictEqual(updates['asufor_db_diandioly/ACT1/status'], 'paye');
    assert.strictEqual(updates['asufor_db_diandioly/ACT1/arriere'], 0);
    // le cycle impayé 2026-05 doit être régularisé
    assert.strictEqual(updates['asufor_backup/2026-05/donnees/k1/status'], 'paye');
    assert.ok(cyclesRegularises.includes('2026-05'));
});

test('buildRevokeUpdates : repasse la base active en impayé', () => {
    const { updates } = Billing.buildRevokeUpdates({
        activePath: 'asufor_db_diandioly', activeKey: 'ACT1', paidBy: 'test', timestamp: '2026-07-01T00:00:00Z'
    });
    assert.strictEqual(updates['asufor_db_diandioly/ACT1/status'], 'impaye');
    assert.strictEqual(updates['asufor_db_diandioly/ACT1/statut'], false);
    assert.strictEqual(updates['asufor_db_diandioly/ACT1/date_paiement'], null);
});

// ── Bilan ────────────────────────────────────────────────────
console.log('\n' + passed + ' test(s) réussi(s), ' + failures.length + ' échec(s).');
if (failures.length > 0) process.exit(1);
