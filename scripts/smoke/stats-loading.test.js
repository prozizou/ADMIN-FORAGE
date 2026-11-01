'use strict';
const assert = require('node:assert/strict');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        for (const slow of ['backup', 'migration', 'compteurs']) {
            const { page, ctx, errors } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(([root, slow]) => {
                window.__ASUFOR_SYNC = { timeout: 5000, retries: 0, hydrate: 4000 };
                if (slow === 'migration') window.__DB.listenDelays = { [root + '/migration_comptable/v1']: 1600 };
                else window.__DB.delays[root + '/' + slow] = 1600;
                localStorage.setItem('asufor_cache_v1:releves:' + root + '/compteurs', JSON.stringify({ old: { name: 'Copie locale', agent_id: 'ag1', numero_compteur: '1', last_index: '0', new_index: 900, facteur: 250 } }));
                window.__figures = [];
                document.addEventListener('DOMContentLoaded', () => {
                    new MutationObserver(() => {
                        const value = document.getElementById('total-debt')?.textContent.trim();
                        if (value && value !== '—' && !window.__figures.includes(value)) window.__figures.push(value);
                    }).observe(document.body, { subtree: true, childList: true, characterData: true });
                });
            }, [root, slow]);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForSelector('#releves-list .item');
            const pending = await page.locator('#total-debt').innerText();
            assert.equal(pending, '—', slow + ' : aucun montant provisoire pendant le chargement');
            assert.equal(await page.locator('#releves-list .btn-paye').count(), 0);
            await page.waitForFunction(() => document.getElementById('total-debt')?.textContent.replace(/\D/g, '') === '10500', {}, { timeout: 8000 });
            const observations = await page.evaluate(() => window.__figures);
            assert.ok(observations.length > 0);
            assert.deepEqual([...new Set(observations.map(value => value.replace(/\D/g, '')))], ['10500'], slow + ' : seuls les montants complets doivent apparaître');
            assert.match(await page.locator('#releves-list').innerText(), /Aminata/);
            assert.equal(await page.locator('#total-money').innerText(), '0 CFA');
            assert.equal(await page.locator('#stats-summary').getAttribute('aria-busy'), 'false');
            assert.equal(await page.locator('button[onclick="exportCSV()" ]').isEnabled(), true);
            await page.evaluate(() => {
                window.__indexBuilds = 0;
                const original = window.Billing.indexBackups;
                window.Billing.indexBackups = (...args) => { window.__indexBuilds++; return original(...args); };
            });
            await page.fill('#search-client', 'Aminata');
            await page.fill('#search-client', 'Boubacar');
            await page.fill('#search-client', '');
            assert.equal(await page.evaluate(() => window.__indexBuilds), 0, 'la recherche ne reconstruit pas les index d’archives');
            assert.ok(!errors.some(error => error.startsWith('pageerror:')), errors.join('\n'));
            console.log('✓ ' + slow + ' retardé : aucun chiffre provisoire ; bilan complet affiché une fois');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { timeout: 100, retries: 0, hydrate: 100 };
                window.__DB.failListen = [root + '/paiements'];
                window.__DB.failReads = [root + '/paiements'];
            }, root);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForSelector('#compta-status button');
            assert.equal(await page.locator('#total-debt').innerText(), '—');
            assert.equal(await page.locator('button[onclick="exportCSV()" ]').isDisabled(), true);
            assert.equal(await page.locator('#releves-list .btn-paye').count(), 0);
            await page.evaluate(() => { window.__DB.failListen = []; window.__DB.failReads = []; window.ComptaUI.retry(); });
            await page.waitForFunction(() => document.getElementById('total-debt')?.textContent.replace(/\D/g, '') === '10500');
            console.log('✓ comptabilité indisponible : montants et actions suspendus, puis bilan correct après reprise');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', { Asufor: { [FA]: { config: { nom: 'Vide' } } } });
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('#total-debt').innerText(), '0 CFA');
            assert.equal(await page.locator('#total-money').innerText(), '0 CFA');
            console.log('✓ données complètes mais vides : vrais zéros affichés après chargement');
            await ctx.close();
        }

        {
            const { page, ctx } = await newPage(browser, 'président', migratedSeed());
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
            await page.evaluate(root => { window.__DB.delays[root + '/backup/2026-06/donnees'] = 1200; }, root);
            await page.selectOption('#month-filter', '2026-06');
            assert.equal(await page.locator('#total-debt').innerText(), '—');
            assert.equal(await page.locator('#stats-summary').getAttribute('aria-busy'), 'true');
            await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
            assert.match(await page.locator('#recap-title').innerText(), /juin/i);
            console.log('✓ changement de mois : aucun montant de la période précédente pendant la lecture');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
