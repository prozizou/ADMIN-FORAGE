'use strict';
// Carte « payée » : le montant affiché inclut les arriérés réglés avec le relevé.
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
        const initial=migratedSeed(), seed=initial.Asufor[FA];
        seed.factures={'2026-10_c1':{...seed.factures['2026-06_c1'],facture_id:'2026-10_c1',cycle:'2026-10',montant_initial:5000,montant_net:5000,montant_paye:0,reste_a_payer:5000}};
        seed.paiements={};seed.affectations={};
        Object.assign(seed.compteurs.c1,{last_index:466,new_index:506,facteur:250});
        const S=C.normState(seed);let id=0;
        const due=C.amountDueNow(S,'c1',seed.compteurs.c1);
        assert.equal(due.total_du,15000);
        const r=C.buildInvoicePaymentOps(S,{paths:C.pathsFor(root),compteurId:'c1',montant:15000,mode:'especes',numero_recu:'R1',releve:seed.compteurs.c1,user:{uid:'u1',role:'président'},now:new Date().toISOString(),newId:()=>'t'+(++id)});
        apply(initial,r.updates);
        const {page}=await newPage(browser,'président',initial);
        await page.goto(base+'/statistiques/stats.html');
        await page.waitForFunction(()=>document.getElementById('stats-summary')?.getAttribute('aria-busy')==='false');
        const card=page.locator('[data-counter-id="c1"]');
        console.log(await card.innerText());
        assert.equal(money(await card.locator('.citem-amt').innerText()),15000);
        assert.match(await card.innerText(),/Conso :\s*40 m³/);
        console.log('paid-arrears OK');
    } finally { await browser.close(); server.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
