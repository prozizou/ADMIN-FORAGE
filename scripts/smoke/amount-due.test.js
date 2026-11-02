'use strict';
const assert=require('node:assert/strict');
const C=require('../../compta.js');
const {server,newPage,migratedSeed,FA,chromium}=require('./smoke.test.js');
const root='Asufor/'+FA;
const number=text=>Number(text.replace(/[^\d-]/g,''));
function example() {
    const tree=migratedSeed(),f=tree.Asufor[FA];
    f.compteurs.c1={...f.compteurs.c1,name:'Client du mois',last_index:10,new_index:18,facteur:250};
    f.factures={'2026-10_c1':{facture_id:'2026-10_c1',compteur_id:'c1',cycle:'2026-10',montant_initial:2500,montant_net:2500,montant_paye:0,reste_a_payer:2500,statut:'ouverte',date_creation:'2026-10-01T00:00:00Z',source:'cloture',rev:1}};
    f.paiements={};f.affectations={};f.ajustements={};f.soldes={};
    let n=0;
    const result=C.buildInvoicePaymentOps(C.normState(f),{paths:C.pathsFor(root),compteurId:'c1',montant:2500,mode:'autre',numero_recu:'ANCIEN',paiementId:'old2500',now:'2026-10-13T12:00:00Z',user:{uid:'u1',role:'président'},newId:()=> 'old-'+(++n)});
    for (const [path,value] of Object.entries(result.updates)) {
        const parts=path.split('/');let node=tree;
        for (const key of parts.slice(0,-1)) node=node[key] ||= {};
        if (value===null) delete node[parts.at(-1)];else node[parts.at(-1)]=value;
    }
    return tree;
}
(async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
    try {
        const {page,ctx,errors}=await newPage(browser,'président',example());
        await page.setViewportSize({width:390,height:780});
        await page.goto('http://127.0.0.1:'+server.address().port+'/compte/releve.html?c=c1');
        await page.waitForFunction(()=>document.getElementById('balance').getAttribute('aria-busy')==='false');
        assert.equal(number(await page.locator('#total-due').innerText()),2000);
        assert.equal(await page.locator('#amount-label').innerText(),'À payer ce mois-ci');
        assert.equal(await page.locator('#arrears-row').isVisible(),false);
        assert.equal(await page.locator('#current-row').isVisible(),false);
        assert.equal(await page.locator('#statement-table tr:visible').count(),1);
        assert.equal(await page.locator('#past-total,#t-paye').count(),0);
        assert.doesNotMatch(await page.locator('#statement').innerText(),/4[\s\u202f\xa0]500|2[\s\u202f\xa0]500|cumul|arriérés|Reste à payer/i);
        assert.deepEqual(await page.locator('#payments-table thead th').allTextContents(),['Date','Montant']);
        assert.equal(number(await page.locator('#payments-table tbody td:nth-child(2)').innerText()),2500);
        assert.match(await page.locator('#payments-table time').innerText(),/13 octobre 2026/);
        for (const width of [320,390,768,1440]) {
            await page.setViewportSize({width,height:900});
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            if(width===390) await page.screenshot({path:'/tmp/paiements-simples-2000-390.png',fullPage:true});
        }
        await page.setViewportSize({width:390,height:780});
        await page.click('#btn-pay');
        assert.equal(await page.locator('#cui-prev').innerText(),'Montant à payer : 2 000 F');
        await page.fill('#cui-montant','500');
        assert.equal(await page.locator('#cui-prev').innerText(),'Après ce versement : 1 500 F');
        await page.click('#cui-ok');await page.click('#cui-close');
        await page.waitForFunction(()=>document.getElementById('total-due').textContent==='1 500 F');
        assert.equal(await page.locator('#arrears-row').isVisible(),false);
        await page.locator('[data-cancel]').last().click();
        await page.waitForFunction(()=>document.getElementById('total-due').textContent==='2 000 F');
        assert.equal(await page.locator('#amount-label').innerText(),'À payer ce mois-ci');
        assert.equal(await page.locator('#arrears-row').isVisible(),false);
        assert.equal(await page.locator('#payments-table tbody tr').count(),2);
        const old=await page.evaluate(()=>window.__DB.tree.Asufor.Asufor_a.paiements.old2500);
        assert.equal(old.statut,'valide');
        assert.deepEqual(errors,[]);await ctx.close();
        console.log('✓ ancienne facture 2 500 F réglée + mois courant 2 000 F : seul À payer ce mois-ci 2 000 F apparaît, sans cumul ni faux arriéré ; historique, versement partiel et annulation préservés à 320–1440 px');
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
