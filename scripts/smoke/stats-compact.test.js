'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const security = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8')).headers[0].headers;
const number = text => Number(text.replace(/[^\d-]/g, ''));
const counters = page => page.evaluate(() => ({ reads:window.__DB.reads.length, listens:window.__DB.onValuePaths.length }));
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath:process.env.CHROMIUM_PATH || undefined, args:['--no-sandbox'] });
    try {
        const tree = migratedSeed();
        for (let i = 0; i < 30; i++) tree.Asufor[FA].compteurs['extra' + i] = { ...tree.Asufor[FA].compteurs.c1, name:'Client supplémentaire ' + i, numero_compteur:String(100+i), last_index:10, new_index:11 };
        const { page, ctx, errors } = await newPage(browser, 'président', tree);
        await page.addInitScript(() => { window.__ASUFOR_SYNC = {debounce:5,minResume:0,hydrate:3000}; });
        // Exercise the embedded document under the actual same-origin frame policy.
        await page.route('**/compte/releve.html?*', async route => {
            const response = await route.fetch();
            const headers = {...response.headers()};
            for (const rule of security) if (['X-Frame-Options','Content-Security-Policy'].includes(rule.key)) headers[rule.key] = rule.value;
            await route.fulfill({response, headers});
        });
        await page.setViewportSize({width:390,height:780});
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForFunction(() => document.getElementById('stats-summary')?.getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('.recap-grid, #rc-facture, #rc-arrieres, #rc-avances, #rc-ajust, #rc-problemes').count(), 0);
        const card = key => page.locator('[data-counter-id="' + key + '"]');
        assert.equal(await card('c1').locator('.citem-actions select').count(), 0);
        assert.ok(await card('c1').locator('.client-action-chip').count() >= 3);
        assert.equal(await card('c1').locator('[data-action="payments"]').innerText(), 'Paiements');
        for (const width of [320,390,768,1440]) {
            await page.setViewportSize({width,height:780});
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            assert.equal(await card('c1').locator('.citem-actions').evaluate(row => new Set([...row.children].map(el => Math.round(el.getBoundingClientRect().top))).size), 1);
            assert.ok(await card('c1').locator('.client-action-chip').evaluateAll(chips => chips.every(el => el.getBoundingClientRect().height >= 44)));
            if (width === 390) {
                await card('c1').scrollIntoViewIfNeeded();
                await card('c1').evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 150));
                await card('c1').screenshot({path:'/tmp/stats-action-chips-390.png'});
            }
        }
        await page.setViewportSize({width:390,height:780});
        await card('c1').scrollIntoViewIfNeeded();
        await card('c1').locator('[data-action="payments"]').focus();
        await page.evaluate(() => {
            window.__initialDocument = document;
            window.__firstCard = document.querySelector('[data-counter-id="c1"]');
            window.__otherCard = document.querySelector('[data-counter-id="c2"]');
            window.__otherMarkup = window.__otherCard.innerHTML;
            window.__viewY = scrollY;
        });
        const initial = await counters(page);
        await card('c1').locator('[data-action="payments"]').click();
        const customer = page.frameLocator('#customer-frame');
        await customer.locator('#btn-pay').waitFor({state:'visible'});
        assert.equal(await customer.locator('#client').innerText(), 'Aminata');
        await customer.locator('#btn-pay').click();
        await customer.locator('#cui-montant').fill('2000');
        await customer.locator('#cui-ok').click();
        await customer.locator('#cui-close').waitFor();
        await customer.locator('#cui-close').click();
        await page.waitForFunction(() => document.querySelector('[data-counter-id="c1"] .citem-amt').textContent.replace(/\D/g,'') === '5500');
        await customer.locator('a.back').click();
        await page.waitForSelector('#customer-frame', {state:'detached'});
        assert.deepEqual(await counters(page), initial, 'le retour ne recrée aucune écoute et ne refait aucune lecture globale');
        assert.deepEqual(await page.evaluate(() => ({ document:document===window.__initialDocument, stable:window.__otherCard===document.querySelector('[data-counter-id="c2"]'), unchanged:window.__otherMarkup===window.__otherCard.innerHTML, scroll:Math.abs(scrollY-window.__viewY)<=2 })), {document:true, stable:true, unchanged:true, scroll:true});
        console.log('✓ bilan épuré, chip Paiements, retour après versement sans rechargement ni remplacement des autres cartes');

        const cancel = card('c1').locator('[data-action="cancel"]');
        await cancel.locator('.action-label.is-marquee').waitFor();
        assert.equal(await cancel.getAttribute('aria-label'),'Annuler un paiement');
        assert.equal(await cancel.locator('.action-label-text').evaluate(el => getComputedStyle(el).animationName),'action-label-marquee');
        assert.ok(await card('c1').locator('.citem-actions').evaluate(row => row.scrollWidth > row.clientWidth), 'les actions restent sur une ligne balayable');
        await cancel.focus();
        await page.waitForFunction(() => {
            const el=document.querySelector('[data-counter-id="c1"] [data-action="cancel"]');
            const chip=el.getBoundingClientRect(), row=el.parentElement.getBoundingClientRect();
            return chip.left >= row.left - 1 && chip.right <= row.right + 1;
        }, {}, {timeout:2500});
        await cancel.press('Enter');
        await page.locator('#cui-yes').waitFor();
        await page.click('#cui-no');
        await page.emulateMedia({reducedMotion:'reduce'});
        assert.equal(await cancel.locator('.action-label-text').evaluate(el => getComputedStyle(el).animationName),'none');
        assert.ok(await cancel.locator('.action-label').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'texte complet sans animation en mouvement réduit');
        await page.emulateMedia({reducedMotion:'no-preference'});
        await cancel.locator('.action-label.is-marquee').waitFor();
        await card('c1').evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 150));
        await card('c1').screenshot({path:'/tmp/stats-action-chips-marquee-390.png'});
        console.log('✓ chips horizontaux accessibles au clavier, libellé long animé, confirmation d’annulation et préférence de mouvement réduit');

        await page.evaluate(() => { window.__firstMarkup = window.__firstCard.innerHTML; });
        await card('c2').locator('[data-action="edit"]').click();
        await page.fill('#edit-name', 'Boubacar modifié');
        await page.fill('#edit-new-index', '13');
        await page.click('button[onclick="submitEdit()"]');
        await page.waitForFunction(() => document.querySelector('[data-counter-id="c2"]').textContent.includes('Boubacar modifié'));
        assert.equal(await page.evaluate(() => window.__firstCard === document.querySelector('[data-counter-id="c1"]') && window.__firstMarkup === window.__firstCard.innerHTML), true);
        await page.evaluate(() => { window.__removedCard=document.querySelector('[data-counter-id="c3"]'); delete window.__DB.tree.Asufor.Asufor_a.compteurs.c3; window.__DB.listeners.slice().forEach(fn=>fn()); });
        await page.waitForFunction(() => !document.querySelector('[data-counter-id="c3"]'));
        assert.equal(await page.evaluate(() => !window.__removedCard.isConnected && window.__firstCard===document.querySelector('[data-counter-id="c1"]') && window.__otherCard===document.querySelector('[data-counter-id="c2"]')), true);
        const beforeResume = await counters(page);
        for (const reason of ['visible','pageshow-bfcache']) await page.evaluate(reason => window.AsuforSync.resync(reason,{force:true}), reason);
        assert.deepEqual(await counters(page), beforeResume, 'le retour au premier plan conserve les abonnements sains');
        console.log('✓ modification et suppression ciblées ; les autres cartes et abonnements sont conservés');

        await card('c1').scrollIntoViewIfNeeded();
        const beforeDetails = await counters(page);
        await card('c1').locator('[data-action="details"]').click();
        await customer.locator('#archives-table').waitFor();
        assert.deepEqual(await customer.locator('.archive-index').allTextContents(), ['20 m³ – 24 m³','0 m³ – 20 m³']);
        assert.equal(await customer.locator('#invoice-checks').count(), 0, 'les index sont dans chaque mois, sans liste dupliquée');
        for (const width of [320,390,768]) {
            await page.setViewportSize({width,height:780});
            assert.ok(await customer.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.goBack();
        await page.waitForSelector('#customer-frame',{state:'detached'});
        assert.deepEqual(await counters(page), beforeDetails);
        assert.equal(await page.evaluate(() => document===window.__initialDocument), true);
        assert.deepEqual(errors, []);
        console.log('✓ tous les mois montrent leurs index en m³ ; retour navigateur sans réinitialiser les statistiques');
        await ctx.close();
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error);process.exitCode=1;server.close();});
