'use strict';
const assert = require('node:assert/strict');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        {
            const { page, ctx, errors } = await newPage(browser, 'président', migratedSeed());
            const warnings = [];
            page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { timeout: 70, retries: 0, debounce: 5, offlineAfter: 30, minResume: 0, hydrate: 3000 };
                window.__DB.hang = [root + '/backup'];
            }, root);
            await page.goto(base + '/impression/impression.html');
            await page.waitForSelector('.facture-item');
            assert.equal(await page.evaluate(root => window.__DB.reads.filter(p => p === root + '/backup').length, root), 0,
                'les factures ne doivent pas attendre un get() complet des archives');
            for (let i = 0; i < 3; i++) await page.evaluate(() => window.AsuforSync.resync('manual', { force: true }));
            const paths = await page.evaluate(() => window.__DB.onValuePaths);
            assert.equal(paths.filter(p => p === root + '/backup').length, 1, 'une seule écoute persistante des archives');
            assert.equal(await page.evaluate(root => window.__DB.reads.filter(p => p === root + '/backup').length, root), 0);
            await page.evaluate(root => {
                window.__DB.connected = false;
                window.__DB.connListeners.forEach(fn => fn());
                window.__DB.tree.Asufor.Asufor_a.compteurs.c1.name = 'Aminata actualisée';
                window.__DB.tree.Asufor.Asufor_a.backup['2026-08'] = { info: { cycle: '2026-08' }, donnees: {} };
                window.__DB.connected = true;
                window.__DB.connListeners.forEach(fn => fn());
                window.__DB.listeners.slice().forEach(fn => fn());
            }, root);
            await page.waitForFunction(() => document.getElementById('list-container').textContent.includes('Aminata actualisée') && [...document.getElementById('monthFilter').options].some(o => o.value === '2026-08'));
            assert.ok(!warnings.some(w => /TIMEOUT/.test(w)), warnings.join('\n'));
            assert.deepEqual(errors, []);
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 0);
            console.log('✓ get archives bloqué : chargement et reprises réussis, une seule écoute, données fraîches, aucun TIMEOUT');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { timeout: 50, retries: 0, debounce: 5, hydrate: 3000 };
                window.__DB.listenDelays = { [root + '/backup']: 1500 };
            }, root);
            await page.goto(base + '/impression/impression.html');
            await page.waitForSelector('.invoice-pending');
            assert.equal(await page.locator('#summaryTotal').innerText(), '—');
            assert.equal(await page.locator('#master-cb').isDisabled(), true);
            assert.equal(await page.locator('.bill-cb').count(), 0);
            await page.waitForSelector('.facture-item');
            assert.equal(await page.locator('#master-cb').isEnabled(), true);
            assert.match(await page.locator('#total-c1').innerText(), /7[\s  ]?500/);
            console.log('✓ archives lentes : clients visibles, montants et sélection disponibles après réception complète');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => { window.__DB.failListen = [root + '/backup']; }, root);
            await page.goto(base + '/impression/impression.html');
            await page.waitForFunction(() => document.getElementById('print-loading-message')?.textContent.includes('archives'));
            assert.equal(await page.locator('#master-cb').isDisabled(), true);
            await page.evaluate(() => { window.__DB.failListen = []; });
            await page.locator('#print-loading button').click();
            await page.waitForSelector('.facture-item');
            assert.equal(await page.locator('#master-cb').isEnabled(), true);
            console.log('✓ erreur des archives : message et réessai efficaces, aucun montant partiel imprimable');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
