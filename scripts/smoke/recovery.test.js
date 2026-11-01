'use strict';
// Vraie page Statistiques, serveur Firebase simulé : aucune donnée de production.
const assert = require('node:assert/strict');
const { server, newPage, seed, FA, chromium } = require('./smoke.test.js');
const cacheKey = 'asufor_cache_v1:releves:Asufor/' + FA + '/compteurs';

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        for (const trigger of ['automatic', 'badge', 'foreground']) {
            const { page, ctx, errors } = await newPage(browser, 'président', seed());
            await page.addInitScript(([key, automatic]) => {
                window.__ASUFOR_SYNC = { timeout: 100, retries: 0, debounce: 10, offlineAfter: 50, recoveryDelay: automatic ? 1000 : 60000, resyncTimeout: 1000, minResume: 0, hydrate: 50, fast: true };
                window.__DB.connected = false;
                window.__DB.hangAll = true;
                window.__DB.recoverOnReopen = true;
                localStorage.setItem(key, JSON.stringify({ c1: { name: 'Copie locale ancienne', agent_id: 'ag1', last_index: '0', new_index: 1, facteur: 250 } }));
                localStorage.setItem(key.replace('releves:', 'agents:').replace('/compteurs', '/agents'), JSON.stringify({ ag1: { agent: 'Agent Un', zone: 'Nord' } }));
            }, [cacheKey, trigger === 'automatic']);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('asufor-sync-badge')?.dataset.status === 'offline');
            await page.waitForFunction(() => document.getElementById('releves-list')?.textContent.includes('Copie locale ancienne'), {}, { timeout: 5000 });
            assert.match(await page.locator('#releves-list').innerText(), /Copie locale ancienne/);
            if (trigger === 'badge') await page.locator('#asufor-sync-badge').click();
            if (trigger === 'foreground') {
                await page.evaluate(() => {
                    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
                    window.dispatchEvent(new Event('offline'));
                    // Le téléphone retrouve le réseau sans émettre d'événement online.
                    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
                    document.dispatchEvent(new Event('visibilitychange'));
                });
            }
            await page.waitForFunction(() => document.getElementById('asufor-sync-badge')?.dataset.status === 'synced' && document.getElementById('releves-list')?.textContent.includes('Aminata'), {}, { timeout: 6000 });
            const result = await page.evaluate(() => ({ opens: window.__DB.onlineCalls, closes: window.__DB.offlineCalls, writes: window.__DB.writes.length, connected: window.AsuforSync._state.connected }));
            assert.equal(result.opens, 1); assert.equal(result.closes, 1);
            assert.equal(result.writes, 0); assert.equal(result.connected, true);
            assert.ok(!errors.some(e => e.startsWith('pageerror:')), errors.join('\n'));
            console.log('✓ ' + trigger + ' : cache ancien remplacé, connexion rouverte une fois, aucune écriture');

            await page.evaluate(() => {
                Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
                window.dispatchEvent(new Event('offline'));
            });
            assert.equal(await page.locator('#asufor-sync-badge').getAttribute('data-status'), 'synced');
            console.log('✓ ' + trigger + ' : Firebase actif ne reste pas bloqué sur un signal navigateur hors ligne');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
