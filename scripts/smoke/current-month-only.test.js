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

        // La dernière clôture est plus ancienne que la première page du journal.
        {
            const tree = migratedSeed();
            const forage = tree.Asufor[FA];
            const closure = Date.now() - 86400e3;
            const key = n => '-' + String(n).padStart(19, '0');
            forage.audit_comptable = {};
            forage.audit_comptable[key(1)] = { action: 'CLOTURE_EFFECTUEE', date: new Date(closure).toISOString() };
            for (let i = 2; i < 80; i++) forage.audit_comptable[key(i)] = { action: 'PAIEMENT_CREE', date: new Date(closure + i * 1000).toISOString() };
            forage.paiements = {
                before: { compteur_id: 'c1', montant: 100, statut: 'valide', date_paiement: new Date(closure - 1000).toISOString() },
                boundary: { compteur_id: 'c1', montant: 200, statut: 'valide', date_paiement: new Date(closure).toISOString() },
                after: { compteur_id: 'c1', montant: 300, statut: 'valide', date_paiement: new Date(closure + 1000).toISOString() }
            };
            const { page, ctx, errors } = await newPage(browser, 'président', tree);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('total-money')?.textContent.replace(/\D/g, '') === '300');
            assert.equal(await page.evaluate(() => window.asuforDiagnostics().cycleStartKnown), true);
            assert.deepEqual(await archiveReads(page), { get: [], listen: [] });
            assert.equal(await page.evaluate(root => window.__DB.onValuePaths.filter(path => path === root + '/audit_comptable').length, root), 2);
            // Une clôture vide doit aussi remettre la période à zéro, sans nouvelle facture.
            await page.evaluate(([root, key, date]) => {
                window.__DB.tree.Asufor.Asufor_a.audit_comptable[key] = { action: 'CLOTURE_EFFECTUEE', date };
                window.__DB.listeners.slice().forEach(fn => fn());
            }, [root, key(80), new Date(closure + 120000).toISOString()]);
            await page.waitForFunction(() => document.getElementById('total-money')?.textContent === '0 CFA');
            assert.deepEqual(await archiveReads(page), { get: [], listen: [] });
            assert.deepEqual(errors, []);
            console.log('✓ encaissé depuis la dernière clôture : pagination du journal, borne exacte et clôture vide reçue en direct');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => { window.__DB.hangListen = [root + '/audit_comptable']; window.__ASUFOR_SYNC = { sourceWatchdog: 100 }; }, root);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('#total-debt').innerText().then(s => s.replace(/\D/g, '')), '10500');
            assert.equal(await page.locator('#total-money').innerText(), '—');
            assert.equal(await page.locator('#rc-ajust').innerText(), '—');
            assert.equal(await page.locator('#releves-list .btn-paye').first().isEnabled(), true);
            assert.deepEqual(await archiveReads(page), { get: [], listen: [] });
            assert.deepEqual(errors, []);
            await page.waitForSelector('#cycle-status button');
            await page.evaluate(() => { window.__DB.hangListen = []; });
            await page.locator('#cycle-status button').first().click();
            await page.waitForFunction(() => document.getElementById('total-money')?.textContent === '0 CFA');
            assert.equal(await page.locator('#cycle-status').isHidden(), true);
            assert.deepEqual(await archiveReads(page), { get: [], listen: [] });
            console.log('✓ date de clôture lente : soldes disponibles, montants de période non inventés, réessai sans archives');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
