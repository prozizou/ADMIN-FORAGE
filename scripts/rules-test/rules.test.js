/**
 * rules.test.js — Vérifie database.rules.json sur le Firebase Emulator (Realtime Database)
 *
 * Exécution (depuis scripts/rules-test/) :  npm install && npm test
 *   → lance l'émulateur, exécute ces tests, l'arrête. Aucune donnée réelle n'est touchée
 *     (projet « demo-asufor », base en mémoire).
 *
 * Couvre : isolation des comptes par forage, accès legacy restreints, régularisation
 * (trésorier) sur les archives, clôture atomique (create-only), numérotation (secrétaire),
 * et la non-régression des accès existants.
 */
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('node:test');
const {
    initializeTestEnvironment,
    assertSucceeds,
    assertFails
} = require('@firebase/rules-unit-testing');

const Billing = require('../../billing.js');
const Compta = require('../../compta.js');
// RULES_FILE permet de rejouer la suite contre d'autres règles (ex. l'ancienne version, pour vérifier que les tests détectent bien les défauts).
const RULES = fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');

const SUPER = 'prozizou298@gmail.com';
const FA = 'Asufor_a';
const FB = 'Asufor_b';
const DIA = 'Asufor_diandioly';

let env;

// uid → { email, role, forageKey } (fiches users/{uid}, lues par les règles)
const USERS = {
    presA:  { role: 'président',  forageKey: FA, login: '771111111' },
    pres2A: { role: 'président',  forageKey: FA, login: '772222222' },
    secA:   { role: 'secrétaire', forageKey: FA, login: '773333333' },
    tresA:  { role: 'trésorier',  forageKey: FA, login: '774444444' },
    presB:  { role: 'président',  forageKey: FB, login: '781111111' },
    secB:   { role: 'secrétaire', forageKey: FB, login: '783333333' },
    tresB:  { role: 'trésorier',  forageKey: FB, login: '784444444' },
    diaPres:{ role: 'président',  forageKey: DIA, login: '791111111' }
};

const rec = (over) => Object.assign({
    name: 'Client', numero_compteur: '1', zone: 'N', last_index: '0', new_index: 10,
    facteur: 250, status: 'impaye', statut: false
}, over || {});

function seed() {
    return {
        users: USERS,
        Asufor: {
            [FA]: {
                config: { nom: 'Forage A', next_counter_number: 5 },
                compteurs: { c1: rec() },
                backup: { '2026-06': { info: { cycle: '2026-06' }, donnees: { c1: rec({ new_index: 20 }) } } },
                audit_arrieres: { e1: { compteurKey: 'c1' } },
                team: { presA: { role: 'président', nom: 'A' } }
            },
            [FB]: {
                config: { nom: 'Forage B' },
                compteurs: { d1: rec({ name: 'Autre' }) },
                backup: { '2026-06': { info: { cycle: '2026-06' }, donnees: { d1: rec() } } },
                audit_arrieres: { e2: { compteurKey: 'd1' } }
            }
        },
        // nœuds legacy (Diandioly avant migration)
        asufor_db_diandioly: { x: rec({ name: 'Legacy' }) },
        db_agents: { g: { agent: 'Agent', agent_tel: '771234567', zone: 'Z', passcode_hash: 'a'.repeat(64) } },
        asufor_backup: { '2026-05': { donnees: { x: rec() } } },
        asufor_depenses: { '2026-05': { d: { libelle: 'l', montant: 1 } } },
        asufor_motivations: { '2026-05': { m: { beneficiaire: 'b', montant: 1 } } }
    };
}

const as = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).database();
const anon = () => env.unauthenticatedContext().database();
const superDb = () => as('superuid', SUPER);

before(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-asufor', database: { rules: RULES } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
    await env.clearDatabase();
    await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref().set(seed()); });
});

