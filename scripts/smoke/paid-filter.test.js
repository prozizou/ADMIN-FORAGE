'use strict';
const assert = require('node:assert/strict');
const Compta = require('../../compta.js');
const { server, newPage, seed, migratedSeed, FA, chromium } = require('./smoke.test.js');
const basePath = 'Asufor/' + FA;
const paths = Compta.pathsFor(basePath);
const user = {uid:'u1',nom:'Président',role:'président'};
let sequence = 0;
const newId = () => 'filter-' + (++sequence);
function apply(tree, updates) {
    for (const [path, value] of Object.entries(updates)) {
        const parts = path.split('/'); let node = tree;
        for (const part of parts.slice(0,-1)) node = node[part] ||= {};
        if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = value;
    }
}
function pay(tree, cid, montant) {
    const f = tree.Asufor[FA];
    apply(tree, Compta.buildPaymentOps({...Compta.emptyState(), ...f}, {
        paths, compteurId:cid, montant, mode:'especes', numero_recu:newId(), releve:f.compteurs[cid],
        user, now:new Date().toISOString(), newId
    }).updates);
}
const ids = page => page.locator('#releves-list > [data-counter-id]').evaluateAll(cards => cards.map(card => card.dataset.counterId).sort());
async function open(browser, tree, base) {
    const result = await newPage(browser, 'président', tree);
    await result.page.goto(base + '/statistiques/stats.html');
    await result.page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
    return result;
}
(async () => {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox']});
    try {
        const tree = migratedSeed();
        const f = tree.Asufor[FA];
        f.compteurs.c2.new_index = 0; // anciennes factures réglées, aucun relevé ce mois
        f.compteurs.credit = {...f.compteurs.c2,name:'Avance sans relevé',numero_compteur:'4'};
        f.compteurs.invalid = {...f.compteurs.c2,name:'Index à corriger',numero_compteur:'5',new_index:9};
        f.compteurs.empty = {...f.compteurs.c2,name:'Nouveau compteur',numero_compteur:'6',last_index:0,new_index:0};
        f.compteurs.partial = {...f.compteurs.c3,name:'Facture partielle',numero_compteur:'7',status:'impaye',statut:false};
        pay(tree,'c1',7500); pay(tree,'c2',1500); pay(tree,'credit',500); pay(tree,'invalid',500); pay(tree,'partial',500);
        const {page,ctx,errors} = await open(browser,tree,base);
        await page.click('#tab-paye');
        assert.deepEqual(await ids(page), ['c1'], 'Payés exige un relevé valide de la période, pas seulement un compte anciennement soldé ou une avance');
        await page.click('#chip-non-releves');
        assert.deepEqual(await ids(page), [], 'Payés + À relever ne doit jamais afficher de facture');
        await page.click('#chip-releves');
        assert.deepEqual(await ids(page), ['c1']);
        await page.click('#chip-all');
        await page.click('#tab-impaye');
        assert.deepEqual(await ids(page), ['c3','partial'], 'une facture partielle reste impayée');
        await page.click('#tab-all');
        assert.equal((await ids(page)).length,7, 'les compteurs non relevés restent consultables dans Tous');
        await page.click('#tab-paye');
        await page.evaluate(() => { window.__DB.tree.Asufor.Asufor_a.compteurs.c1.new_index=0; window.__DB.listeners.slice().forEach(fn=>fn()); });
        await page.waitForFunction(() => !document.querySelector('[data-counter-id="c1"]'));
        await page.evaluate(() => { window.__DB.tree.Asufor.Asufor_a.compteurs.c1.new_index=30; window.__DB.listeners.slice().forEach(fn=>fn()); });
        await page.waitForSelector('[data-counter-id="c1"]');
        assert.deepEqual(await ids(page),['c1']);
        assert.deepEqual(errors,[]);
        assert.equal(await page.evaluate(() => window.__DB.writes.length),0);
        console.log('✓ Payés : seul le relevé soldé apparaît ; historiques réglés, avances sans relevé, index invalides et paiements partiels exclus ; mises à jour en direct');
        await ctx.close();

        const legacy = seed();
        legacy.Asufor[FA].compteurs.c2 = {...legacy.Asufor[FA].compteurs.c2,new_index:0,status:'paye',statut:true};
        legacy.Asufor[FA].compteurs.invalid = {...legacy.Asufor[FA].compteurs.c3,last_index:10,new_index:9};
        legacy.Asufor[FA].backup['2026-06'].donnees.unread = {...legacy.Asufor[FA].compteurs.c2};
        const old = await open(browser,legacy,base);
        await old.page.selectOption('#month-filter','__archives__');
        await old.page.waitForFunction(() => document.querySelector('#month-filter option[value="2026-06"]'));
        await old.page.selectOption('#month-filter','actuel');
        await old.page.waitForFunction(() => !document.getElementById('tab-paye').disabled);
        await old.page.click('#tab-paye');
        assert.deepEqual(await ids(old.page),['c3'], 'les anciens indicateurs payé ne suffisent pas sans relevé valide');
        await old.page.selectOption('#month-filter','2026-06');
        await old.page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
        assert.deepEqual(await ids(old.page),['c2'], 'les factures historiques payées restent visibles, sans les archives non relevées');
        assert.deepEqual(old.errors,[]);
        await old.ctx.close();
        console.log('✓ anciens statuts et archives : une facture payée exige aussi un relevé valide pour le mois sélectionné');

        const archived = migratedSeed();
        const af = archived.Asufor[FA];
        af.migration_comptable.v1.dernier_cycle = '2026-06';
        pay(archived,'c2',1500);
        apply(archived,Compta.buildAdjustmentOps({...Compta.emptyState(),...af},{
            paths,factureId:'2026-07_c1',type:'annulation',motif:'Facture créée par erreur',
            user,valider:true,now:new Date().toISOString(),newId
        }).updates);
        af.backup['2026-07'].donnees.missing = {...af.compteurs.c3,name:'Sans facture ce mois'};
        const archive = await open(browser,archived,base);
        await archive.page.selectOption('#month-filter','__archives__');
        await archive.page.waitForFunction(() => document.getElementById('month-filter').value === '2026-07' && document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
        await archive.page.click('#tab-paye');
        assert.deepEqual(await ids(archive.page),['c2'], 'une facture annulée ou absente ne devient pas une facture payée');
        await archive.page.click('#tab-all');
        assert.deepEqual(await ids(archive.page),['c1','c2','missing']);
        assert.deepEqual(archive.errors,[]);
        await archive.ctx.close();
        console.log('✓ archives comptables : factures réglées incluses ; factures annulées et absentes exclues de Payés');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
