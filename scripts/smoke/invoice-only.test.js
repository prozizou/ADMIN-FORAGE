'use strict';
const assert=require('node:assert/strict');
const C=require('../../compta.js');
const {server,newPage,migratedSeed,FA,chromium}=require('./smoke.test.js');
const root='Asufor/'+FA;
const money=text=>Number(text.replace(/[^\d-]/g,''));
function apply(tree,updates) {
    for (const [path,value] of Object.entries(updates)) {
        const parts=path.split('/');let node=tree;
        for (const key of parts.slice(0,-1)) node=node[key] ||= {};
        if (value===null) delete node[parts.at(-1)]; else node[parts.at(-1)]=value;
    }
}
(async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
    try {
        {
            const {page,ctx,errors}=await newPage(browser,'président',migratedSeed());
            await page.goto(base+'/statistiques/stats.html');
            await page.waitForFunction(()=>document.getElementById('stats-summary')?.getAttribute('aria-busy')==='false');
            assert.equal(await page.locator('[data-counter-id="c3"] [data-action="collect"]').count(),0,'un relevé courant sans facture ne peut pas être encaissé');
            await page.evaluate(()=>window.encaisser('c3'));
            assert.equal(await page.locator('#cui-montant').count(),0);
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),0);
            await page.goto(base+'/compte/releve.html?c=c1');
            await page.waitForFunction(()=>document.getElementById('balance').getAttribute('aria-busy')==='false');
            assert.equal(money(await page.locator('#total-due').innerText()),6000,'le relevé courant de 1 500 F est exclu');
            await page.click('#btn-pay');await page.fill('#cui-montant','7000');await page.click('#cui-ok');
            assert.match(await page.locator('#cui-err').innerText(),/dépasse/);
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),0);
            await page.fill('#cui-montant','2000');await page.click('#cui-ok');await page.click('#cui-close');
            await page.waitForFunction(()=>document.getElementById('total-due').textContent==='4 000 F');
            await page.click('#btn-pay');await page.fill('#cui-montant','3000');
            // Un autre encaissement intervient pendant la saisie : le plafond doit être revérifié.
            await page.evaluate(root=>{
                const f=window.__DB.tree.Asufor.Asufor_a;let id=0;
                const result=window.Compta.buildInvoicePaymentOps(window.Compta.normState(f),{paths:window.Compta.pathsFor(root),compteurId:'c1',montant:2500,mode:'autre',numero_recu:'AUTRE-CAISSE',releve:f.compteurs.c1,user:{uid:'u2',role:'trésorier'},now:new Date().toISOString(),newId:()=> 'remote-'+(++id)});
                for (const [path,value] of Object.entries(result.updates)) {
                    const parts=path.split('/');let node=window.__DB.tree;
                    for (const key of parts.slice(0,-1)) node=node[key] ||= {};
                    if (value===null) delete node[parts.at(-1)];else node[parts.at(-1)]=value;
                }
                window.__DB.listeners.slice().forEach(fn=>fn());
            },root);
            await page.click('#cui-ok');
            await page.waitForFunction(()=>document.getElementById('cui-err').textContent.includes('dépasse'));
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),1,'la tentative devenue excessive n’est pas écrite');
            await page.fill('#cui-montant','1500');await page.click('#cui-ok');await page.click('#cui-close');
            await page.waitForFunction(()=>document.getElementById('total-due').textContent==='0 F');
            assert.equal(await page.locator('#btn-pay').isDisabled(),true,'aucun versement supplémentaire sur le mois non clôturé');
            const account=await page.evaluate(()=>window.Compta.computeAccount(window.ComptaUI.getState(),'c1'));
            assert.equal(account.avance,0);assert.equal(account.arrieres,0);
            assert.equal(account.total_paye,6000);
            assert.ok(account.paiements.every(p=>p.affecte===p.montant));
            assert.deepEqual(errors,[]);await ctx.close();
            console.log('✓ versements uniquement sur factures : pas de collecte du relevé courant, tranches entièrement affectées, excès et plafond périmé refusés sans écriture');
        }
        {
            const tree=migratedSeed(),f=tree.Asufor[FA];
            f.factures={};f.paiements={};f.affectations={};f.soldes={};f.ajustements={};
            let id=0;
            // Ancienne donnée créée avant le plafonnement : elle doit pouvoir être identifiée et corrigée.
            apply(tree,C.buildPaymentOps(C.emptyState(),{paths:C.pathsFor(root),compteurId:'c1',montant:45000,mode:'autre',numero_recu:'ANCIEN-45000',client:'Aminata',paiementId:'old45',releve:f.compteurs.c1,user:{uid:'u1',role:'président'},now:new Date().toISOString(),newId:()=> 'legacy-'+(++id)}).updates);
            const {page,ctx,errors}=await newPage(browser,'président',tree);
            await page.goto(base+'/statistiques/stats.html');
            await page.waitForFunction(()=>document.getElementById('stats-summary')?.getAttribute('aria-busy')==='false');
            await page.click('#show-receipts');
            assert.equal(money(await page.locator('.receipt-total strong').innerText()),45000);
            assert.match(await page.locator('.receipt-warning').innerText(),/45[\s\u202f\xa0]000 F non affectés/);
            await page.click('#close-receipts');
            await page.evaluate(()=>window.openReleve('c1'));
            const customer=page.frameLocator('#customer-frame');
            await customer.locator('#balance[aria-busy="false"]').waitFor();
            assert.equal(money(await customer.locator('#t-paye').innerText()),0,'une ancienne avance n’est pas présentée comme une facture réglée');
            assert.equal(money(await customer.locator('#t-credit').innerText()),45000);
            assert.equal(await customer.locator('#btn-pay').isDisabled(),true);
            assert.match(await customer.locator('#payments-table').innerText(),/non affectés aux factures/);
            await customer.locator('[data-cancel="old45"]').click();
            await page.waitForFunction(()=>document.getElementById('total-money').textContent==='0 CFA');
            const cancelled=await page.evaluate(()=>window.__DB.tree.Asufor.Asufor_a.paiements.old45);
            assert.equal(cancelled.statut,'annule');assert.equal(cancelled.montant,45000);
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),0,'la correction passe par la fiche client, sans réécriture des statistiques');
            assert.deepEqual(errors,[]);await ctx.close();
            console.log('✓ ancien versement non affecté de 45 000 F : identifié dans le détail, exclu du cumul des factures, annulation explicite et tracée reçue en direct');
        }
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
