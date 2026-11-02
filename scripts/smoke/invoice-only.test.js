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
            const initial=migratedSeed(), seed=initial.Asufor[FA];
            seed.factures={'2026-10_c1':{...seed.factures['2026-06_c1'],facture_id:'2026-10_c1',cycle:'2026-10',montant_initial:41750,montant_net:41750,montant_paye:0,reste_a_payer:41750}};
            seed.compteurs.c1.last_index=167;seed.compteurs.c1.new_index=168;seed.compteurs.c3.new_index=0;
            const {page,ctx,errors}=await newPage(browser,'président',initial);
            await page.setViewportSize({width:390,height:780});
            await page.goto(base+'/statistiques/stats.html');
            await page.waitForFunction(()=>document.getElementById('stats-summary')?.getAttribute('aria-busy')==='false');
            assert.equal(money(await page.locator('[data-counter-id="c1"] .citem-amt').innerText()),42000);
            assert.equal(await page.locator('[data-counter-id="c3"] [data-action="collect"]').count(),0,'un relevé courant sans facture ne peut pas être encaissé');
            await page.evaluate(()=>window.encaisser('c3'));
            assert.equal(await page.locator('#cui-montant').count(),0);
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),0);
            await page.goto(base+'/compte/releve.html?c=c1');
            await page.waitForFunction(()=>document.getElementById('balance').getAttribute('aria-busy')==='false');
            assert.equal(await page.locator('#amount-label').innerText(),'Total à payer');
            assert.equal(money(await page.locator('#amount-arrears').innerText()),41750);
            assert.equal(money(await page.locator('#amount-current').innerText()),250);
            assert.equal(money(await page.locator('#total-due').innerText()),42000,'41 750 F d’arriérés et 250 F du relevé sont inclus');
            await page.click('#btn-pay');
            assert.equal(money(await page.locator('#cui-prev').innerText()),42000);
            assert.equal(await page.getAttribute('#cui-montant','max'),'42000');
            await page.screenshot({path:'/tmp/versement-42000-390.png'});
            await page.fill('#cui-montant','42001');await page.click('#cui-ok');
            assert.match(await page.locator('#cui-err').innerText(),/dépasse/);
            assert.equal(await page.evaluate(()=>window.__DB.writes.length),0);
            await page.fill('#cui-montant','10000');await page.click('#cui-ok');await page.click('#cui-close');
            await page.waitForFunction(()=>document.getElementById('total-due').textContent==='32 000 F');
            await page.click('#btn-pay');await page.fill('#cui-montant','30000');
            // Un autre encaissement intervient pendant la saisie : le plafond doit être revérifié.
            await page.evaluate(root=>{
                const f=window.__DB.tree.Asufor.Asufor_a;let id=0;
                const result=window.Compta.buildInvoicePaymentOps(window.Compta.normState(f),{paths:window.Compta.pathsFor(root),compteurId:'c1',montant:20000,mode:'autre',numero_recu:'AUTRE-CAISSE',releve:f.compteurs.c1,user:{uid:'u2',role:'trésorier'},now:new Date().toISOString(),newId:()=> 'remote-'+(++id)});
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
            await page.fill('#cui-montant','12000');await page.click('#cui-ok');await page.click('#cui-close');
            await page.waitForFunction(()=>document.getElementById('total-due').textContent==='0 F');
            assert.equal(await page.locator('#btn-pay').isDisabled(),true,'le relevé saisi et les arriérés sont entièrement réglés');
            const account=await page.evaluate(()=>window.Compta.computeAccount(window.ComptaUI.getState(),'c1'));
            assert.equal(account.avance,0);assert.equal(account.arrieres,0);assert.equal(account.releve_paye,250);
            assert.equal(account.total_paye,42000);
            assert.ok(account.paiements.every(p=>p.affecte===p.montant));
            const saved=await page.evaluate(()=>window.__DB.tree);
            const receipt=await newPage(browser,'président',saved);
            const last=account.paiements.find(p=>p.affecte_releve>0);
            await receipt.page.goto(base+'/compte/recu.html?p='+encodeURIComponent(last.paiement_id));
            await receipt.page.waitForSelector('.recu');
            assert.match(await receipt.page.locator('.recu').innerText(),/Relevé saisi.*167.*168/);
            assert.ok((await receipt.page.locator('.recu td').allTextContents()).some(text=>text.trim()==='250 FCFA'));
            assert.doesNotMatch(await receipt.page.locator('.recu').innerText(),/Avance \(crédit client\)/);
            await receipt.ctx.close();
            const edit=await newPage(browser,'président',saved);
            await edit.page.goto(base+'/statistiques/stats.html');
            await edit.page.waitForFunction(()=>document.getElementById('stats-summary')?.getAttribute('aria-busy')==='false');
            await edit.page.evaluate(()=>window.openEditModal('c1'));
            await edit.page.fill('#edit-new-index','167');
            await edit.page.click('button[onclick="submitEdit()"]');
            await edit.page.waitForFunction(()=>document.getElementById('toast').textContent.includes('déjà reçu'));
            assert.equal(await edit.page.evaluate(()=>window.__DB.writes.length),0,'un relevé payé ne peut pas être réduit sans annuler le paiement');
            await edit.ctx.close();

            assert.deepEqual(errors,[]);await ctx.close();
            console.log('✓ 41 750 + 250 = 42 000 F dans la fiche et la fenêtre ; tranches affectées sans avance, excès et plafond périmé refusés');
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
            assert.equal(await customer.locator('#t-paye').count(),0,'les anciens cumuls ne sont pas affichés');
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
