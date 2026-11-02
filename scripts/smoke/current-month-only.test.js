'use strict';
const assert = require('node:assert/strict');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const archiveReads = page => page.evaluate(root => ({
    get: window.__DB.reads.filter(path => path === root + '/backup' || path.startsWith(root + '/backup/')),
    listen: (window.__DB.onValuePaths || []).filter(path => path === root + '/backup' || path.startsWith(root + '/backup/'))
}), root);

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        const { page, ctx, errors } = await newPage(browser, 'président', migratedSeed());
        await page.addInitScript(root => {
            window.__ASUFOR_SYNC = { debounce: 5, sourceWatchdog: 100, hydrate: 3000 };
            window.__DB.hang = [root + '/backup']; window.__DB.hangListen = [root + '/backup'];
        }, root);
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false', {}, { timeout: 3000 });
        assert.equal(await page.locator('#month-filter').inputValue(), 'actuel');
        assert.deepEqual(await archiveReads(page), { get: [], listen: [] });
        assert.equal(await page.locator('#total-debt').innerText().then(s => s.replace(/\D/g, '')), '10500');
        for (const reason of ['manual', 'visible', 'reconnect', 'recovery']) await page.evaluate(reason => window.AsuforSync.resync(reason, { force: true }), reason);
        assert.deepEqual(await archiveReads(page), { get: [], listen: [] }, 'les reprises ne chargent pas les archives');
        console.log('✓ démarrage et reprises : mois courant chargé, aucune lecture des archives');

        await page.selectOption('#month-filter', '__archives__');
        await page.waitForFunction(() => window.asuforDiagnostics().sources.archives?.status === 'slow');
        assert.equal((await archiveReads(page)).listen.length, 1);
        assert.equal(await page.locator('#month-filter').inputValue(), 'actuel');
        assert.equal(await page.locator('#total-debt').innerText().then(s => s.replace(/\D/g, '')), '10500');
        console.log('✓ demande explicite d’archives lentes : le mois courant reste disponible');
        await page.locator('#archives-status button').last().click();
        await page.waitForFunction(() => document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
        await page.evaluate(() => { window.__DB.hangListen = []; window.__DB.listeners.slice().forEach(fn => fn()); });
        assert.equal(await page.locator('#month-filter').inputValue(), 'actuel', 'une demande annulée ne navigue pas tardivement vers les archives');
        assert.equal(await page.locator('#archives-status').isHidden(), true);
        await page.selectOption('#month-filter', '__archives__');
        await page.waitForFunction(() => document.getElementById('month-filter').value !== 'actuel');
        await page.waitForFunction(() => document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#archive-banner').evaluate(el => el.classList.contains('visible')), true);
        await page.selectOption('#month-filter', 'actuel');
        await page.waitForFunction(() => document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
        const count = (await archiveReads(page)).listen.length;
        await page.evaluate(() => window.AsuforSync.resync('visible', { force: true }));
        assert.equal((await archiveReads(page)).listen.length, count, 'retour au mois courant : aucune réouverture des archives');
        assert.deepEqual(errors, []);
        console.log('✓ navigation dans les archives puis retour au mois courant, sans téléchargement en arrière-plan');
        await ctx.close();

        // Un reçu d'octobre ne fait pas partie du bilan de novembre, même sans nouvelle clôture.
        {
            const tree = migratedSeed();
            const forage = tree.Asufor[FA];
            for (const counter of Object.values(forage.compteurs)) counter.new_index = 0;
            forage.audit_comptable = { oldClosure:{action:'CLOTURE_EFFECTUEE',date:'2026-10-01T00:00:00Z'} };
            forage.paiements = { old:{paiement_id:'old',compteur_id:'c2',montant:45000,statut:'valide',date_paiement:'2026-10-31T23:59:59.999Z'} };
            const {page,ctx,errors} = await newPage(browser,'président',tree);
            await page.setViewportSize({width:390,height:780});
            await page.clock.setFixedTime(new Date('2026-11-02T12:00:00Z'));
            await page.addInitScript(root => { window.__DB.hangListen=[root+'/audit_comptable']; },root);
            await page.goto(base+'/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('#total-money').innerText(),'0 CFA');
            assert.match(await page.locator('#rc-source').innerText(),/novembre 2026/);
            assert.equal(await page.locator('#show-receipts').innerText(),'Voir les versements (0)');
            await page.click('#tab-paye');
            assert.equal(await page.locator('#releves-list > .item').count(),0);
            const initial = await page.evaluate(() => ({reads:window.__DB.reads.length,listens:window.__DB.onValuePaths.length}));
            await page.click('#show-receipts');
            assert.match(await page.locator('.receipt-list').innerText(),/Aucun versement/);
            await page.evaluate(() => {
                window.__initialDocument=document;
                const f=window.__DB.tree.Asufor.Asufor_a;
                f.paiements.boundary={paiement_id:'boundary',compteur_id:'c1',client:'<img src=x onerror=alert(1)>',montant:1000,statut:'valide',date_paiement:'2026-11-01T00:00:00.000Z'};
                f.affectations ||= {};
                f.affectations.boundary={'2026-06_c1':{montant:1000,statut:'valide',date:'2026-11-01T00:00:00.000Z'}};
                f.paiements.cancelled={paiement_id:'cancelled',compteur_id:'c1',montant:7000,statut:'annule',date_paiement:'2026-11-01T08:00:00Z'};
                f.paiements.future={paiement_id:'future',compteur_id:'c1',montant:9000,statut:'valide',date_paiement:'2026-11-03T00:00:00Z'};
                f.paiements.invalid={paiement_id:'invalid',compteur_id:'c1',montant:5000,statut:'valide',date_paiement:'date inconnue'};
                window.__DB.listeners.slice().forEach(fn=>fn());
            });
            await page.waitForFunction(() => document.getElementById('total-money').textContent.replace(/\D/g,'') === '1000');
            assert.match(await page.locator('.receipt-total').innerText(),/1 versement.*1[\s\u202f\xa0]000 F/);
            assert.equal(await page.locator('.receipt-list li').count(),1);
            assert.match(await page.locator('.receipt-list').innerText(),/1 novembre 2026/);
            assert.match(await page.locator('.receipt-list').innerText(),/<img src=x onerror=alert\(1\)>/);
            assert.equal(await page.locator('.receipt-list img').count(),0);
            for (const width of [320,390,768]) {
                await page.setViewportSize({width,height:780});
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                assert.ok(await page.locator('.cui-box').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
            }
            await page.screenshot({path:'/tmp/current-month-receipts-768.png'});

            assert.equal(await page.locator('#releves-list > .item').count(),0,'un versement partiel ne fabrique pas de relevé ni de facture soldée');
            await page.evaluate(() => { window.__DB.tree.Asufor.Asufor_a.paiements.boundary.statut='annule'; window.__DB.listeners.slice().forEach(fn=>fn()); });
            await page.waitForFunction(() => document.getElementById('total-money').textContent === '0 CFA');
            assert.match(await page.locator('.receipt-list').innerText(),/Aucun versement/);
            await page.locator('#close-receipts').press('Escape');
            assert.equal(await page.locator('.receipt-list').count(),0);
            assert.equal(await page.evaluate(() => document===window.__initialDocument),true);
            assert.deepEqual(await page.evaluate(() => ({reads:window.__DB.reads.length,listens:window.__DB.onValuePaths.length})),initial);
            assert.deepEqual(await archiveReads(page),{get:[],listen:[]});
            assert.equal(await page.evaluate(root => window.__DB.onValuePaths.filter(p=>p===root+'/audit_comptable').length,root),0);
            assert.equal(await page.evaluate(() => window.__DB.writes.length),0);
            assert.deepEqual(errors,[]);
            console.log('✓ octobre 45 000 F, novembre sans versement = 0 F ; borne de minuit incluse, versement partiel détaillé, annulation en direct, dates futures/invalides exclues, aucun chargement des archives ou du journal');
            await ctx.close();
        }
        // La page ouverte traverse le changement de mois sans rechargement ni nouvelle écoute.
        {
            const tree=migratedSeed();
            tree.Asufor[FA].paiements={november:{compteur_id:'c1',montant:45000,statut:'valide',date_paiement:'2026-11-30T12:00:00Z'}};
            const {page,ctx,errors}=await newPage(browser,'président',tree);
            await page.clock.install({time:new Date('2026-11-30T23:59:58Z')});
            await page.goto(base+'/statistiques/stats.html');
            await page.clock.runFor(500);
            await page.waitForFunction(() => document.getElementById('total-money')?.textContent.replace(/\D/g,'') === '45000');
            const initial=await page.evaluate(() => {window.__initialDocument=document;return {reads:window.__DB.reads.length,listens:window.__DB.onValuePaths.length};});
            await page.clock.runFor(2000);
            await page.waitForFunction(() => document.getElementById('total-money')?.textContent === '0 CFA');
            assert.match(await page.locator('#rc-source').innerText(),/décembre 2026/);
            assert.equal(await page.evaluate(() => document===window.__initialDocument),true);
            assert.deepEqual(await page.evaluate(() => ({reads:window.__DB.reads.length,listens:window.__DB.onValuePaths.length})),initial);
            assert.deepEqual(errors,[]);
            console.log('✓ passage novembre → décembre : encaissé remis à zéro automatiquement, page et abonnements conservés');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
