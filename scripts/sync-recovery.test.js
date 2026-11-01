'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.ASUFOR_SYNC_SOURCE || path.join(__dirname, '..', 'sync.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fresh() {
    const timers = new Set();
    const sandbox = {
        console, navigator: { onLine: true },
        __ASUFOR_SYNC: { timeout: 20, retries: 0, debounce: 1, offlineAfter: 5, recoveryDelay: 20, recoveryMax: 80, resyncTimeout: 25 },
        setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }
    };
    vm.runInNewContext(source, sandbox);
    return { S: sandbox.AsuforSync, nav: sandbox.navigator, stop() { timers.forEach(clearTimeout); } };
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('Firebase connecté prime sur un ancien état navigateur hors ligne', async ({ S, nav }) => {
    nav.onLine = false;
    S.init(); S._setConnected(true);
    assert.equal(S.status(), 'synced');
});

test('le démarrage sans confirmation Firebase reste en reconnexion', async ({ S }) => {
    S.init();
    assert.equal(S.status(), 'reconnecting');
});

test('une lecture en cache hors ligne ne marque pas les données synchronisées', async ({ S }) => {
    S._setConnected(false);
    const result = await S.safeGet(async () => 'copie locale', {});
    assert.equal(result, 'copie locale');
    assert.equal(S.lastSync(), 0);
});

test('une reprise bloquée expire et le prochain essai peut aboutir', async ({ S }) => {
    const off = S.onResync(() => new Promise(() => {}));
    const result = await Promise.race([S.resync('bloquée', { force: true }), sleep(150).then(() => 'toujours bloquée')]);
    assert.equal(result, false);
    off();
    S.onResync(async () => true);
    assert.equal(await S.resync('nouvel essai', { force: true }), true);
});

test('une ancienne lecture en échec ne dégrade pas une reconnexion déjà réussie', async ({ S }) => {
    let rejectOld;
    S._setConnected(false);
    const old = S.safeGet(() => new Promise((resolve, reject) => { rejectOld = reject; }), {}, { retries: 0 });
    S._setConnected(true);
    await S.safeGet(async () => 'données récentes', {});
    rejectOld(Object.assign(new Error('ancienne connexion'), { code: 'NETWORK' }));
    await assert.rejects(old);
    assert.equal(S.status(), 'synced');
});

test('un handler qui renvoie false ne devient pas une synchronisation réussie', async ({ S }) => {
    S.onResync(async () => false);
    assert.equal(await S.resync('échec', { force: true }), false);
    assert.equal(S.lastSync(), 0);
    assert.equal(S.status(), 'reconnecting');
});

test('une connexion bloquée est rouverte puis les données sont relues automatiquement', async ({ S }) => {
    let notify, offline = 0, online = 0, reads = 0;
    S.onResync(async () => { reads++; });
    S.init({ db: {}, ref: (db, p) => p, onValue(p, callback) { notify = callback; callback({ val: () => false }); return () => {}; },
        goOffline() { offline++; }, goOnline() { online++; notify({ val: () => true }); } });
    await sleep(90);
    assert.equal(offline, 1); assert.equal(online, 1);
    assert.ok(reads >= 1);
    assert.equal(S.status(), 'synced');
});

test('aucune réouverture si le navigateur est hors ligne ; reprise au retour', async ({ S, nav }) => {
    let notify, opens = 0;
    nav.onLine = false;
    S.init({ db: {}, ref: (db, p) => p, onValue(p, callback) { notify = callback; callback({ val: () => false }); return () => {}; },
        goOffline() {}, goOnline() { opens++; notify({ val: () => true }); } });
    await sleep(65);
    assert.equal(opens, 0);
    nav.onLine = true;
    await S.retry('retour');
    assert.equal(opens, 1);
    assert.equal(S.status(), 'synced');
});

test('une connexion saine n’est pas rouverte pendant une reprise manuelle', async ({ S }) => {
    let opens = 0;
    S.init({ db: {}, goOffline() { opens++; }, goOnline() { opens++; } });
    S._setConnected(true);
    await S.retry('manuel');
    assert.equal(opens, 0);
});

test('le bouton Réessayer peut contredire un signal navigateur hors ligne périmé', async ({ S, nav }) => {
    let notify, opens = 0;
    nav.onLine = false;
    S.init({ db: {}, ref: (db, p) => p, onValue(p, callback) { notify = callback; callback({ val: () => false }); return () => {}; },
        goOffline() {}, goOnline() { opens++; notify({ val: () => true }); } });
    await S.retry('badge');
    assert.equal(opens, 1);
    assert.equal(S.status(), 'synced');
});

test('une connexion active attend ses sources de données avant d’indiquer Synchronisé', async ({ S }) => {
    S._setConnected(true);
    S.reportSource('stats:archives', 'pending');
    S.markSynced();
    assert.equal(S.status(), 'reconnecting');
    S.reportSource('stats:archives', 'slow');
    assert.equal(S.status(), 'reconnecting');
    S.reportSource('stats:archives', 'ready');
    assert.equal(S.status(), 'synced');
    S.reportSource('stats:archives', null);
    assert.equal(S.status(), 'synced');
});

(async () => {
    let failures = 0;
    for (const [name, fn] of tests) {
        const instance = fresh();
        try { await fn(instance); console.log('✓ ' + name); }
        catch (error) { failures++; console.error('✗ ' + name + ': ' + error.message); }
        finally { instance.stop(); }
    }
    console.log(`${tests.length - failures}/${tests.length} tests de reprise réussis`);
    process.exitCode = failures ? 1 : 0;
})();
