'use strict';
const assert = require('node:assert/strict');
const C = require('../../compta.js');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const num = text => Number(text.replace(/−/g, '-').replace(/[^\d-]/g, ''));
const paid = async page => (await page.locator('#payments-table tbody tr:not(.payment-cancelled) td:nth-child(2)').allTextContents()).reduce((sum,text)=>sum+num(text),0);
const archiveReads = page => page.evaluate(root => ({ records: window.__DB.reads.filter(p => p === root + '/backup' || p.startsWith(root + '/backup/')), listeners: (window.__DB.onValuePaths || []).filter(p => p === root + '/backup' || p.startsWith(root + '/backup/')), shallow: (window.__DB.shallowReads || []).filter(path => path === root + '/backup') }), root);
function example(arrears = 0) {
    const tree = migratedSeed(), f = tree.Asufor[FA];
    f.compteurs.c1 = { ...f.compteurs.c1, name: 'Client exemple', last_index: 0, new_index: 0, facteur: 250 };
    f.factures = {}; f.paiements = {}; f.affectations = {}; f.ajustements = {}; f.soldes = {}; f.backup = {};
    f.factures['2026-10_c1'] = { facture_id:'2026-10_c1',compteur_id:'c1',cycle:'2026-10',montant_initial:6000,montant_net:6000,montant_paye:0,reste_a_payer:6000,statut:'ouverte',date_creation:'2026-10-31T12:00:00Z',source:'cloture',rev:1,ancien_index:0,nouvel_index:24,consommation:24,facteur:250 };
    if (arrears) {
        f.factures['2026-09_c1'] = { facture_id: '2026-09_c1', compteur_id: 'c1', cycle: '2026-09', montant_initial: arrears, montant_net: arrears, montant_paye: 0, reste_a_payer: arrears, statut: 'ouverte', date_creation: '2026-09-30T12:00:00Z', source: 'cloture', rev: 1, ancien_index: 0, nouvel_index: arrears / 250, consommation: arrears / 250, facteur: 250 };
        f.soldes.c1 = { ...C.soldeCache(C.computeAccount(f, 'c1')), rev: 1, updated_at: '2026-09-30T12:00:00Z' };
    }
    return tree;
}
async function open(browser, base, tree = example(), role = 'président', suffix = '') {
    const result = await newPage(browser, role, tree);
    await result.page.goto(base + '/compte/releve.html?c=c1' + suffix);
    await result.page.waitForFunction(() => document.getElementById('balance')?.getAttribute('aria-busy') === 'false');
    return result;
}
async function versement(page, amount) {
    await page.click('#btn-pay');
    await page.waitForSelector('#cui-montant');
    assert.ok(await page.evaluate(() => document.querySelector('.cui-box').scrollWidth <= document.querySelector('.cui-box').clientWidth + 1), 'la fenêtre de versement ne déborde pas');
    assert.equal(await page.locator('.cui-box input, .cui-box select, .cui-box textarea').count(), 1, 'un seul champ de saisie');
    const before = num(await page.locator('#total-due').innerText());
    assert.equal(await page.inputValue('#cui-montant'), '', 'un versement demande la somme reçue, sans préremplir le total');
    await page.fill('#cui-montant', String(amount));
    assert.equal(num(await page.locator('#cui-prev').innerText()), before - amount);
    if (page.viewportSize().width === 320 && amount === 2000) await page.screenshot({path:'/tmp/versement-minimal-320.png'});
    await page.click('#cui-ok');
    await page.waitForSelector('#cui-close');
    await page.click('#cui-close');
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    try {
        {
            const { page, ctx, errors } = await open(browser, base);
            await page.setViewportSize({ width: 320, height: 780 });
            assert.equal(num(await page.locator('#total-due').innerText()), 6000);
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            await page.click('#btn-pay');
            await page.click('#cui-ok');
            assert.match(await page.locator('#cui-err').innerText(), /supérieur à 0/);
            await page.fill('#cui-montant', '6001');
            await page.click('#cui-ok');
            assert.match(await page.locator('#cui-err').innerText(), /dépasse/);
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 0);
            await page.click('#cui-cancel');
            await versement(page, 2000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '4 000 F');
            assert.equal(await paid(page), 2000);
            await versement(page, 3000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '1 000 F');
            assert.equal(await paid(page), 5000);
            assert.deepEqual(await page.locator('#payments-table tbody tr').evaluateAll(rows => rows.map(row => row.cells[1].textContent.trim())), ['2 000 F', '3 000 F']);
            for (const width of [320, 360, 390, 768, 1024, 1440]) {
                await page.setViewportSize({ width, height: 900 });
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'pas de débordement à ' + width);
                assert.ok(await page.locator('#btn-pay').evaluate(el => el.getBoundingClientRect().height >= 44));
                assert.equal(await page.locator('#btn-details, #btn-print, #btn-more, #menu, #btn-adj, #mi-refresh, #mi-copy').count(), 0);
                assert.equal(await page.locator('[data-recu], .row-actions, .row-menu').count(), 0);
                assert.match(await page.locator('#payments-table time').first().innerText(), /^\d{1,2} [a-zéû]+ \d{4}$/);
                const theme = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.card')).backgroundColor, mode: getComputedStyle(document.documentElement).colorScheme, columns: getComputedStyle(document.getElementById('client-view')).gridTemplateColumns.split(' ').length }));
                assert.equal(theme.bg, 'rgb(248, 250, 252)'); assert.equal(theme.card, 'rgb(255, 255, 255)'); assert.equal(theme.mode, 'light');
                assert.equal(theme.columns, width >= 960 ? 2 : 1);
                if (width === 390 || width === 1440) await page.screenshot({ path: '/tmp/releve-light-' + width + '.png', fullPage: true });
            }
            const saved = await page.evaluate(() => window.__DB.tree);
            const reopened = await open(browser, base, saved);
            assert.equal(num(await reopened.page.locator('#total-due').innerText()), 1000);
            assert.equal(await paid(reopened.page), 5000);
            await versement(reopened.page,1000);
            assert.equal(num(await reopened.page.locator('#total-due').innerText()),0);
            assert.equal(await reopened.page.locator('#btn-pay').isDisabled(),true,'le relevé courant ne permet pas un nouveau versement');
            await reopened.ctx.close();
            const payments = await page.evaluate(() => Object.values(window.__DB.tree.Asufor.Asufor_a.paiements));
            assert.equal(new Set(payments.map(p => p.numero_recu)).size, 2, 'les références internes sont générées automatiquement et distinctes');
            assert.deepEqual(payments.map(p => p.montant), [2000, 3000], 'les paiements successifs restent distincts et ne sont pas écrasés');
            await page.emulateMedia({ colorScheme: 'dark' });
            assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light', 'la vue reste claire même si le téléphone préfère le mode sombre');
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            await page.click('#btn-pay');
            await page.fill('#cui-montant', '1000');
            await page.evaluate(root => {
                const f = window.__DB.tree.Asufor.Asufor_a;
                let id = 0; f.compteurs.c1.new_index=24;
                const result = window.Compta.buildClosureOps(window.Compta.normState(f), { paths: window.Compta.pathsFor(root), cycleKey: '2026-11', compteurs: f.compteurs, now: new Date().toISOString(), dateLabel: 'Novembre 2026', user: {uid:'u1',role:'président'}, newId: () => 'closure' + (++id) });
                for (const [path, value] of Object.entries(result.updates)) {
                    const parts = path.split('/'); let node = window.__DB.tree;
                    for (const key of parts.slice(0, -1)) node = node[key] || (node[key] = {});
                    if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = value;
                }
                window.__DB.listeners.slice().forEach(fn => fn());
            }, root);
            await page.waitForFunction(() => document.getElementById('balance').getAttribute('aria-busy') === 'false' && document.getElementById('total-due').textContent === '7 000 F');
            await page.click('#cui-ok');
            await page.waitForSelector('#cui-close');
            assert.equal(num(await page.locator('.cui-remaining').innerText()), 6000, 'une nouvelle clôture émet une nouvelle facture, sans la prépayer');
            await page.click('#cui-close');
            await page.waitForFunction(() => document.getElementById('balance').getAttribute('aria-busy') === 'false' && document.getElementById('total-due').textContent === '6 000 F');
            assert.equal(num(await page.locator('#total-due').innerText()), 6000, 'le nouveau relevé clôturé devient payable une seule fois');
            assert.equal(await page.locator('#past-total,#t-paye').count(),0);
            assert.equal(await paid(page), 6000);
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            assert.deepEqual(errors, []);
            console.log('✓ 6 000 − 2 000 − 3 000 = 1 000, cumul persistant, solde final, thème clair et mise en page 320–1440 px');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await newPage(browser, 'président', example());
            await page.addInitScript(root => {
                window.__ASUFOR_SYNC = { retries: 0, timeout: 500, debounce: 5 };
                window.__hook = path => {
                    if (window.__DB.writes.length && path === root + '/paiements' && !window.__postWriteFailed) {
                        window.__postWriteFailed = true;
                        throw Object.assign(new Error('Coupure simulée après enregistrement'), {code:'NETWORK'});
                    }
                };
            }, root);
            await page.goto(base + '/compte/releve.html?c=c1');
            await page.waitForFunction(() => document.getElementById('balance').getAttribute('aria-busy') === 'false');
            await page.click('#btn-pay'); await page.fill('#cui-montant', '2000'); await page.click('#cui-ok');
            await page.waitForFunction(() => document.getElementById('cui-err').textContent.includes('Coupure simulée'));
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 1);
            await page.click('#cui-ok'); await page.waitForSelector('#cui-close'); await page.click('#cui-close');
            await page.waitForFunction(() => document.querySelector('#payments-table td:nth-child(2)')?.textContent === '2 000 F');
            assert.equal(num(await page.locator('#total-due').innerText()), 4000);
            assert.equal(await page.evaluate(() => Object.keys(window.__DB.tree.Asufor.Asufor_a.paiements).length), 1);
            assert.equal(await page.evaluate(() => window.__DB.writes.length), 1);
            assert.deepEqual(errors, []);
            console.log('✓ reprise après coupure : le même formulaire ne crée pas un second versement');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await open(browser, base, example(2000));
            assert.equal(num(await page.locator('#total-due').innerText()), 8000);
            await versement(page, 2000);
            await versement(page, 3000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '3 000 F');
            const f = await page.evaluate(() => window.__DB.tree.Asufor.Asufor_a);
            assert.equal(f.factures['2026-09_c1'].montant_paye, 2000);
            assert.equal(f.factures['2026-09_c1'].reste_a_payer, 0, 'les arriérés sont réglés en premier');
            assert.equal(await paid(page), 5000);
            // Annuler un versement retire son montant du cumul, sans supprimer sa trace.
            await page.locator('[data-cancel]').first().click();
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '5 000 F');
            assert.equal(num(await page.locator('#total-due').innerText()), 5000);
            assert.equal(await page.locator('#payments-table tbody tr').count(), 2);
            assert.deepEqual(errors, []);
            console.log('✓ arriérés inclus sans double déduction ; annulation tracée et cumul recalculé');
            await ctx.close();
        }
        {
            const tree = example(2000), f = tree.Asufor[FA];
            delete f.factures['2026-10_c1'];
            const rec = (amount, paid = false) => ({ name: 'Client exemple', last_index: 0, new_index: amount / 250, facteur: 250, status: paid ? 'paye' : 'impaye', statut: paid });
            f.factures['2026-09_c2'] = { ...f.factures['2026-09_c1'], facture_id:'2026-09_c2', compteur_id:'c2', montant_initial:999999 };
            f.backup = { '2026-07': { donnees: { c1: rec(1000, true), c2: { ...rec(999999), name: 'AUTRE CLIENT SECRET' } } }, '2026-08': { donnees: { c2: rec(12345) } }, '2026-09': { donnees: { c1: rec(2000), c2: rec(88888) } } };
            const { page, ctx, errors } = await open(browser, base, tree, 'président', '&vue=factures');
            await page.waitForSelector('#archives-table');
            const scoped = await page.evaluate(root => ({ reads: window.__DB.reads.filter(path => path === root + '/factures' || path.startsWith(root + '/factures/')), listens: window.__DB.onValuePaths.filter(path => path === root + '/factures' || path.startsWith(root + '/factures/')) }), root);
            assert.ok(scoped.reads.every(path => path !== root + '/factures' && path.endsWith('_c1')));
            assert.ok(scoped.listens.every(path => path !== root + '/factures' && path.endsWith('_c1')));
            const reads = await archiveReads(page);
            assert.equal(reads.shallow.length, 1);
            assert.equal(reads.shallow[0], root + '/backup');
            assert.deepEqual(reads.records.sort(), ['2026-07', '2026-08', '2026-09'].map(month => root + '/backup/' + month + '/donnees/c1'));
            assert.deepEqual(reads.listeners, []);
            assert.equal(await page.locator('#archives-table tbody tr').count(), 2, 'un mois sans facture du client n’apparaît pas');
            assert.match(await page.locator('#archives-table').innerText(), /Juillet 2026/);
            for (const width of [320, 390, 768, 1440]) {
                await page.setViewportSize({width, height:900});
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'tableau des archives lisible à ' + width);
            }
            assert.ok(!(await page.locator('#archive-panel').innerText()).includes('AUTRE CLIENT SECRET'));
            assert.equal(num(await page.locator('#total-due').innerText()), 2000, 'les archives consultées ne sont pas ajoutées une seconde fois à la dette');
            await page.evaluate(() => window.AsuforSync.resync('visible', { force: true }));
            assert.deepEqual(await archiveReads(page), reads, 'la reprise ne télécharge pas à nouveau les archives');
            assert.deepEqual(errors, []);
            console.log('✓ détails à la demande : clés des mois seules, lectures ciblées /donnees/c1, aucun autre client ni double dette');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await newPage(browser, 'secrétaire', example(2000));
            await page.addInitScript(root => { window.__DB.failShallow = [root + '/backup']; }, root);
            await page.goto(base + '/compte/releve.html?c=c1&vue=factures');
            await page.waitForSelector('#retry-archives');
            assert.equal(num(await page.locator('#total-due').innerText()), 8000);
            assert.equal(await page.locator('#btn-pay').isVisible(), false);
            assert.equal(await page.locator('#statement').isVisible(), false, 'Détails ouvre seulement la consultation des factures');
            assert.equal(await page.locator('#btn-print, #btn-more, #menu').count(), 0);
            assert.equal(await page.locator('#payments-section').isVisible(), false);
            assert.equal(await page.locator('#archives-table').count(), 0, 'aucun tableau d’archives incomplet n’est affiché');
            await page.evaluate(() => { window.__DB.failShallow = false; });
            await page.click('#retry-archives');
            await page.waitForSelector('#archives-table');
            assert.equal(await page.locator('#archives-table tbody tr').count(), 2, 'les factures du grand livre restent consultables même sans copie d’archive');
            assert.equal(await page.locator('[data-cancel]').count(), 0);
            assert.deepEqual(errors, []);
            console.log('✓ entrée Détails directe, erreur réessayable sans bloquer le relevé, droits du secrétaire conservés');
            await ctx.close();
        }
        {
            for (const index of [0, -1]) {
                const tree = example(); tree.Asufor[FA].compteurs.c1.new_index = index;
                const { page, ctx, errors } = await open(browser, base, tree);
                assert.equal(await page.locator('#due-current').count(),0);
                assert.equal(num(await page.locator('#total-due').innerText()),6000);
                assert.match(await page.locator('#reading-status').innerText(), /non saisi/);
                assert.deepEqual(errors, []); await ctx.close();
            }
            console.log('✓ relevé du mois absent : état expliqué, aucun montant inventé');
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
