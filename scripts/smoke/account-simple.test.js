'use strict';
const assert = require('node:assert/strict');
const C = require('../../compta.js');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const digits = text => Number(text.replace(/−/g, '-').replace(/[^\d-]/g, ''));
function example() {
    const tree = migratedSeed();
    const f = tree.Asufor[FA];
    f.compteurs.c1 = { ...f.compteurs.c1, name: 'Client exemple', numero_compteur: '421', zone: 'Quartier Nord', last_index: 167, new_index: 168 };
    f.factures = { '2026-10_c1': { facture_id: '2026-10_c1', compteur_id: 'c1', cycle: '2026-10', date_creation: '2026-10-30T18:15:00Z', source: 'cloture', montant_initial: 41750, ancien_index: 0, nouvel_index: 167, consommation: 167, facteur: 250, probleme: { actif: true, resolu: false, valeur_m3: 167 } } };
    return tree;
}
async function open(browser, base, role = 'président', tree = example()) {
    const result = await newPage(browser, role, tree);
    await result.page.goto(base + '/compte/releve.html?c=c1');
    await result.page.waitForFunction(() => document.getElementById('balance')?.getAttribute('aria-busy') === 'false');
    return result;
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    try {
        {
            const { page, ctx, errors } = await open(browser, base);
            assert.equal(digits(await page.locator('#total-due').innerText()), 42000);
            assert.equal(digits(await page.locator('#due-old').innerText()), 41750);
            assert.equal(digits(await page.locator('#due-current').innerText()), 250);
            assert.equal(await page.locator('#account-details').evaluate(el => el.open), false);
            assert.equal(await page.locator('#btn-adj').isVisible(), false);
            assert.match(await page.locator('#timeline').innerText(), /À payer/);
            assert.match(await page.locator('#timeline').innerText(), /Consommation élevée/);
            assert.equal(await page.locator('[data-resolve]').isVisible(), false);
            for (const width of [320, 360, 390, 768]) {
                await page.setViewportSize({ width, height: 900 });
                const bounds = await page.evaluate(() => {
                    const buttons = ['btn-pay', 'btn-print', 'btn-more'].map(id => document.getElementById(id));
                    return { overflow: document.documentElement.scrollWidth - innerWidth, buttons: buttons.map(b => ({ text: b.innerText.trim(), height: b.getBoundingClientRect().height, right: b.getBoundingClientRect().right, width: b.clientWidth, scroll: b.scrollWidth })) };
                });
                assert.ok(bounds.overflow <= 0, JSON.stringify(bounds));
                for (const b of bounds.buttons) { assert.ok(b.text.length > 5); assert.ok(b.height >= 44); assert.ok(b.right <= width); assert.ok(b.scroll <= b.width + 1); }
                if (width === 390) await page.screenshot({ path: '/tmp/releve-simple-390.png', fullPage: true });
            }
            await page.setViewportSize({ width: 390, height: 900 });
            await page.locator('#account-details > summary').click();
            assert.equal(digits(await page.locator('#t-solde').innerText()), 41750, 'le détail distingue le solde des factures du total avec le mois courant');
            await page.locator('#account-details > summary').click();
            await page.locator('.event-details > summary').click();
            await page.locator('[data-resolve]').click();
            assert.match(await page.locator('.cui-box').innerText(), /ne règle pas la facture/);
            await page.locator('#ok').click();
            assert.match(await page.locator('#err').innerText(), /obligatoire/);
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 0);
            await page.fill('#mot', 'Index contrôlé sur place');
            await page.click('#ok');
            await page.waitForFunction(() => document.getElementById('timeline').textContent.includes('Relevé vérifié'));
            assert.equal(digits(await page.locator('#total-due').innerText()), 42000, 'vérifier le relevé ne règle pas la dette');
            assert.match(await page.locator('#timeline').innerText(), /À payer/);
            await page.click('#btn-pay');
            await page.waitForSelector('#cui-montant');
            assert.equal(await page.inputValue('#cui-montant'), '42000', 'le montant proposé correspond exactement au total principal');
            await page.fill('#cui-montant', '300');
            await page.click('#cui-ok');
            await page.waitForSelector('#cui-close');
            await page.click('#cui-close');
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '41 700 F');
            assert.match(await page.locator('#timeline').innerText(), /Payée en partie/);
            assert.equal(await page.locator('#timeline .ev').first().locator('.t').innerText(), 'Paiement reçu');
            assert.equal(await page.locator('[data-cancel]').isVisible(), false, 'l’annulation reste dans les détails du paiement');
            await page.click('#btn-more');
            await page.click('#btn-adj');
            assert.match(await page.locator('.cui-box').innerText(), /Corriger une facture/);
            assert.match(await page.locator('#amount-help').innerText(), /retirer/);
            await page.selectOption('#typ', 'majoration');
            assert.match(await page.locator('#amount-help').innerText(), /ajouter/);
            await page.click('#no');
            assert.deepEqual(errors, []);
            console.log('✓ total clair (42 000 F), écrans 320–768 px, vérification sans règlement et paiement partiel cohérent');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await newPage(browser, 'président', example());
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { timeout: 60, retries: 0, debounce: 5 };
                window.__DB.failReads = [root + '/compteurs/c1'];
            }, root);
            await page.goto(base + '/compte/releve.html?c=c1');
            await page.waitForSelector('#retry-account');
            assert.equal(await page.locator('#total-due').innerText(), '—');
            assert.equal(await page.locator('#btn-pay').isDisabled(), true);
            assert.equal(await page.locator('#btn-print').isDisabled(), true);
            assert.match(await page.locator('#account-status').innerText(), /montant exact/);
            await page.evaluate(() => { window.__DB.failReads = []; });
            await page.click('#retry-account');
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '42 000 F');
            assert.equal(await page.locator('#btn-pay').isEnabled(), true);
            assert.equal(await page.locator('#account-status').isVisible(), false);
            assert.equal(await page.evaluate(root => window.__DB.reads.some(path => path === root + '/backup' || path.startsWith(root + '/backup/')), root), false);
            assert.deepEqual(errors, []);
            console.log('✓ relevé indisponible : aucun faux total, paiement suspendu et réessai efficace sans archives');
            await ctx.close();
        }
        {
            for (const index of [0, 100]) {
                const tree = example(); tree.Asufor[FA].compteurs.c1.new_index = index;
                const { page, ctx, errors } = await open(browser, base, 'président', tree);
                assert.equal(await page.locator('#due-current').innerText(), index === 0 ? 'À relever' : 'À vérifier');
                assert.equal(digits(await page.locator('#total-due').innerText()), 41750);
                assert.match(await page.locator('#provisoire').innerText(), /n’est pas inclus/);
                assert.deepEqual(errors, []);
                await ctx.close();
            }
            console.log('✓ relevé manquant ou index erroné : état expliqué, aucun faux zéro pour le mois courant');
        }
        {
            const tree = example(), f = tree.Asufor[FA];
            for (let month = 1; month <= 9; month++) {
                const cycle = '2026-' + String(month).padStart(2, '0');
                const id = cycle + '_c1';
                f.factures[id] = { facture_id: id, compteur_id: 'c1', cycle, montant_initial: 100, date_creation: cycle + '-28T12:00:00Z', source: 'cloture' };
            }
            const { page, ctx, errors } = await open(browser, base, 'président', tree);
            assert.equal(await page.locator('#timeline .ev').count(), 5);
            assert.match(await page.locator('#timeline .ev').first().innerText(), /Octobre 2026/);
            await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
            assert.equal(await page.locator('#timeline .ev').count(), 10, 'toutes les factures sont incluses dans l’impression');
            assert.equal(await page.locator('details:not([open])').count(), 0);
            await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
            assert.equal(await page.locator('#timeline .ev').count(), 5);
            assert.equal(await page.locator('#account-details').evaluate(el => el.open), false);
            await page.click('#history-more');
            assert.equal(await page.locator('#timeline .ev').count(), 10);
            assert.equal(await page.locator('#history-more').isVisible(), false);
            assert.deepEqual(errors, []);
            console.log('✓ historique récent limité, anciennes opérations accessibles, impression complète et écran restauré');
            await ctx.close();
        }
        {
            const tree = example(), f = tree.Asufor[FA];
            const result = C.buildPaymentOps(C.normState(f), { paths: C.pathsFor(root), compteurId: 'c1', releve: f.compteurs.c1, montant: 50000, mode: 'especes', numero_recu: 'EXEMPLE', now: new Date().toISOString(), user: { uid: 'u1', role: 'président', nom: 'Président' }, newId: () => 'exemple-paiement' });
            for (const [path, value] of Object.entries(result.updates)) {
                const parts = path.split('/'); let node = tree;
                for (const key of parts.slice(0, -1)) node = node[key] || (node[key] = {});
                node[parts.at(-1)] = value;
            }
            const { page, ctx, errors } = await open(browser, base, 'secrétaire', tree);
            assert.equal(digits(await page.locator('#total-due').innerText()), 0);
            assert.match(await page.locator('#balance-state').innerText(), /8 000 F d’avance/);
            assert.equal(digits(await page.locator('#due-advance').innerText()), -250);
            assert.equal(await page.locator('#btn-pay').isVisible(), false);
            await page.click('#btn-more');
            assert.equal(await page.locator('#btn-adj').isVisible(), false);
            assert.equal(await page.locator('[data-cancel]').count(), 0);
            assert.deepEqual(errors, []);
            console.log('✓ avance clairement expliquée, total non négatif et droits du secrétaire préservés');
            await ctx.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
