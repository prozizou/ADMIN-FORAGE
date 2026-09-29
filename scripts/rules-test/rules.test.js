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
describe('Accès legacy restreints', () => {
    const LEGACY = ['asufor_db_diandioly', 'db_agents', 'asufor_backup', 'asufor_depenses', 'asufor_motivations'];

    it('un compte d\'un autre forage ne lit plus aucun nœud legacy', async () => {
        for (const n of LEGACY) {
            await assertFails(read(as('presB'), n));
            await assertFails(read(as('presA'), n));
            await assertFails(read(anon(), n));
        }
    });

    it('lecture legacy : membre du forage Asufor_diandioly ou super-admin', async () => {
        for (const n of LEGACY) {
            await assertSucceeds(read(as('diaPres', 'president@diandioly.com'), n));
            await assertSucceeds(read(superDb(), n));
        }
    });

    it('écriture legacy : e-mail historique ET membre de Diandioly (un homonyme d\'un autre forage est refusé)', async () => {
        await assertSucceeds(as('diaPres', 'president@diandioly.com').ref('asufor_db_diandioly/x/status').set('paye'));
        // même e-mail mais fiche users d'un AUTRE forage → refus
        await assertFails(as('presB', 'president@diandioly.com').ref('asufor_db_diandioly/x/status').set('paye'));
        await assertFails(as('presB', 'president@diandioly.com').ref('asufor_backup/2026-05/donnees/x/status').set('paye'));
        // membre de Diandioly mais sans e-mail historique → refus
        await assertFails(as('diaPres', 'autre@asufor.local').ref('asufor_db_diandioly/x/status').set('paye'));
    });
});

// ─────────────────────────────────────────────────────────────
describe('Régularisation par le trésorier (archives)', () => {
    const payFields = (cycle, key, status) => ({
        [`Asufor/${FA}/backup/${cycle}/donnees/${key}/status`]: status,
        [`Asufor/${FA}/backup/${cycle}/donnees/${key}/statut`]: status === 'paye',
        [`Asufor/${FA}/backup/${cycle}/donnees/${key}/date_paiement`]: status === 'paye' ? '2026-09-01T00:00:00Z' : null,
        [`Asufor/${FA}/backup/${cycle}/donnees/${key}/last_modified_by`]: 'trésorier',
        [`Asufor/${FA}/backup/${cycle}/donnees/${key}/last_modified_at`]: '2026-09-01T00:00:00Z'
    });

    it('le trésorier encaisse en cascade (base active + archives) avec le vrai buildPaymentUpdates', async () => {
        const backups = await raw(`Asufor/${FA}/backup`);
        const cpt = await raw(`Asufor/${FA}/compteurs`);
        const r = Billing.buildPaymentUpdates({
            activePath: `Asufor/${FA}/compteurs`, activeKey: 'c1', record: cpt.c1,
            indexedBackups: Billing.indexBackups(backups), backupPath: `Asufor/${FA}/backup`,
            currentKeys: { c1: true }, paidBy: 'trésorier', timestamp: '2026-09-01T00:00:00Z'
        });
        assert.ok(r.cyclesRegularises.includes('2026-06'));
        await assertSucceeds(as('tresA').ref().update(r.updates));
        const after = await raw(`Asufor/${FA}/backup/2026-06/donnees/c1`);
        assert.strictEqual(after.status, 'paye');
        assert.strictEqual(after.new_index, 20);                 // index intacts
        const act = await raw(`Asufor/${FA}/compteurs/c1`);
        assert.strictEqual(act.status, 'paye');
        assert.strictEqual(act.arrieres_regles, r.arrieresRegles);
        assert.deepStrictEqual(act.cycles_regles, ['2026-06|c1']);
    });

    it('le trésorier peut corriger le paiement (révocation qui remet les archives à impayé)', async () => {
        await as('presA').ref().update(payFields('2026-06', 'c1', 'paye'));
        const cpt = await raw(`Asufor/${FA}/compteurs`);
        const paid = Object.assign({}, cpt.c1, { status: 'paye', statut: true, cycles_regles: ['2026-06|c1'], arrieres_regles: 5000 });
        const r = Billing.buildRevokeUpdates({
            activePath: `Asufor/${FA}/compteurs`, activeKey: 'c1', record: paid,
            indexedBackups: Billing.indexBackups(await raw(`Asufor/${FA}/backup`)), backupPath: `Asufor/${FA}/backup`
        });
        assert.deepStrictEqual(r.cyclesRestaures, ['2026-06']);
        await assertSucceeds(as('tresA').ref().update(r.updates));
        assert.strictEqual((await raw(`Asufor/${FA}/backup/2026-06/donnees/c1`)).status, 'impaye');
    });

    it('le trésorier ne peut PAS toucher aux index/données d\'une archive, ni la créer/supprimer', async () => {
        const db = as('tresA');
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/new_index`).set(999));
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/facteur`).set(1));
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1`).remove());
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06`).remove());
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-07`).set({ donnees: { c1: rec() } }));
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/nouveau/status`).set('paye'));   // ligne inexistante
        assert.strictEqual((await raw(`Asufor/${FA}/backup/2026-06/donnees/c1`)).new_index, 20);
    });

    it('valeurs de paiement contrôlées (statut ∈ paye/impaye, booléen, chaînes)', async () => {
        const db = as('tresA');
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/status`).set('gratuit'));
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/statut`).set('true'));
        await assertFails(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/date_paiement`).set(12));
        await assertSucceeds(db.ref(`Asufor/${FA}/backup/2026-06/donnees/c1/status`).set('paye'));
    });

    it('le trésorier d\'un autre forage, le secrétaire et les anonymes n\'ont pas ce droit', async () => {
        await assertFails(as('tresB').ref().update(payFields('2026-06', 'c1', 'paye')));
        await assertFails(as('secA').ref().update(payFields('2026-06', 'c1', 'paye')));
        await assertFails(anon().ref().update(payFields('2026-06', 'c1', 'paye')));
        await assertSucceeds(as('presA').ref().update(payFields('2026-06', 'c1', 'paye')));
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
        // mémoire de règlement et ajustements : champs libres du relevé
        await assertSucceeds(as('tresA').ref(`Asufor/${FA}/compteurs/c1/arrieres_regles`).set(5000));
        await assertSucceeds(as('secA').ref(`Asufor/${FA}/compteurs/c1/arrieres_ajustement`).set(-100));
    });

    it('dépenses / motivations : président et trésorier ; audit : écriture de tout membre du forage', async () => {
        const dep = { libelle: 'Carburant', montant: 1000 };
        await assertSucceeds(as('tresA').ref(`Asufor/${FA}/depenses/2026-09/d1`).set(dep));
        await assertFails(as('secA').ref(`Asufor/${FA}/depenses/2026-09/d2`).set(dep));
        const audit = { compteurKey: 'c1', compteur: '1', proprietaire: 'x', zone: 'N', ancienArrieres: 0, nouveauArrieres: 5, modifiePar: 'a', modifieRole: 'r', modifieLe: 't', sessionForage: FA };
        await assertSucceeds(as('tresA').ref(`Asufor/${FA}/audit_arrieres/e9`).set(audit));
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