const read = (db, p) => db.ref(p).get();
const raw = async (p) => {
    let out;
    await env.withSecurityRulesDisabled(async (ctx) => { out = (await ctx.database().ref(p).get()).val(); });
    return out === undefined ? null : out;
};

// ─────────────────────────────────────────────────────────────
describe('Isolation des comptes par forage', () => {
    it('un président ne lit que les données de SON forage', async () => {
        await assertSucceeds(read(as('presA'), `Asufor/${FA}/compteurs`));
        await assertFails(read(as('presB'), `Asufor/${FA}/compteurs`));
        await assertFails(read(as('presB'), `Asufor/${FA}/backup`));
        await assertFails(read(anon(), `Asufor/${FA}/compteurs`));
    });

    it('un président ne peut pas réécrire la fiche d\'un utilisateur d\'un autre forage (rattachement forcé)', async () => {
        const hijack = { role: 'secrétaire', forageKey: FB, login: '774444444' };   // tresA rattaché à B
        await assertFails(as('presB').ref('users/tresA').set(hijack));
        assert.deepStrictEqual((await raw('users/tresA')).forageKey, FA);
    });

    it('un président ne peut pas rétrograder/écraser le président d\'un autre forage', async () => {
        await assertFails(as('presB').ref('users/presA').set({ role: 'secrétaire', forageKey: FB }));
        await assertFails(as('presB').ref('users/presA/role').set('secrétaire'));
        await assertFails(as('presB').ref('users/presA').remove());
        assert.strictEqual((await raw('users/presA')).role, 'président');
    });

    it('un président ne peut pas non plus modifier un AUTRE président de son propre forage', async () => {
        await assertFails(as('presA').ref('users/pres2A').set({ role: 'secrétaire', forageKey: FA }));
    });

    it('un président crée et gère les membres de SON forage seulement', async () => {
        await assertSucceeds(as('presB').ref('users/newB').set({ role: 'secrétaire', forageKey: FB, login: '785555555' }));
        await assertFails(as('presB').ref('users/newX').set({ role: 'secrétaire', forageKey: FA, login: '785555556' }));
        await assertFails(as('presB').ref('users/newP').set({ role: 'président', forageKey: FB }));
        // modification d'un membre existant de son forage : OK
        await assertSucceeds(as('presA').ref('users/secA').set({ role: 'trésorier', forageKey: FA, login: '773333333' }));
    });

    it('un membre non-président ne peut écrire aucune fiche users', async () => {
        await assertFails(as('secA').ref('users/newS').set({ role: 'secrétaire', forageKey: FA }));
        await assertFails(as('tresA').ref('users/secA/role').set('président'));
    });

    it('le super-admin garde la main sur tous les forages', async () => {
        await assertSucceeds(read(superDb(), `Asufor/${FA}/compteurs`));
        await assertSucceeds(read(superDb(), `Asufor/${FB}/compteurs`));
        await assertSucceeds(superDb().ref('users/tresA').set({ role: 'trésorier', forageKey: FB, login: '774444444' }));
    });

    it('le journal d\'audit des arriérés est limité au forage du président', async () => {
        await assertSucceeds(read(as('presA'), `Asufor/${FA}/audit_arrieres`));
        await assertFails(read(as('presB'), `Asufor/${FA}/audit_arrieres`));
        await assertSucceeds(read(superDb(), `Asufor/${FA}/audit_arrieres`));
    });

    it('un membre d\'un forage n\'écrit rien dans un autre (compteurs, agents, dépenses, équipe)', async () => {
        await assertFails(as('presB').ref(`Asufor/${FA}/compteurs/c1/status`).set('paye'));
        await assertFails(as('secB').ref(`Asufor/${FA}/compteurs/new`).set(rec()));
        await assertFails(as('tresB').ref(`Asufor/${FA}/depenses/2026-09/d1`).set({ libelle: 'x', montant: 1 }));
        await assertFails(as('presB').ref(`Asufor/${FA}/team/x`).set({ role: 'président', nom: 'x' }));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Accès legacy fermés (v7 : nœuds absents de la base de référence)', () => {
    const LEGACY = ['asufor_db_diandioly', 'db_agents', 'asufor_backup', 'asufor_depenses', 'asufor_motivations'];

    it('personne ne lit un nœud legacy (autre forage, Diandioly, super-admin, anonyme)', async () => {
        for (const n of LEGACY) {
            await assertFails(read(as('presB'), n));
            await assertFails(read(as('presA'), n));
            await assertFails(read(as('diaPres', 'president@diandioly.com'), n));
            await assertFails(read(superDb(), n));
            await assertFails(read(anon(), n));
        }
    });

    it('personne n\'écrit dans un nœud legacy (même avec l\'e-mail historique)', async () => {
        await assertFails(as('diaPres', 'president@diandioly.com').ref('asufor_db_diandioly/x/status').set('paye'));
        await assertFails(as('diaPres', 'president@diandioly.com').ref('asufor_backup/2026-05/donnees/x/status').set('paye'));
        await assertFails(superDb().ref('db_agents/g/zone').set('Z2'));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Comptabilité v7 — opérations réelles (compta.js) sous les règles', () => {
    const CP = Compta.pathsFor(`Asufor/${FA}`);
    let n = 0;
    const newId = () => 'k' + Date.now().toString(36) + '_' + (++n);
    const U = (uid) => ({ uid, nom: uid, role: USERS[uid].role });
    const now = () => new Date().toISOString();
    const S = async () => Compta.normState(await raw(`Asufor/${FA}`) || {});
    const migrate = async (uid) => Compta.buildMigrationOps(await S(), { paths: CP, backup: await raw(`Asufor/${FA}/backup`), now: now(), user: U(uid), newId });
    const payOps = async (uid, montant, over) => Compta.buildPaymentOps(await S(), Object.assign({ paths: CP, compteurId: 'c1', montant, mode: 'especes', numero_recu: 'R-' + (++n), user: U(uid), now: now(), newId }, over || {}));

    it('migration : président seulement, une seule fois ; factures « migration_backup », aucun paiement créé', async () => {
        await assertFails(as('tresA').ref().update((await migrate('tresA')).updates));
        const r = await migrate('presA');
        await assertSucceeds(as('presA').ref().update(r.updates));
        assert.strictEqual(r.resume.total_arrieres, 5000);
        const f = await raw(`${CP.factures}/2026-06_c1`);
        assert.strictEqual(f.source, 'migration_backup'); assert.strictEqual(f.reste_a_payer, 5000);
        assert.strictEqual(await raw(CP.paiements), null);
        assert.strictEqual((await raw(`${CP.migration}/v1`)).statut, 'terminee');
        // rejouer : migration_comptable/v1 existe déjà → refus complet
        const again = await migrate('presA');
        await assertFails(as('presA').ref().update(again.updates));
    });

    it('trésorier : encaissement partiel atomique (paiement + affectation + facture + solde + audit)', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const r = await payOps('tresA', 2000);
        await assertSucceeds(as('tresA').ref().update(r.updates));
        const f = await raw(`${CP.factures}/2026-06_c1`);
        assert.deepStrictEqual([f.statut, f.montant_paye, f.reste_a_payer], ['partielle', 2000, 3000]);
        assert.strictEqual((await raw(`${CP.affectations}/${r.paiementId}/2026-06_c1`)).montant, 2000);
        assert.strictEqual((await raw(`${CP.soldes}/c1`)).arrieres, 3000);
        const audit = Object.values(await raw(CP.audit));
        assert.ok(audit.some(e => e.action === 'PAIEMENT_CREE' && e.utilisateur === 'tresA'));
    });

    it('concurrence : deux encaissements calculés sur le même état → le second est refusé EN ENTIER', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const r1 = await payOps('tresA', 5000);
        const r2 = await payOps('presA', 5000);                 // même état de départ (périmé après r1)
        await assertSucceeds(as('tresA').ref().update(r1.updates));
        await assertFails(as('presA').ref().update(r2.updates));
        assert.strictEqual(await raw(`${CP.paiements}/${r2.paiementId}`), null);
        assert.strictEqual((await raw(`${CP.factures}/2026-06_c1`)).montant_paye, 5000);   // jamais 10 000
    });

    it('paiement validé : ni modification, ni suppression ; annulation motivée par le président uniquement', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const r = await payOps('tresA', 3000);
        await as('tresA').ref().update(r.updates);
        const pp = `${CP.paiements}/${r.paiementId}`;
        await assertFails(as('tresA').ref(`${pp}/montant`).set(1));
        await assertFails(as('presA').ref(`${pp}/montant`).set(1));
        await assertFails(as('presA').ref(pp).remove());
        await assertFails(as('tresA').ref().update((Compta.buildPaymentCancelOps(await S(), { paths: CP, paiementId: r.paiementId, motif: 'Erreur', user: U('tresA'), now: now(), newId })).updates));
        await assertFails(as('presA').ref().update({ [`${pp}/statut`]: 'annule', [`${pp}/annule_par`]: 'presA' }));   // sans motif
        const c = Compta.buildPaymentCancelOps(await S(), { paths: CP, paiementId: r.paiementId, motif: 'Billet refusé', user: U('presA'), now: now(), newId });
        await assertSucceeds(as('presA').ref().update(c.updates));
        const p = await raw(pp);
        assert.deepStrictEqual([p.statut, p.montant], ['annule', 3000]);
        assert.strictEqual((await raw(`${CP.factures}/2026-06_c1`)).reste_a_payer, 5000);
        await assertFails(as('presA').ref(`${pp}/statut`).set('valide'));             // pas de « désannulation »
    });

    it('avance : un paiement supérieur à la dette crée un crédit, utilisé à la clôture suivante', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const r = await payOps('tresA', 7000);
        await as('tresA').ref().update(r.updates);
        assert.strictEqual((await raw(`${CP.soldes}/c1`)).avance, 2000);
        const cl = Compta.buildClosureOps(await S(), { paths: CP, cycleKey: '2026-09', compteurs: await raw(`Asufor/${FA}/compteurs`), now: now(), dateLabel: 'x', user: U('presA'), newId });
        await assertSucceeds(as('presA').ref().update(cl.updates));
        const f = await raw(`${CP.factures}/2026-09_c1`);                             // 10 m³ × 250 = 2 500
        assert.deepStrictEqual([f.montant_initial, f.montant_paye, f.reste_a_payer, f.source], [2500, 2000, 500, 'cloture']);
        assert.strictEqual((await raw(`${CP.soldes}/c1`)).avance, 0);
    });

    it('factures : création président seulement ; champs figés ; le trésorier ne change ni montant net ni statut « annulee »', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const fp = `${CP.factures}/2026-06_c1`;
        const f = await raw(fp);
        await assertFails(as('tresA').ref(`${CP.factures}/2026-07_c1`).set(Object.assign({}, f, { facture_id: '2026-07_c1', cycle: '2026-07', rev: 1 })));
        await assertFails(as('presA').ref().update({ [`${fp}/montant_initial`]: 1, [`${fp}/rev`]: 2 }));
        await assertFails(as('presA').ref().update({ [`${fp}/nouvel_index`]: 99, [`${fp}/rev`]: 2 }));
        await assertFails(as('tresA').ref().update({ [`${fp}/montant_net`]: 0, [`${fp}/reste_a_payer`]: 0, [`${fp}/statut`]: 'payee', [`${fp}/rev`]: 2 }));
        await assertFails(as('presA').ref().update({ [`${fp}/montant_paye`]: 9000, [`${fp}/rev`]: 2 }));   // payé > net, reste incohérent
        await assertFails(as('presA').ref(fp).remove());
        assert.strictEqual((await raw(fp)).montant_initial, 5000);
    });

    it('ajustements : le trésorier propose, seul le président valide ; jamais modifiés ensuite', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const base = { paths: CP, factureId: '2026-06_c1', type: 'remise', montant: 1000, motif: 'Geste commercial', now: now(), newId };
        await assertFails(as('tresA').ref().update(Compta.buildAdjustmentOps(await S(), Object.assign({}, base, { user: U('tresA'), valider: true })).updates));
        const prop = Compta.buildAdjustmentOps(await S(), Object.assign({}, base, { user: U('tresA') }));
        await assertSucceeds(as('tresA').ref().update(prop.updates));
        const ap = `${CP.ajustements}/${prop.ajustementId}`;
        await assertFails(as('tresA').ref().update(Compta.buildAdjustmentValidationOps(await S(), { paths: CP, ajustementId: prop.ajustementId, decision: 'valide', user: U('tresA'), now: now(), newId }).updates));
        await assertFails(as('secA').ref().update(Compta.buildAdjustmentValidationOps(await S(), { paths: CP, ajustementId: prop.ajustementId, decision: 'valide', user: U('secA'), now: now(), newId }).updates));
        const v = Compta.buildAdjustmentValidationOps(await S(), { paths: CP, ajustementId: prop.ajustementId, decision: 'valide', user: U('presA'), now: now(), newId });
        await assertSucceeds(as('presA').ref().update(v.updates));
        assert.strictEqual((await raw(`${CP.factures}/2026-06_c1`)).montant_net, 4000);
        await assertFails(as('presA').ref(`${ap}/montant`).set(5000));
        await assertFails(as('presA').ref(`${ap}/statut`).set('rejete'));
        await assertFails(as('presA').ref(ap).remove());
        // motif obligatoire (écriture directe sans motif refusée)
        await assertFails(as('presA').ref(`${CP.ajustements}/x1`).set({ ajustement_id: 'x1', compteur_id: 'c1', facture_id: '2026-06_c1', type: 'remise', montant: 1, motif: '', cree_par: 'presA', created_at: now(), statut: 'en_attente' }));
    });

    it('secrétaire : aucun droit financier, mais peut résoudre un problème technique sans toucher aux montants', async () => {
        const b = await raw(`Asufor/${FA}/backup`);
        b['2026-06'].donnees.c1.new_index = 150;                                  // surconsommation dans l'archive
        await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref(`Asufor/${FA}/backup`).set(b); });
        await as('presA').ref().update((await migrate('presA')).updates);
        await assertFails(as('secA').ref().update((await payOps('secA', 1000)).updates));
        await assertFails(as('secA').ref().update((await migrate('secA')).updates));
        const fp = `${CP.factures}/2026-06_c1`;
        assert.strictEqual((await raw(fp)).probleme.type, 'surconsommation');
        const res = Compta.buildProblemResolutionOps(await S(), { paths: CP, factureId: '2026-06_c1', motif: 'Fuite réparée', user: U('secA'), now: now(), newId });
        await assertSucceeds(as('secA').ref().update(res.updates));
        const f = await raw(fp);
        assert.strictEqual(f.probleme.resolu, true); assert.strictEqual(f.reste_a_payer, 37500);   // résolu ≠ payé
        await assertFails(as('secA').ref().update({ [`${fp}/montant_paye`]: 37500, [`${fp}/reste_a_payer`]: 0, [`${fp}/statut`]: 'payee', [`${fp}/rev`]: f.rev + 1 }));
    });

    it('affectations et audit : jamais diminués, supprimés, ni écrits au nom d\'un autre', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const r = await payOps('tresA', 2000);
        await as('tresA').ref().update(r.updates);
        const ap = `${CP.affectations}/${r.paiementId}/2026-06_c1`;
        await assertFails(as('tresA').ref(`${ap}/montant`).set(1000));
        await assertFails(as('presA').ref(ap).remove());
        const audits = await raw(CP.audit);
        const eid = Object.keys(audits)[0];
        await assertFails(as('presA').ref(`${CP.audit}/${eid}/action`).set('PAIEMENT_ANNULE'));
        await assertFails(as('presA').ref(`${CP.audit}/${eid}`).remove());
        await assertFails(as('tresA').ref(`${CP.audit}/faux`).set({ action: 'PAIEMENT_CREE', entite: 'paiement', entite_id: 'x', utilisateur: 'presA', role: 'président', date: now() }));
    });

    it('isolation : le trésorier d\'un autre forage ne peut rien encaisser ici ; soldes : cache recalculable par le président', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        await assertFails(as('tresB').ref().update((await payOps('tresB', 1000)).updates));
        await assertFails(read(as('presB'), CP.factures));
        await assertFails(read(as('presB'), CP.paiements));
        const rb = Compta.buildSoldesRebuild(await S(), { paths: CP, now: now() });
        await assertSucceeds(as('presA').ref().update(rb.updates));
        assert.deepStrictEqual(Compta.checkSoldes(await S()), []);
    });

    it('clôture v7 : archive + factures + audit en un seul update ; seconde clôture refusée en entier', async () => {
        await as('presA').ref().update((await migrate('presA')).updates);
        const cl = () => S().then(st => raw(`Asufor/${FA}/compteurs`).then(c => Compta.buildClosureOps(st, { paths: CP, cycleKey: '2026-09', compteurs: c, now: now(), dateLabel: 'x', user: U('presA'), newId })));
        const first = await cl();
        await assertFails(as('tresA').ref().update(first.updates));
        await assertSucceeds(as('presA').ref().update(first.updates));
        assert.strictEqual((await raw(`${CP.factures}/2026-09_c1`)).montant_initial, 2500);
        assert.ok(Object.values(await raw(CP.audit)).some(e => e.action === 'CLOTURE_EFFECTUEE'));
        const second = Compta.buildClosureOps(Compta.emptyState(), { paths: CP, cycleKey: '2026-09', compteurs: { c1: rec({ new_index: 30 }) }, now: now(), dateLabel: 'y', user: U('pres2A'), newId });
        await assertFails(as('pres2A').ref().update(second.updates));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Clôture atomique anti-concurrence', () => {
    async function closureUpdates(cycleKey) {
        const data = await raw(`Asufor/${FA}/compteurs`);
        return Billing.buildClosureUpdates({
            compteursPath: `Asufor/${FA}/compteurs`, backupPath: `Asufor/${FA}/backup`,
            cycleKey, data, dateLabel: '30/09/2026'
        }).updates;
    }

    it('le président clôture : archive créée ET compteurs remis à zéro en un seul update', async () => {
        const u = await closureUpdates('2026-09');
        await assertSucceeds(as('presA').ref().update(u));
        const arch = await raw(`Asufor/${FA}/backup/2026-09`);
        assert.strictEqual(arch.donnees.c1.new_index, 10);       // valeurs AVANT remise à zéro
        assert.strictEqual(arch.info.total_entrees, 1);
        const c1 = await raw(`Asufor/${FA}/compteurs/c1`);
        assert.strictEqual(c1.new_index, 0);
        assert.strictEqual(c1.last_index, '10');
    });

    it('une seconde clôture du même cycle est refusée EN ENTIER : archive non écrasée, compteurs non ré-initialisés', async () => {
        const u1 = await closureUpdates('2026-09');
        await assertSucceeds(as('presA').ref().update(u1));
        const archAvant = await raw(`Asufor/${FA}/backup/2026-09`);

        // l'autre président lit les compteurs restés « en mémoire » AVANT la 1ère clôture
        const u2 = Billing.buildClosureUpdates({
            compteursPath: `Asufor/${FA}/compteurs`, backupPath: `Asufor/${FA}/backup`, cycleKey: '2026-09',
            data: { c1: rec({ new_index: 10 }) }, dateLabel: 'bis'
        }).updates;
        // simule que la base a bougé depuis (nouveau relevé du mois suivant)
        await as('presA').ref(`Asufor/${FA}/compteurs/c1/new_index`).set(3);
        await assertFails(as('pres2A').ref().update(u2));

        assert.deepStrictEqual(await raw(`Asufor/${FA}/backup/2026-09`), archAvant);
        assert.strictEqual((await raw(`Asufor/${FA}/compteurs/c1`)).new_index, 3);   // pas remis à 0 une 2e fois
    });

    it('deux clôtures lancées EN MÊME TEMPS : une seule réussit', async () => {
        const u = await closureUpdates('2026-09');
        const res = await Promise.allSettled([
            as('presA').ref().update(u),
            as('pres2A').ref().update(u)
        ]);
        assert.strictEqual(res.filter(r => r.status === 'fulfilled').length, 1);
        assert.strictEqual(res.filter(r => r.status === 'rejected').length, 1);
    });

    it('archive existante : non écrasable en bloc, mais corrigeable ligne par ligne par le président', async () => {
        const p = `Asufor/${FA}/backup/2026-06`;
        await assertFails(as('presA').ref(p).set({ info: {}, donnees: { c1: rec({ new_index: 0 }) } }));
        await assertFails(as('presA').ref(p).remove());
        await assertFails(as('presA').ref(`${p}/donnees/c1`).remove());
        await assertSucceeds(as('presA').ref(`${p}/donnees/c1/new_index`).set(25));
        await assertSucceeds(as('presA').ref(`${p}/donnees/c1/arrieres_ajustement`).set(-500));
        assert.strictEqual((await raw(`${p}/donnees/c1`)).new_index, 25);
    });

    it('ni secrétaire, ni trésorier, ni autre forage ne peuvent créer d\'archive', async () => {
        const u = await closureUpdates('2026-09');
        await assertFails(as('secA').ref().update(u));
        await assertFails(as('tresA').ref().update(u));
        await assertFails(as('presB').ref().update(u));
        assert.strictEqual(await raw(`Asufor/${FA}/backup/2026-09`), null);
    });

    it('le super-admin peut restaurer/recréer une archive (secours)', async () => {
        await assertSucceeds(superDb().ref(`Asufor/${FA}/backup/2026-06`).set({ info: { cycle: '2026-06' }, donnees: { c1: rec() } }));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Numérotation des compteurs (secrétaire)', () => {
    const cfg = `Asufor/${FA}/config`;

    it('le secrétaire incrémente le numéro (transaction, comme counter/list.html)', async () => {
        const res = await assertSucceeds(as('secA').ref(`${cfg}/next_counter_number`).transaction(cur => (typeof cur === 'number' && cur > 0 ? cur : 1) + 1));
        assert.strictEqual(res.committed, true);
        assert.strictEqual(await raw(`${cfg}/next_counter_number`), 6);
    });

    it('le secrétaire ne peut ni faire reculer le numéro, ni écrire une valeur invalide', async () => {
        const db = as('secA');
        await assertFails(db.ref(`${cfg}/next_counter_number`).set(2));
        await assertFails(db.ref(`${cfg}/next_counter_number`).set('7'));
        await assertFails(db.ref(`${cfg}/next_counter_number`).set(0));
        await assertSucceeds(db.ref(`${cfg}/next_counter_number`).set(5));    // égal : accepté
        assert.strictEqual(await raw(`${cfg}/next_counter_number`), 5);
    });

    it('le secrétaire n\'écrit aucun AUTRE champ de config (réservé au président)', async () => {
        await assertFails(as('secA').ref(`${cfg}/nom`).set('Piraté'));
        await assertFails(as('secA').ref(`${cfg}/maintenance_passcode_hash`).set('a'.repeat(64)));
        await assertFails(as('secA').ref(cfg).update({ next_counter_number: 6, nom: 'x' }));
    });

    it('trésorier, secrétaire d\'un autre forage et anonymes ne peuvent pas numéroter', async () => {
        await assertFails(as('tresA').ref(`${cfg}/next_counter_number`).set(9));
        await assertFails(as('secB').ref(`${cfg}/next_counter_number`).set(9));
        await assertFails(anon().ref(`${cfg}/next_counter_number`).set(9));
    });

    it('le président garde tous ses droits sur la config (y compris réinitialiser le numéro)', async () => {
        await assertSucceeds(as('presA').ref(`${cfg}/next_counter_number`).set(1));
        await assertSucceeds(as('presA').ref(`${cfg}/nom`).set('Forage A bis'));
    });

    it('le secrétaire enregistre bien un compteur (création) puis le numéro suivant', async () => {
        await assertSucceeds(as('secA').ref(`Asufor/${FA}/compteurs/nouveau`).set(rec({ numero_compteur: '5' })));
        await assertSucceeds(as('secA').ref(`${cfg}/next_counter_number`).set(6));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Non-régression des accès existants', () => {
    it('lecture : tout membre lit son forage (compteurs, archives, config)', async () => {
        for (const u of ['presA', 'secA', 'tresA']) {
            await assertSucceeds(read(as(u), `Asufor/${FA}/compteurs`));
            await assertSucceeds(read(as(u), `Asufor/${FA}/backup`));
            await assertSucceeds(read(as(u), `Asufor/${FA}/config/next_counter_number`));
        }
    });

    it('compteurs : création président/secrétaire, mise à jour aussi par le trésorier', async () => {
        await assertSucceeds(as('presA').ref(`Asufor/${FA}/compteurs/n1`).set(rec()));
        await assertSucceeds(as('secA').ref(`Asufor/${FA}/compteurs/n2`).set(rec()));
        await assertFails(as('tresA').ref(`Asufor/${FA}/compteurs/n3`).set(rec()));
        await assertSucceeds(as('tresA').ref(`Asufor/${FA}/compteurs/c1/status`).set('paye'));
    });

    it('dépenses / motivations : président et trésorier ; ancien journal audit_arrieres en lecture seule', async () => {
        const dep = { libelle: 'Carburant', montant: 1000 };
        await assertSucceeds(as('tresA').ref(`Asufor/${FA}/depenses/2026-09/d1`).set(dep));
        await assertFails(as('secA').ref(`Asufor/${FA}/depenses/2026-09/d2`).set(dep));
        const audit = { compteurKey: 'c1', compteur: '1', proprietaire: 'x', zone: 'N', ancienArrieres: 0, nouveauArrieres: 5, modifiePar: 'a', modifieRole: 'r', modifieLe: 't', sessionForage: FA };
        await assertFails(as('tresA').ref(`Asufor/${FA}/audit_arrieres/e9`).set(audit));
        await assertFails(as('presA').ref(`Asufor/${FA}/audit_arrieres/e9`).set(audit));
    });

    it('agents : président/secrétaire seulement', async () => {
        const ag = { agent: 'Agent', agent_tel: '771234567', zone: 'Z', passcode_hash: 'b'.repeat(64) };
        await assertSucceeds(as('secA').ref(`Asufor/${FA}/agents/a1`).set(ag));
        await assertFails(as('tresA').ref(`Asufor/${FA}/agents/a2`).set(ag));
    });

    it('la racine reste fermée : rien n\'est lisible ni inscriptible hors des nœuds déclarés', async () => {
        await assertFails(read(as('presA'), 'users'));
        await assertFails(as('presA').ref().get());
        await assertFails(as('presA').ref('inconnu').set(1));
    });
});
