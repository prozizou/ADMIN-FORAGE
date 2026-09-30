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
const ForageContext = require(path.join(__dirname, '..', 'forage-context.js'));

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

test('computeCurrent : consommation élevée mais réelle (ex. borne-fontaine) reste facturée normalement', () => {
    const r = Billing.computeCurrent({ last_index: 0, new_index: 999999, facteur: 250 });
    assert.strictEqual(r.anomalie, false);
    assert.strictEqual(r.conso, 999999);
    assert.strictEqual(r.montant, 999999 * 250);
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

test('computeArrears : clé Firebase prioritaire (numéro/zone modifiés depuis la clôture)', () => {
    const root = { '2026-08': { donnees: {
        c1: { numero_compteur: '12', zone: 'Nord', last_index: 0, new_index: 10, facteur: 250, status: 'impaye' }
    }}};
    const idx = Billing.indexBackups(root);
    // Zone corrigée dans la base active : le repli numéro + zone ne trouve plus rien…
    const rec = { numero_compteur: '12', zone: 'Sud' };
    assert.strictEqual(Billing.computeArrears(rec, idx).arriere, 0);
    // …mais la clé Firebase, identique d'un cycle à l'autre, retrouve la dette.
    assert.strictEqual(Billing.computeArrears(rec, idx, { fbKey: 'c1' }).arriere, 2500);
});

test('computeArrears : clients sans numéro dans une même zone ne s\'écrasent plus', () => {
    const root = { '2026-08': { donnees: {
        a: { numero_compteur: '', zone: 'Nord', last_index: 0, new_index: 10, facteur: 250, status: 'impaye' },
        b: { numero_compteur: '', zone: 'Nord', last_index: 0, new_index: 20, facteur: 250, status: 'impaye' }
    }}};
    const idx = Billing.indexBackups(root);
    const rec = { numero_compteur: '', zone: 'Nord' };
    assert.strictEqual(Billing.computeArrears(rec, idx, { fbKey: 'a' }).arriere, 2500);
    assert.strictEqual(Billing.computeArrears(rec, idx, { fbKey: 'b' }).arriere, 5000);
});


// ── Arriérés : règle « archive la plus récente contenant le compteur » ──
const R = (n, l, f, st) => ({ numero_compteur: n, zone: 'N', last_index: l, new_index: f, facteur: 250, status: st });

test('arriérés : CUMUL INTÉGRAL — un mois ancien impayé reste dû même si le mois suivant est marqué payé', () => {
    const idx = Billing.indexBackups({
        '2026-06': { donnees: { a: R('1', 0, 20, 'impaye') } },     // 5000 dus
        '2026-07': { donnees: { a: R('1', 20, 30, 'paye') } }
    });
    assert.strictEqual(Billing.computeArrears(R('1', 30, 0, 'impaye'), idx, { fbKey: 'a' }).arriere, 5000);
});

test('arriérés : cumul intégral de tous les mois impayés, payés exclus', () => {
    const idx = Billing.indexBackups({
        '2026-05': { donnees: { a: R('1', 0, 4, 'impaye') } },      // 1000
        '2026-06': { donnees: { a: R('1', 4, 24, 'impaye') } },     // 5000
        '2026-07': { donnees: { a: R('1', 24, 34, 'paye') } },      // exclu
        '2026-08': { donnees: { a: R('1', 34, 36, 'impaye') } }     // 500
    });
    const r = Billing.computeArrears(R('1', 36, 40, 'impaye'), idx, { fbKey: 'a' });
    assert.strictEqual(r.arriere, 6500);
    assert.strictEqual(r.details.length, 3);
    // beforeCycle : vue d'une archive = uniquement les cycles qui la précèdent
    assert.strictEqual(Billing.computeArrears(R('1', 0, 0, 'x'), idx, { fbKey: 'a', beforeCycle: '2026-07' }).arriere, 6000);
});

test('arriérés : client absent du mois précédent → repris dans la dernière archive qui le contient', () => {
    const idx = Billing.indexBackups({
        '2026-06': { donnees: { a: R('1', 0, 32, 'impaye') } },     // 8000
        '2026-07': { donnees: { z: R('9', 0, 1, 'paye') } }
    });
    assert.strictEqual(Billing.computeArrears(R('1', 32, 0, 'impaye'), idx, { fbKey: 'a' }).arriere, 8000);
});

test('arriérés : numéro partagé → pas de repli ambigu, le client payé ne reçoit pas la dette de l\'autre', () => {
    const idx = Billing.indexBackups({
        '2026-07': { donnees: { p: R('5', 0, 10, 'paye'), q: R('5', 0, 40, 'impaye') } }
    });
    assert.strictEqual(Billing.computeArrears(R('5', 10, 0, 'impaye'), idx, { fbKey: 'p' }).arriere, 0);
    assert.strictEqual(Billing.computeArrears(R('5', 40, 0, 'impaye'), idx, { fbKey: 'q' }).arriere, 10000);
    // sans clé (donnée migrée) : numéro ambigu → aucune correspondance plutôt qu'une mauvaise
    assert.strictEqual(Billing.computeArrears(R('5', 10, 0, 'impaye'), idx, {}).arriere, 0);
});

test('arriérés : repli numéro+zone refusé si la ligne est la clé d\'un autre client actuel', () => {
    const idx = Billing.indexBackups({ '2026-07': { donnees: { a: R('7', 0, 10, 'impaye') } } });
    const autre = R('7', 10, 0, 'impaye');   // même numéro/zone, clé différente
    assert.strictEqual(Billing.computeArrears(autre, idx, { fbKey: 'b', currentKeys: { a: true, b: true } }).arriere, 0);
    assert.strictEqual(Billing.computeArrears(autre, idx, { fbKey: 'b' }).arriere, 2500);   // client vraiment recréé
});

test('arriérés : numéro vide → jamais de repli (clients sans numéro)', () => {
    const idx = Billing.indexBackups({ '2026-07': { donnees: { a: R('', 0, 10, 'impaye') } } });
    assert.strictEqual(Billing.computeArrears(R('', 10, 0, 'impaye'), idx, { fbKey: 'x' }).arriere, 0);
});


// ── Paiement / révocation ────────────────────────────────────




// ── forage-context.js ────────────────────────────────────────
test('ForageContext : mode legacy → chemins historiques', () => {
    const p = ForageContext.paths('Asufor_diandioly', { legacy: true });
    assert.strictEqual(p.compteurs, 'asufor_db_diandioly');
    assert.strictEqual(p.backup, 'asufor_backup');
    assert.strictEqual(p.agents, 'db_agents');
    assert.strictEqual(p.depenses, 'asufor_depenses');
    assert.strictEqual(p.forageKey, 'Asufor_diandioly');
});

test('ForageContext : mode namespacé → Asufor/{key}/…', () => {
    const p = ForageContext.paths('Asufor_abc123', { legacy: false });
    assert.strictEqual(p.compteurs, 'Asufor/Asufor_abc123/compteurs');
    assert.strictEqual(p.backup, 'Asufor/Asufor_abc123/backup');
    assert.strictEqual(p.agents, 'Asufor/Asufor_abc123/agents');
    assert.strictEqual(p.depenses, 'Asufor/Asufor_abc123/depenses');
    assert.strictEqual(p.config, 'Asufor/Asufor_abc123/config');
});

test('ForageContext : LEGACY désactivé après migration de Diandioly (Phase 4)', () => {
    assert.strictEqual(ForageContext.LEGACY, false);
    // sans opts, Diandioly est désormais namespacé comme tout autre forage
    assert.strictEqual(ForageContext.paths('Asufor_diandioly').compteurs, 'Asufor/Asufor_diandioly/compteurs');
});

test('ForageContext : LEGACY ne s\'applique QU\'à Diandioly (isolation multi-forage)', () => {
    // Régression : un président d'un AUTRE forage ne doit JAMAIS retomber sur les
    // chemins historiques de Diandioly, même si LEGACY était encore actif pour ce
    // dernier — sinon ses données se mélangent avec celles de Diandioly.
    const p = ForageContext.paths('Asufor_ogo');
    assert.strictEqual(p.compteurs, 'Asufor/Asufor_ogo/compteurs');
    assert.strictEqual(p.backup, 'Asufor/Asufor_ogo/backup');
    assert.strictEqual(p.agents, 'Asufor/Asufor_ogo/agents');
    assert.strictEqual(p.depenses, 'Asufor/Asufor_ogo/depenses');
    assert.strictEqual(p.config, 'Asufor/Asufor_ogo/config');
    assert.notStrictEqual(p.compteurs, 'asufor_db_diandioly');
});

test('ForageContext : détection du super-admin', () => {
    assert.strictEqual(ForageContext.isSuperadmin('prozizou298@gmail.com'), true);
    assert.strictEqual(ForageContext.isSuperadmin('  Prozizou298@Gmail.com '), true);
    assert.strictEqual(ForageContext.isSuperadmin('president@diandioly.com'), false);
    assert.strictEqual(ForageContext.isSuperadmin(null), false);
});

// ── Régression v6 : ajustements, règlement, révocation, bilan, clôture ──
const ANOM = (n, st) => R(n, 500, 50, st);   // index décroissant → anomalie













test('clôture : archive + remise à zéro, AUCUN champ historique recréé (apaid, arrieres, facture, print…)', () => {
    const data = {
        a: R('1', 10, 20, 'paye'),
        b: R('2', 5, 0, 'impaye')      // non relevé (new_index 0) → index conservé
    };
    const { updates, keys } = Billing.buildClosureUpdates({ compteursPath: 'A/c', backupPath: 'A/b', cycleKey: '2026-09', data, dateLabel: 'D' });
    assert.deepStrictEqual(keys, ['a', 'b']);
    assert.strictEqual(updates['A/b/2026-09'].info.total_entrees, 2);
    assert.strictEqual(updates['A/c/a/last_index'], '20');
    assert.strictEqual(updates['A/c/a/new_index'], 0);
    assert.strictEqual(updates['A/c/b/last_index'], '5');                         // jamais de régression
    assert.strictEqual(updates['A/c/a/status'], 'impaye');
    Object.keys(updates).forEach(k => {
        assert.ok(k.startsWith('A/b/2026-09') || k.startsWith('A/c/'), k);
        assert.ok(!/\/(apaid|arriere|arrieres|facture|print|diff|arrieres_regles|cycles_regles|arrieres_ajustement)$/.test(k), 'champ historique écrit : ' + k);
    });
});

// ── Consommation inhabituelle ────────────────────────────────
test('consommation inhabituelle : > 100 m³ seulement (seuil exclu), index qui recule ou non relevé jamais', () => {
    assert.strictEqual(Billing.CONSO_INHABITUELLE_M3, 100);
    assert.strictEqual(Billing.isUnusualConsumption({ last_index: '10', new_index: 111 }), true);     // 101 m³
    assert.strictEqual(Billing.isUnusualConsumption({ last_index: '10', new_index: 110 }), false);    // 100 m³ pile
    assert.strictEqual(Billing.isUnusualConsumption({ last_index: 500, new_index: 50 }), false);      // index qui recule
    assert.strictEqual(Billing.isUnusualConsumption({ last_index: '300', new_index: 0 }), false);     // non relevé
    assert.strictEqual(Billing.isUnusualConsumption({}), false);
    assert.strictEqual(Billing.isUnusualConsumption(null), false);
});

test('consommation inhabituelle : reste FACTURÉE normalement, dans le mois comme dans les arriérés', () => {
    const rec = { numero_compteur: '1', zone: 'N', last_index: '0', new_index: 150, facteur: 250, status: 'impaye' };
    assert.strictEqual(Billing.computeCurrent(rec).montant, 37500);
    const idx = Billing.indexBackups({ '2026-08': { donnees: { a: rec } } });
    assert.strictEqual(Billing.computeArrears({ numero_compteur: '1', zone: 'N' }, idx, { fbKey: 'a' }).arriere, 37500);
});

// ── Bilan ────────────────────────────────────────────────────
console.log('\n' + passed + ' test(s) réussi(s), ' + failures.length + ' échec(s).');
if (failures.length > 0) process.exit(1);
