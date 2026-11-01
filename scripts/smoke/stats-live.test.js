'use strict';
const assert = require('node:assert/strict');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const sources = [root + '/config', root + '/agents', root + '/compteurs', root + '/backup'];

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        {
            const { page, ctx, errors } = await newPage(browser, 'président', migratedSeed());
            const warnings = [];
            page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
            await page.addInitScript(paths => {
                window.__ASUFOR_SYNC = { timeout: 70, retries: 0, debounce: 5, hydrate: 3000 };
                window.__DB.hang = paths;
            }, sources);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false', {}, { timeout: 2500 });
            assert.equal(await page.locator('#total-debt').innerText().then(s => s.replace(/\D/g, '')), '10500');
            for (let i = 0; i < 4; i++) await page.evaluate(() => window.AsuforSync.resync('manual', { force: true }));
            assert.equal(await page.evaluate(paths => window.__DB.reads.filter(path => paths.includes(path)).length, sources), 0);
            assert.ok(!warnings.some(w => /TIMEOUT|synchronisation incomplète/.test(w)), warnings.join('\n'));
            assert.deepEqual(errors, []);
            await page.evaluate(() => {
                window.__DB.tree.Asufor.Asufor_a.compteurs.c1.name = 'Client mis à jour';
                window.__DB.listeners.slice().forEach(fn => fn());
            });
            await page.waitForFunction(() => document.getElementById('releves-list').textContent.includes('Client mis à jour'));
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 0);
            console.log('✓ get UI bloqués : trois sources chargées, bilan juste, reprises sans TIMEOUT et mises à jour reçues');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { timeout: 50, retries: 0, sourceWatchdog: 100, hydrate: 3000 };
                window.__DB.listenDelays = { [root + '/agents']: 1400 };
            }, root);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => window.asuforDiagnostics?.().sources.agents?.status === 'slow');
            const before = await page.evaluate(() => window.asuforDiagnostics());
            assert.equal(before.firebaseConnected, true);
            assert.equal(before.sources.releves.status, 'ready');
            assert.equal(before.sources.agents.status, 'slow');
            assert.equal(await page.locator('#total-debt').innerText(), '—');
            assert.equal(await page.locator('#stats-diagnostic').isVisible(), true);
            await page.evaluate(() => window.AsuforSync.resync('recovery', { force: true }));
            assert.equal(await page.evaluate(root => window.__DB.onValuePaths.filter(p => p === root + '/agents').length, root), 1,
                'la reprise automatique ne doit pas abandonner une source lente encore active');
            await page.waitForFunction(() => document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
            assert.equal(await page.evaluate(() => window.asuforDiagnostics().sources.agents.status), 'ready');
            assert.equal(await page.locator('#total-debt').innerText().then(s => s.replace(/\D/g, '')), '10500');
            const serialized = JSON.stringify(before);
            assert.ok(!/email|token|uid|Asufor_a|Aminata|AIza/.test(serialized));
            console.log('✓ source lente : diagnostic précis, résultat tardif accepté, aucun renseignement de compte exposé');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => { window.__DB.failListen = [root + '/agents']; window.__ASUFOR_SYNC = { debounce: 5 }; }, root);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => window.asuforDiagnostics?.().sources.agents?.status === 'error');
            assert.equal(await page.locator('#total-debt').innerText(), '—');
            await page.evaluate(() => { window.__DB.failListen = []; });
            await page.locator('#stats-loading button').first().click();
            await page.waitForFunction(() => document.getElementById('stats-summary').getAttribute('aria-busy') === 'false');
            assert.equal(await page.evaluate(() => window.asuforDiagnostics().sources.agents.status), 'ready');
            console.log('✓ source en erreur : réessai réel, écoute remplacée et bilan rétabli');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
