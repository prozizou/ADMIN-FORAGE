'use strict';
// Réabonnement mensuel : carte de rappel (1er–12) et blocage de l'application (après le 12, ou mois précédent impayé).
const assert = require('node:assert/strict');
const { server, newPage, migratedSeed, FA, chromium } = require('./smoke.test.js');

// Décale l'horloge de la page au jour voulu de novembre 2026 (le temps continue de s'écouler).
const atDay = (page, day) => page.addInitScript(day => {
    const Real = Date, shift = new Real(2026, 10, day, 10).getTime() - Real.now();
    window.Date = class extends Real {
        constructor(...a) { super(...(a.length ? a : [Real.now() + shift])); }
        static now() { return Real.now() + shift; }
    };
}, day);

function seedWith(abonnement) {
    const t = migratedSeed();
    t.Asufor[FA].abonnement = abonnement;
    return t;
}
const blocked = page => page.evaluate(() => !!document.getElementById('abo-block'));

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        {   // 1er–12 : rappel seulement, nœud du mois créé à false
            const { page, ctx, errors } = await newPage(browser, 'président', seedWith({}));
            await atDay(page, 7);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForSelector('#abonnement-card:not([hidden])');
            assert.match(await page.getAttribute('#abonnement-card', 'class'), /abo-soon/);
            assert.equal(await page.evaluate(fa => window.__DB.tree.Asufor[fa].abonnement['2026-11'], FA), false);
            assert.equal(await blocked(page), false);
            assert.ok(!errors.some(e => e.startsWith('pageerror:')), errors.join('\n'));
            console.log('✓ le 7 : carte jaune, nœud du mois créé à false, pas de blocage');
            await ctx.close();
        }
        {   // Après le 12, non payé → bloqué ; le super-admin passe à true → débloqué en direct
            const { page, ctx, errors } = await newPage(browser, 'trésorier', seedWith({ '2026-11': false }));
            await atDay(page, 13);
            await page.goto(base + '/home/accueil.html');
            await page.waitForSelector('#abo-block');
            assert.equal(await page.locator('#abo-block a.abo-pay').count(), 3);
            await page.evaluate(fa => { window.__DB.tree.Asufor[fa].abonnement['2026-11'] = true; window.__DB.listeners.slice().forEach(f => f()); }, FA);
            await page.waitForFunction(() => !document.getElementById('abo-block'));
            assert.ok(!errors.some(e => e.startsWith('pageerror:')), errors.join('\n'));
            console.log('✓ le 13 non payé : application bloquée ; validation du paiement → débloquée sans recharger');
            await ctx.close();
        }
        {   // La décision est mémorisée : bloqué dès l'ouverture d'une autre page, même avant la réponse Firebase
            const { page, ctx } = await newPage(browser, 'secrétaire', seedWith({ '2026-10': false, '2026-11': true }));
            await atDay(page, 3);
            await page.goto(base + '/home/accueil.html');
            await page.waitForSelector('#abo-block');
            await page.evaluate(() => { window.__DB.hangAll = true; });
            await page.goto(base + '/counter/list.html');
            await page.waitForSelector('#abo-block', { timeout: 3000 });
            console.log('✓ mois précédent révoqué (false) : bloqué, y compris sans réponse du serveur');
            await ctx.close();
        }
        {   // Payé : aucune trace du blocage ni de la carte
            const { page, ctx } = await newPage(browser, 'président', seedWith({ '2026-11': true }));
            await atDay(page, 20);
            await page.goto(base + '/statistiques/stats.html');
            await page.waitForTimeout(600);
            assert.equal(await blocked(page), false);
            assert.equal(await page.locator('#abonnement-card').isHidden(), true);
            console.log('✓ le 20 payé : ni carte ni blocage');
            await ctx.close();
        }
    } finally {
        await browser.close();
        server.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
