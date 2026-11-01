'use strict';
const assert = require('node:assert/strict');
const C = require('../../compta.js');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');
const root = 'Asufor/' + FA;
const num = text => Number(text.replace(/−/g, '-').replace(/[^\d-]/g, ''));
const archiveReads = page => page.evaluate(root => ({ records: window.__DB.reads.filter(p => p === root + '/backup' || p.startsWith(root + '/backup/')), listeners: (window.__DB.onValuePaths || []).filter(p => p === root + '/backup' || p.startsWith(root + '/backup/')), shallow: (window.__DB.shallowReads || []).filter(path => path === root + '/backup') }), root);
function example(arrears = 0) {
    const tree = migratedSeed(), f = tree.Asufor[FA];
    f.compteurs.c1 = { ...f.compteurs.c1, name: 'Client exemple', last_index: 0, new_index: 24, facteur: 250 };
    f.factures = {}; f.paiements = {}; f.affectations = {}; f.ajustements = {}; f.soldes = {}; f.backup = {};
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
    assert.equal(await page.inputValue('#cui-montant'), '', 'un versement demande la somme reçue, sans préremplir le total');
    await page.fill('#cui-montant', String(amount));
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
            assert.equal(num(await page.locator('#t-facture').innerText()), 6000);
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            await versement(page, 2000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '4 000 F');
            assert.equal(num(await page.locator('#t-paye').innerText()), 2000);
            await versement(page, 3000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '1 000 F');
            assert.equal(num(await page.locator('#t-paye').innerText()), 5000);
            assert.deepEqual(await page.locator('#payments-table tbody tr').evaluateAll(rows => rows.map(row => row.cells[2].textContent.trim())), ['2 000 F', '5 000 F']);
            for (const width of [320, 360, 390, 768]) {
                await page.setViewportSize({ width, height: 900 });
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'pas de débordement à ' + width);
                assert.ok(await page.locator('#btn-pay').evaluate(el => el.getBoundingClientRect().height >= 44));
                if (width === 390) await page.screenshot({ path: '/tmp/releve-tranches-390.png', fullPage: true });
            }
            const saved = await page.evaluate(() => window.__DB.tree);
            const reopened = await open(browser, base, saved);
            assert.equal(num(await reopened.page.locator('#total-due').innerText()), 1000);
            assert.equal(num(await reopened.page.locator('#t-paye').innerText()), 5000);
            await reopened.ctx.close();
            const payments = await page.evaluate(() => Object.values(window.__DB.tree.Asufor.Asufor_a.paiements));
            assert.deepEqual(payments.map(p => p.montant), [2000, 3000], 'les paiements successifs restent distincts et ne sont pas écrasés');
            await page.evaluate(() => { window.dispatchEvent(new Event('beforeprint')); window.dispatchEvent(new Event('afterprint')); });
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] }, 'imprimer ne charge aucune archive');
            await versement(page, 1000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '0 F');
            assert.equal(await page.locator('#btn-pay').isDisabled(), true);
            assert.equal(num(await page.locator('#t-paye').innerText()), 6000);
            await page.evaluate(root => {
                const f = window.__DB.tree.Asufor.Asufor_a;
                let id = 0;
                const result = window.Compta.buildClosureOps(window.Compta.normState(f), { paths: window.Compta.pathsFor(root), cycleKey: '2026-11', compteurs: f.compteurs, now: new Date().toISOString(), dateLabel: 'Novembre 2026', user: {uid:'u1',role:'président'}, newId: () => 'closure' + (++id) });
                for (const [path, value] of Object.entries(result.updates)) {
                    const parts = path.split('/'); let node = window.__DB.tree;
                    for (const key of parts.slice(0, -1)) node = node[key] || (node[key] = {});
                    if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = value;
                }
                window.__DB.listeners.slice().forEach(fn => fn());
            }, root);
            await page.waitForFunction(() => document.getElementById('balance').getAttribute('aria-busy') === 'false' && document.getElementById('past-total').textContent === '6 000 F');
            assert.equal(num(await page.locator('#total-due').innerText()), 0, 'la clôture et le nouveau relevé ne doublent pas la facture');
            assert.equal(num(await page.locator('#t-facture').innerText()), 6000);
            assert.equal(num(await page.locator('#t-paye').innerText()), 6000);
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            assert.deepEqual(errors, []);
            console.log('✓ 6 000 − 2 000 − 3 000 = 1 000, cumul persistant, solde final et impression sans archives');
            await ctx.close();
        }
        {
            const { page, ctx, errors } = await open(browser, base, example(2000));
            assert.equal(num(await page.locator('#t-facture').innerText()), 8000);
            await versement(page, 2000);
            await versement(page, 3000);
            await page.waitForFunction(() => document.getElementById('total-due').textContent === '3 000 F');
            const f = await page.evaluate(() => window.__DB.tree.Asufor.Asufor_a);
            assert.equal(f.factures['2026-09_c1'].montant_paye, 2000);
            assert.equal(f.factures['2026-09_c1'].reste_a_payer, 0, 'les arriérés sont réglés en premier');
            assert.equal(num(await page.locator('#t-paye').innerText()), 5000);
            // Annuler un versement retire son montant du cumul, sans supprimer sa trace.
            await page.locator('details:has([data-cancel]) > summary').first().click();
            await page.locator('[data-cancel]').first().click();
            await page.fill('#mot', 'Montant saisi par erreur'); await page.click('#ok');
            await page.waitForFunction(() => document.getElementById('t-paye').textContent === '3 000 F');
            assert.equal(num(await page.locator('#total-due').innerText()), 5000);
            assert.equal(await page.locator('#payments-table tbody tr').count(), 2);
            assert.deepEqual(errors, []);
            console.log('✓ arriérés inclus sans double déduction ; annulation tracée et cumul recalculé');
            await ctx.close();
        }
        {
            const tree = example(2000), f = tree.Asufor[FA];
            const rec = (amount, paid = false) => ({ name: 'Client exemple', last_index: 0, new_index: amount / 250, facteur: 250, status: paid ? 'paye' : 'impaye', statut: paid });
            f.factures['2026-09_c2'] = { ...f.factures['2026-09_c1'], facture_id:'2026-09_c2', compteur_id:'c2', montant_initial:999999 };
            f.backup = { '2026-07': { donnees: { c1: rec(1000, true), c2: { ...rec(999999), name: 'AUTRE CLIENT SECRET' } } }, '2026-08': { donnees: { c2: rec(12345) } }, '2026-09': { donnees: { c1: rec(2000), c2: rec(88888) } } };
            const { page, ctx, errors } = await open(browser, base, tree);
            assert.deepEqual(await archiveReads(page), { records: [], listeners: [], shallow: [] });
            await page.click('#btn-details');
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
            for (const width of [320, 390]) {
                await page.setViewportSize({width, height:900});
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'tableau des archives lisible à ' + width);
            }
            assert.ok(!(await page.locator('#archive-panel').innerText()).includes('AUTRE CLIENT SECRET'));
            assert.equal(num(await page.locator('#total-due').innerText()), 8000, 'les archives consultées ne sont pas ajoutées une seconde fois à la dette');
            await page.click('#hide-archives');
            await page.evaluate(() => window.AsuforSync.resync('visible', { force: true }));
            await page.click('#btn-details');
            assert.deepEqual(await archiveReads(page), reads, 'fermer, reprendre et rouvrir ne télécharge pas à nouveau les archives');
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
            assert.equal(await page.locator('#payments-section').isVisible(), false);
            assert.equal(await page.locator('#archives-table').count(), 0, 'aucun tableau d’archives incomplet n’est affiché');
            await page.evaluate(() => { window.__DB.failShallow = false; });
            await page.click('#retry-archives');
            await page.waitForSelector('#archives-table');
            assert.equal(await page.locator('#archives-table tbody tr').count(), 1, 'les factures du grand livre restent consultables même sans copie d’archive');
            assert.equal(await page.locator('[data-cancel]').count(), 0);
            assert.deepEqual(errors, []);
            console.log('✓ entrée Détails directe, erreur réessayable sans bloquer le relevé, droits du secrétaire conservés');
            await ctx.close();
        }
        {
            for (const index of [0, -1]) {
                const tree = example(); tree.Asufor[FA].compteurs.c1.new_index = index;
                const { page, ctx, errors } = await open(browser, base, tree);
                assert.equal(await page.locator('#due-current').innerText(), 'À relever');
                assert.match(await page.locator('#provisoire').innerText(), /n’est pas inclus/);
                assert.deepEqual(errors, []); await ctx.close();
            }
            console.log('✓ relevé du mois absent : état expliqué, aucun montant inventé');
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
