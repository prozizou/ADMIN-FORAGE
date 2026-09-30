/**
 * sync.test.js — Tests de sync.js (lecture sûre, état de connexion, reprises, listeners)
 * Exécution : node scripts/sync.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

globalThis.__ASUFOR_SYNC = { timeout: 60, retries: 2, backoff: [10, 20], staleMs: 200, offlineAfter: 40, debounce: 5, minResume: 0 };
const S = require(path.join(__dirname, '..', 'sync.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('safeGet : succès direct, marque la synchro', async () => {
    const snap = { val: () => 1 };
    const before = S.lastSync();
    const r = await S.safeGet(async () => snap, {});
    assert.strictEqual(r, snap);
    assert.ok(S.lastSync() > before);
    assert.strictEqual(S.status(), 'synced');
});

test('safeGet : lecture bloquée → TIMEOUT après 3 tentatives (jamais infini)', async () => {
    let calls = 0;
    const t0 = Date.now();
    await assert.rejects(() => S.safeGet(() => { calls++; return new Promise(() => {}); }, {}), (e) => e.code === 'TIMEOUT');
    assert.strictEqual(calls, 3);
    assert.ok(Date.now() - t0 < 1000, 'doit se terminer vite');
    assert.strictEqual(S.status(), 'reconnecting');
});

test('safeGet : échec puis succès → nouvelle tentative réussie, retour à « Synchronisé »', async () => {
    let calls = 0;
    const r = await S.safeGet(async () => { calls++; if (calls < 3) throw Object.assign(new Error('offline'), { code: 'NETWORK' }); return 'ok'; }, {});
    assert.strictEqual(r, 'ok'); assert.strictEqual(calls, 3);
    assert.strictEqual(S.status(), 'synced');
});

test('safeGet : PERMISSION_DENIED n\'est jamais retenté', async () => {
    let calls = 0;
    await assert.rejects(() => S.safeGet(async () => { calls++; throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); }, {}), (e) => e.code === 'PERMISSION_DENIED');
    assert.strictEqual(calls, 1);
});

test('safeGet : une réponse tardive après le délai est ignorée', async () => {
    let calls = 0, late;
    const r = S.safeGet(() => { calls++; if (calls === 1) return new Promise((res) => { late = res; }); return Promise.resolve('frais'); }, {});
    assert.strictEqual(await r, 'frais');
    late('périmé');   // ne doit rien casser
});

test('listeners : track remplace (détache l\'ancien) ; jamais de doublon', async () => {
    let detached = 0;
    S.track('k', () => detached++);
    S.track('k', () => detached++);
    S.track('k', () => detached++);
    assert.strictEqual(detached, 2);
    assert.strictEqual(S.trackedCount(), 1);
    S.track('p:a', () => detached++); S.track('p:b', () => detached++);
    S.untrackPrefix('p:');
    assert.strictEqual(detached, 4);
    S.untrack('k');
    assert.strictEqual(detached, 5);
    assert.strictEqual(S.trackedCount(), 0);
    S.untrack('k');                      // idempotent
    assert.strictEqual(detached, 5);
});

test('connexion : hors ligne → « Reconnexion » puis « Hors ligne » ; retour → reprise automatique', async () => {
    let refreshed = 0;
    const off = S.onResync(async () => { refreshed++; });
    S._setConnected(true);
    S._setConnected(false);
    assert.strictEqual(S.status(), 'reconnecting');
    await sleep(70);
    assert.strictEqual(S.status(), 'offline');
    S._setConnected(true);
    await sleep(40);
    assert.strictEqual(refreshed, 1, 'un rafraîchissement automatique après reconnexion');
    assert.strictEqual(S.status(), 'synced');
    off();
});

test('reprise : données récentes → rien ; données anciennes → une seule reprise (dédoublonnée)', async () => {
    let n = 0;
    const off = S.onResync(async () => { n++; });
    S.markSynced();
    assert.strictEqual(await S.resync('visible'), false);
    assert.strictEqual(n, 0);
    await sleep(230);                                   // > staleMs
    await Promise.all([S.resync('visible'), S.resync('pageshow'), S.resync('online')]);
    assert.strictEqual(n, 1, 'un seul rafraîchissement malgré 3 déclencheurs');
    assert.strictEqual(S.isStale(), false);
    off();
});

test('reprise : un rafraîchissement en échec ne bloque pas les autres', async () => {
    let ok = 0;
    const a = S.onResync(async () => { throw new Error('boom'); });
    const b = S.onResync(async () => { ok++; });
    await S.resync('manual', { force: true });
    assert.strictEqual(ok, 1);
    a(); b();
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
    }
    console.log('\n' + (tests.length - failed) + ' test(s) réussi(s), ' + failed + ' échec(s).');
    process.exit(failed ? 1 : 0);
})();
