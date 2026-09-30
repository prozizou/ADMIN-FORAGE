/**
 * smoke.test.js — Test de fumée NAVIGATEUR (Chromium via playwright-core)
 *
 * Charge les vraies pages (statistiques, impression, maintenance/clôture) avec un Firebase
 * SIMULÉ en mémoire (modules gstatic remplacés à la volée) : aucun réseau, aucune donnée réelle.
 * Vérifie les parcours modifiés : cumul intégral des arriérés, encaissement bloqué avant le
 * chargement des archives, cascade de règlement / correction, corrections d'arriérés
 * persistantes, clôture atomique.
 *
 * Exécution (depuis scripts/smoke/) :  npm install && npm test
 *   CHROMIUM_PATH=/chemin/vers/chromium  pour utiliser un Chromium déjà installé
 *   (sinon : npx playwright-core install chromium).
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const FA = 'Asufor_a';

// ── serveur statique ──
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});

// ── Firebase simulé (modules ES injectés à la place des CDN gstatic) ──
const FB_APP = `export const initializeApp = () => ({}); export const deleteApp = async () => {};`;
const FB_AUTH = `const A = {}; export const getAuth = () => A; export const onAuthStateChanged = (a, cb) => { setTimeout(() => { A.currentUser = { uid: 'u1', email: 'x@asufor.local' }; cb(A.currentUser); }, 0); return () => {}; };
export const createUserWithEmailAndPassword = async () => ({ user: { uid: 'x' } }); export const signOut = async () => {};`;
const FB_DB = `
const DB = () => window.__DB;
const seg = (p) => String(p).split('/').filter(Boolean);
const getAt = (p) => { let n = DB().tree; for (const s of seg(p)) { if (n == null || typeof n !== 'object') return null; n = n[s]; } return n === undefined ? null : n; };
const setAt = (p, v) => { const parts = seg(p); let n = DB().tree; for (let i = 0; i < parts.length - 1; i++) { if (n[parts[i]] == null || typeof n[parts[i]] !== 'object') n[parts[i]] = {}; n = n[parts[i]]; }
  const last = parts[parts.length - 1]; if (v === null || v === undefined) delete n[last]; else n[last] = JSON.parse(JSON.stringify(v)); };
const snap = (path, val) => ({ key: seg(path).pop() || null, exists: () => val !== null && val !== undefined, val: () => (val == null ? null : JSON.parse(JSON.stringify(val))),
  forEach: (cb) => { if (val && typeof val === 'object') for (const k of Object.keys(val)) { if (cb(snap(path + '/' + k, val[k])) === true) return true; } return false; } });
export const getDatabase = () => ({});
export const ref = (db, path) => ({ path: path || '' });
export const get = async (r) => { window.__DB.reads.push(r.path); if (DB().hangAll || (DB().hang || []).includes(r.path)) return new Promise(() => {}); if (DB().delays[r.path]) await new Promise(res => setTimeout(res, DB().delays[r.path])); if (DB().failReads.includes(r.path)) throw Object.assign(new Error('offline'), { code: 'NETWORK' }); const n = DB().reads.filter(x => x === r.path).length; if (window.__hook) window.__hook(r.path, n, { getAt, setAt }); return snap(r.path, JSON.parse(JSON.stringify(getAt(r.path)))); };
export const update = async (r, updates) => { if (DB().denyWrites) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  DB().writes.push(JSON.parse(JSON.stringify(updates))); for (const [k, v] of Object.entries(updates)) setAt((r.path ? r.path + '/' : '') + k, v);
  for (const l of DB().listeners) l(); };
export const set = async (r, v) => { setAt(r.path, v); for (const l of DB().listeners) l(); };
export const push = (r) => ({ key: '-Pid' + (DB().pushN = (DB().pushN || 0) + 1), path: r.path + '/-Pid' + DB().pushN });
export const onValue = (r, cb, errCb) => {
  if (r.path === '.info/connected') { const fire = () => cb(snap(r.path, DB().connected !== false)); DB().connListeners = (DB().connListeners || []).concat([fire]); setTimeout(fire, 0); return () => { DB().connListeners = DB().connListeners.filter(x => x !== fire); }; }
  const fire = () => { if (DB().failListen && DB().failListen.includes(r.path)) { if (errCb) errCb(Object.assign(new Error('listen'), { code: 'NETWORK' })); return; } if (DB().hangAll) return; cb(snap(r.path, getAt(r.path))); };
  DB().listeners.push(fire); DB().onValueCount = (DB().onValueCount || 0) + 1; setTimeout(fire, 0); return () => { DB().listeners = DB().listeners.filter(x => x !== fire); }; };
const childReg = (p) => { DB().child = DB().child || {}; DB().child[p] = (DB().child[p] || 0) + 1; let off = false; return () => { if (!off) { off = true; DB().child[p]--; } }; };
export const onChildAdded = (r) => childReg(r.path + '#add'); export const onChildChanged = (r) => childReg(r.path + '#chg'); export const onChildRemoved = (r) => childReg(r.path + '#rem');
export const runTransaction = async () => ({ committed: true });
`;

const rec = (over) => Object.assign({ name: 'Client', numero_compteur: '1', zone: 'Nord', last_index: '0', new_index: 0, facteur: 250, status: 'impaye', statut: false, agent_id: 'ag1' }, over || {});

function seed() {
    return {
        Asufor: {
            [FA]: {
                config: { nom: 'Forage A' },
                agents: { ag1: { agent: 'Agent Un', zone: 'Nord', agent_tel: '771234567' } },
                compteurs: {
                    c1: rec({ name: 'Aminata', numero_compteur: '1', last_index: '24', new_index: 30 }),      // facture 1500
                    c2: rec({ name: 'Boubacar', numero_compteur: '2', last_index: '10', new_index: 12 }),     // facture 500
                    c3: rec({ name: 'Coumba', numero_compteur: '3', last_index: '5', new_index: 9, status: 'paye', statut: true })
                },
                backup: {
                    '2026-06': { info: { cycle: '2026-06' }, donnees: {
                        c1: rec({ name: 'Aminata', last_index: '0', new_index: 20 }),                          // 5000 impayé
                        c2: rec({ name: 'Boubacar', numero_compteur: '2', last_index: '0', new_index: 4, status: 'paye', statut: true }),
                        ghost: rec({ name: 'Parti', numero_compteur: '9', last_index: '0', new_index: 8 })     // 2000, plus de compteur
                    } },
                    '2026-07': { info: { cycle: '2026-07' }, donnees: {
                        c1: rec({ name: 'Aminata', last_index: '20', new_index: 24 }),                         // 1000 impayé
                        c2: rec({ name: 'Boubacar', numero_compteur: '2', last_index: '4', new_index: 10 })    // 1500 impayé
                    } }
                }
            }
        }
    };
}

async function newPage(browser, role, tree, opts) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(([r, f]) => {
        localStorage.setItem('asufor_session', JSON.stringify({ role: r, time: Date.now(), forageKey: f, email: 'x@asufor.local' }));
    }, [role, FA]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
    page.on('dialog', d => d.accept());
    await page.addInitScript((t) => { window.__DB = { tree: t, reads: [], writes: [], listeners: [], delays: {}, failReads: [], denyWrites: false }; }, tree);
    await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return route.continue();
        if (/firebase-app\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FB_APP });
        if (/firebase-auth\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FB_AUTH });
        if (/firebase-database\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: FB_DB });
        return route.fulfill({ status: 200, contentType: /\.css/.test(url) ? 'text/css' : 'text/javascript', body: '' });
    });
    return { page, errors, ctx };
}

const db = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__DB.tree)));
const Compta = require(path.join(ROOT, 'compta.js'));
function applyUpdates(tree, updates) {
    Object.keys(updates).forEach((k) => {
        const parts = k.split('/'); let n = tree;
        for (let i = 0; i < parts.length - 1; i++) { if (n[parts[i]] == null || typeof n[parts[i]] !== 'object') n[parts[i]] = {}; n = n[parts[i]]; }
        const last = parts[parts.length - 1];
        if (updates[k] === null) delete n[last]; else n[last] = JSON.parse(JSON.stringify(updates[k]));
    });
    return tree;
}
/** Base simulée APRÈS migration comptable (factures « migration_backup » créées par compta.js). */
function migratedSeed(t) {
    t = t || seed();
    const F = t.Asufor[FA];
    let n = 0;
    const r = Compta.buildMigrationOps(Compta.emptyState(), {
        paths: Compta.pathsFor('Asufor/' + FA), backup: F.backup, compteurs: F.compteurs,
        now: new Date(Date.now() - 3600e3).toISOString(), user: { uid: 'u1', nom: 'Président', role: 'président' }, newId: () => 'mig' + (++n)
    });
    return applyUpdates(t, r.updates);
}
const num = (t) => parseInt(String(t).replace(/[^\d-]/g, ''), 10) || 0;

module.exports = { server, newPage, seed, FA, chromium };
async function main() {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    let failures = 0;
    const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('  ✓ ' + name), (e) => { failures++; console.log('  ✗ ' + name + '\n    ' + (e.message || e)); });

    // ══════════ STATISTIQUES v7 : migration comptable ══════════
    console.log('Statistiques — migration comptable');
    {
        const { page, errors } = await newPage(browser, 'président', seed());
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await check('avant migration : bandeau « Migrer » (président) et encaissement bloqué', async () => {
            await page.waitForSelector('#compta-migration .cui-banner button', { timeout: 8000 });
            const dis = await page.$$eval('#releves-list .btn-paye', bs => bs.length > 0 && bs.every(b => b.disabled));
            assert.ok(dis, 'Encaisser doit être grisé avant la migration');
            await page.evaluate(() => window.encaisser('c1'));
            assert.match(await page.textContent('#toast'), /Migration comptable requise/);
        });
        await check('avant migration : arriérés affichés depuis les archives (Aminata = 1 500 + 6 000)', async () => {
            const t = await page.$$eval('#releves-list .item', els => els.map(e => e.innerText));
            assert.ok(/7[,.\s  ]?500/.test(t.find(x => x.includes('Aminata'))));
        });
        await check('migration : aperçu (9 500 F, 4 factures), sauvegarde téléchargée OBLIGATOIRE, puis exécution', async () => {
            await page.click('#compta-migration .cui-banner button');
            await page.waitForSelector('.cui-box #cui-run', { timeout: 8000 });
            assert.match(await page.textContent('.cui-box'), /9[\s  ]?500 F/);
            assert.strictEqual(await page.$eval('#cui-run', b => b.disabled), true);
            const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cui-save')]);
            assert.match(dl.suggestedFilename(), /sauvegarde-avant-migration/);
            await page.waitForFunction(() => !document.getElementById('cui-run').disabled);
            await page.click('#cui-run');
            await page.waitForFunction(() => /Migration effectuée/.test(document.querySelector('.cui-box').textContent), null, { timeout: 8000 });
            const t = await db(page);
            const F = t.Asufor[FA];
            assert.strictEqual(F.migration_comptable.v1.total_arrieres, 9500);
            assert.strictEqual(F.migration_comptable.v1.nb_factures_migrees, 4);
            assert.strictEqual(F.migration_comptable.v1.releves_marques_payes, 1);      // c3 : signalé, aucun paiement inventé
            assert.strictEqual(F.paiements, undefined);
            assert.deepStrictEqual(Object.keys(F.factures).sort(), ['2026-06_c1', '2026-06_ghost', '2026-07_c1', '2026-07_c2']);
            assert.ok(Object.values(F.factures).every(f => f.source === 'migration_backup'));
            assert.deepStrictEqual(F.backup, seed().Asufor[FA].backup, 'archives intactes');
        });
        await check('aucune erreur JavaScript (migration)', () => assert.deepStrictEqual(errors, []));
        await page.context().close();
    }

    // ══════════ STATISTIQUES v8 : liste des relevés, mobile strict ══════════
    console.log('Statistiques — liste mobile');
    for (const width of [320, 360, 390]) {
        const t8 = migratedSeed();
        t8.Asufor[FA].compteurs.c4 = rec({ name: 'Mamadou Abdoulaye Ndiaye Diallo', numero_compteur: '1204', zone: 'Quartier Médina Extension', last_index: '40', new_index: 0 });
        t8.Asufor[FA].compteurs.c1.new_index = 0;                                          // Aminata : à relever, avec 6 000 F d'arriérés
        const { page, errors, ctx } = await newPage(browser, 'président', t8);
        await page.setViewportSize({ width, height: 780 });
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => [...document.querySelectorAll('#releves-list .btn-paye')].every(b => !b.disabled), null, { timeout: 8000 });
        await check(`mobile ${width}px : titre, recherche, filtres, aucun scroll horizontal`, async () => {
            assert.match(await page.textContent('.list-title'), /Relevés de compteurs/);
            assert.deepStrictEqual(await page.$$eval('.chip', c => c.map(x => x.textContent.trim())), ['Tous', 'À relever', 'Relevés', 'Trier']);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.ok(over <= 0, 'scroll horizontal de ' + over + 'px');
        });
        await check(`mobile ${width}px : tableau de bord compact (en-tête, filtres, bilan, onglets sur une ligne)`, async () => {
            const rows = await page.evaluate(() => {
                const top = (sel) => [...document.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().top));
                const same = (a) => new Set(a).size === 1;
                const inView = [...document.querySelectorAll('.header, .filters-line, .recap-card, .tabs, .recap-grid > *')].every(e => e.getBoundingClientRect().right <= window.innerWidth + 0.5);
                return {
                    header: document.querySelector('.header').getBoundingClientRect().height < 56, filtres: same(top('.filters-line select')), onglets: same(top('.tab-btn')),
                    kpi: document.querySelectorAll('.recap-grid > *').length, inView, pct: document.getElementById('recap-pct').textContent
                };
            });
            assert.ok(rows.header, 'en-tête sur plusieurs lignes');
            assert.ok(rows.filtres, 'Agent et Mois pas sur la même ligne');
            assert.ok(rows.onglets, 'onglets sur plusieurs lignes');
            assert.strictEqual(rows.kpi, 5);
            assert.ok(rows.inView, 'élément hors écran');
            assert.match(rows.pct, /^\d+,\d % encaissé$/);
        });
        await check(`mobile ${width}px : actions sur une seule ligne, sans débordement de la carte`, async () => {
            await page.click('#chip-non-releves');
            await page.waitForFunction(() => document.querySelectorAll('#releves-list .bg-non-releve').length > 0);
            const bad = await page.evaluate(() => [...document.querySelectorAll('#releves-list .item')].flatMap((it) => {
                const cr = it.getBoundingClientRect(); const out = [];
                const row = it.querySelector('.citem-actions'); if (!row) return out;
                const tops = new Set([...row.children].map(b => Math.round(b.getBoundingClientRect().top)));
                if (tops.size > 1) out.push('actions sur plusieurs lignes');
                row.querySelectorAll('button,a').forEach((b) => {
                    const r = b.getBoundingClientRect();
                    if (r.right > cr.right + 0.5 || r.left < cr.left - 0.5) out.push('bouton hors carte : ' + b.textContent.trim());
                    if (b.scrollWidth > b.clientWidth + 1) out.push('texte coupé : ' + b.textContent.trim());
                });
                return out;
            }));
            assert.deepStrictEqual(bad, []);
            const labels = await page.$$eval('.bg-non-releve .citem-actions > *', b => b.map(x => x.textContent.trim()));
            assert.ok(labels.includes('Relever') && labels.includes('Relevé'), labels.join('|'));
        });
        if (width === 360) await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/liste-360.png' : '/tmp/liste-360.png' });
        if (width === 360) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/haut-360.png' }); }
        await check(`mobile ${width}px : aucune erreur JavaScript`, () => assert.deepStrictEqual(errors, []));
        await ctx.close();
    }

    // ══════════ SYNCHRONISATION FIREBASE : lecture bloquée, réseau coupé/rétabli, reprise, listeners ══════════
    console.log('Synchronisation — robustesse');
    const SYNC_CFG = { timeout: 400, retries: 1, backoff: [50], offlineAfter: 300, debounce: 40, staleMs: 300, minResume: 0, fast: true, hydrate: 700 };
    const CPATH = 'Asufor/' + FA + '/compteurs';
    const CKEY = 'asufor_cache_v1:releves:' + CPATH;
    const syncPage = async (opts) => {
        opts = opts || {};
        const r = await newPage(browser, 'président', opts.tree || migratedSeed());
        await r.page.addInitScript(([cfg, hang, fail, cache, ckey, wd]) => {
            window.__ASUFOR_SYNC = cfg; window.__ASUFOR_WATCHDOG_MS = wd;
            if (hang) window.__DB.hang = hang; if (fail) window.__DB.failListen = fail;
            if (cache) localStorage.setItem(ckey, JSON.stringify(cache));
        }, [Object.assign({}, SYNC_CFG, opts.cfg || {}), opts.hang || null, opts.fail || null, opts.cache || null, CKEY, 1200]);
        await r.page.goto(base + '/statistiques/stats.html');
        return r;
    };
    const count = (page) => page.$$eval('#releves-list .item', e => e.length);
    const badge = (page) => page.evaluate(() => (document.getElementById('asufor-sync-badge') || {}).textContent || '');
    const reads = (page, p) => page.evaluate((p) => window.__DB.reads.filter(x => x === p).length, p);
    const connect = (page, v) => page.evaluate((v) => { window.__DB.connected = v; (window.__DB.connListeners || []).forEach(f => f()); }, v);

    {   // 1) lecture bloquée, aucune copie locale : « Connexion lente » + Réessayer, jamais de spinner infini
        const { page, errors, ctx } = await syncPage({ hang: [CPATH] });
        await check('lecture bloquée sans cache : après le délai, « Connexion lente » + Réessayer (pas de spinner infini)', async () => {
            // « Connexion lente » (chien de garde) ou message d'échec de lecture : dans les deux cas un bouton Réessayer, jamais un spinner infini
            await page.waitForFunction(() => { const r = document.getElementById('asufor-loader-root'); return r && r.classList.contains('on') && (r.classList.contains('slow') || r.classList.contains('error')) && [...r.querySelectorAll('.al-btn')].some(b => /Réessayer/.test(b.textContent)); }, null, { timeout: 6000 });
            assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#asufor-loader-root .al-spin')).display === 'none'), 'le spinner doit être masqué');
        });
        await check('lecture rétablie : « Réessayer » récupère les données sans recharger la page', async () => {
            await page.evaluate(() => { window.__DB.hang = []; });
            await page.evaluate(() => [...document.querySelectorAll('#asufor-loader-root .al-btn')].find(b => /Réessayer/.test(b.textContent)).click());
            await page.waitForSelector('#releves-list .item', { timeout: 8000 });
            await page.waitForFunction(() => !document.getElementById('asufor-loader-root').classList.contains('on'), null, { timeout: 5000 });
        });
        await check('aucune erreur JavaScript (lecture bloquée)', () => assert.deepStrictEqual(errors.filter(e => !/Firebase relevés|Firebase agents|\[Compta\]|TIMEOUT|trop lente/.test(e)), []));
        await ctx.close();
    }

    {   // 1b) chien de garde du loader : lecture très lente (délai de lecture > chien de garde) → « Connexion lente » + Réessayer / Continuer
        const { page, ctx } = await syncPage({ hang: [CPATH], cfg: { timeout: 20000, retries: 0 } });
        await check('chien de garde : « Connexion lente » + Réessayer + Continuer après ~12 s (ici 1,2 s), spinner masqué', async () => {
            await page.waitForFunction(() => { const r = document.getElementById('asufor-loader-root'); return r && r.classList.contains('slow') && /Connexion lente/.test(r.textContent); }, null, { timeout: 6000 });
            const labels = await page.$$eval('#asufor-loader-root .al-btn', b => b.map(x => x.textContent.trim()));
            assert.deepStrictEqual(labels, ['Réessayer', 'Continuer']);
            assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#asufor-loader-root .al-spin')).display), 'none');
            await page.evaluate(() => [...document.querySelectorAll('#asufor-loader-root .al-btn')].find(b => /Continuer/.test(b.textContent)).click());
            await page.waitForFunction(() => !document.getElementById('asufor-loader-root').classList.contains('on'));
        });
        await ctx.close();
    }

    {   // 2) lecture bloquée AVEC copie locale : affichage immédiat, jamais vidé
        const t = migratedSeed();
        const { page, ctx } = await syncPage({ tree: t, hang: [CPATH], cache: t.Asufor[FA].compteurs });
        await check('lecture bloquée avec cache : données locales affichées immédiatement, écran jamais bloqué', async () => {
            await page.waitForSelector('#releves-list .item', { timeout: 3000 });
            assert.ok((await count(page)) >= 3);
            assert.ok(await page.evaluate(() => !document.getElementById('asufor-loader-root') || !document.getElementById('asufor-loader-root').classList.contains('on')));
        });
        await check('statut : « Reconnexion » / « Hors ligne — données locales » (jamais « Synchronisé » à tort)', async () => {
            await page.waitForFunction(() => /Reconnexion|Hors ligne/.test((document.getElementById('asufor-sync-badge') || {}).textContent || ''), null, { timeout: 6000 });
            assert.ok((await count(page)) >= 3, 'la liste ne doit pas être vidée');
        });
        await ctx.close();
    }

    {   // 3) réseau coupé puis rétabli + 4) retour d'arrière-plan + 5) navigation répétée
        const { page, errors, ctx } = await syncPage();
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => /Synchronisé/.test((document.getElementById('asufor-sync-badge') || {}).textContent || ''), null, { timeout: 5000 });
        await page.evaluate(() => { window.__minItems = 999; new MutationObserver(() => { window.__minItems = Math.min(window.__minItems, document.querySelectorAll('#releves-list .item').length); }).observe(document.getElementById('releves-list'), { childList: true, subtree: true }); });
        const n0 = await count(page);

        await check('réseau coupé : « Hors ligne — données locales », liste conservée ; rétabli : resynchronisation automatique', async () => {
            const r0 = await reads(page, CPATH);
            await connect(page, false);
            await page.waitForFunction(() => /Reconnexion/.test(document.getElementById('asufor-sync-badge').textContent));
            await page.waitForFunction(() => /Hors ligne — données locales/.test(document.getElementById('asufor-sync-badge').textContent), null, { timeout: 4000 });
            assert.strictEqual(await count(page), n0);
            await connect(page, true);
            await page.waitForFunction(() => /Synchronisé/.test(document.getElementById('asufor-sync-badge').textContent), null, { timeout: 5000 });
            await page.waitForFunction(([p, n]) => window.__DB.reads.filter(x => x === p).length > n, [CPATH, r0], { timeout: 5000 });   // relecture automatique après la reconnexion
            assert.match(await badge(page), /\d\d:\d\d/, 'heure de dernière synchro');
        });
        await check('retour d\'arrière-plan (visibilitychange) avec données anciennes : rafraîchissement silencieux, liste jamais vidée', async () => {
            await page.waitForTimeout(400);                                   // > staleMs
            const r0 = await reads(page, CPATH);
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await page.waitForTimeout(600);
            assert.ok((await reads(page, CPATH)) > r0, 'relecture attendue');
            assert.ok(await page.evaluate(() => window.__minItems) >= n0 || (await page.evaluate(() => window.__minItems)) >= 1, 'liste vidée pendant la resynchro');
        });
        await check('pageshow (bfcache) et online déclenchent aussi une reprise ; doublons évités', async () => {
            await page.waitForTimeout(400);
            const r0 = await reads(page, CPATH);
            await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
            await page.waitForTimeout(700);
            const r1 = await reads(page, CPATH);
            assert.ok(r1 > r0, 'reprise attendue'); assert.ok(r1 - r0 <= 2, 'reprises dédoublonnées : ' + (r1 - r0));
        });
        await check('navigation répétée : pas de listeners en double (mois ↔ actuel, 6 resynchronisations)', async () => {
            const before = await page.evaluate(() => ({ l: window.__DB.listeners.length, t: window.AsuforSync.trackedCount() }));
            for (let i = 0; i < 6; i++) {
                await page.evaluate(() => window.AsuforSync.resync('manual', { force: true }));
                if (i % 2 === 0) { await page.selectOption('#month-filter', '2026-07'); await page.waitForTimeout(150); await page.selectOption('#month-filter', 'actuel'); }
                await page.waitForTimeout(120);
            }
            await page.waitForTimeout(600);
            const after = await page.evaluate(() => ({ l: window.__DB.listeners.length, t: window.AsuforSync.trackedCount(), child: window.__DB.child }));
            assert.deepStrictEqual(after.t, before.t, 'listeners suivis');
            assert.ok(after.l <= before.l, 'onValue en double : ' + before.l + ' → ' + after.l);
            Object.keys(after.child).forEach(k => assert.ok(after.child[k] <= 1, 'listener enfant en double : ' + k + ' = ' + after.child[k]));
        });
        await check('aucune erreur JavaScript (reprises)', () => assert.deepStrictEqual(errors, []));
        await ctx.close();
    }

    {   // 6) grand livre : un nœud en échec → état dégradé/erreur + Réessayer, jamais « en attente » indéfiniment
        const { page, ctx } = await syncPage({ fail: ['Asufor/' + FA + '/paiements'] });
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await check('nœud comptable en échec : lecture de secours, prêt sans attente infinie, message + Réessayer', async () => {
            await page.waitForFunction(() => window.ComptaUI.isReady(), null, { timeout: 6000 });
            await page.waitForFunction(() => document.getElementById('compta-status').style.display !== 'none', null, { timeout: 5000 });
            assert.match(await page.textContent('#compta-status'), /Comptabilité/);
            assert.ok(['degraded', 'error'].includes(await page.evaluate(() => window.ComptaUI.getStatus().status)));
        });
        await check('nœud rétabli : « Réessayer » ramène l\'état à prêt', async () => {
            await page.evaluate(() => { window.__DB.failListen = []; });
            await page.evaluate(() => window.ComptaUI.retry());
            await page.waitForFunction(() => window.ComptaUI.getStatus().status === 'ready', null, { timeout: 6000 });
            assert.strictEqual(await page.evaluate(() => document.getElementById('compta-status').style.display), 'none');
        });
        await ctx.close();
    }

    {   // 7) impression : statut de synchro, reprise après réseau rétabli, liste jamais vidée
        const r = await newPage(browser, 'président', migratedSeed());
        await r.page.addInitScript((cfg) => { window.__ASUFOR_SYNC = cfg; }, SYNC_CFG);
        await r.page.goto(base + '/impression/impression.html');
        await r.page.waitForSelector('.facture-item', { timeout: 8000 });
        await check('impression : badge « Synchronisé », coupure → « Hors ligne », retour → relecture des archives, liste conservée', async () => {
            await r.page.waitForFunction(() => /Synchronisé/.test((document.getElementById('asufor-sync-badge') || {}).textContent || ''), null, { timeout: 5000 }).catch(async (e) => { throw new Error('badge=' + (await badge(r.page)) + ' Sync=' + (await r.page.evaluate(() => typeof window.AsuforSync))); });
            const n0 = await r.page.$$eval('.facture-item', e => e.length);
            const b0 = await reads(r.page, 'Asufor/' + FA + '/backup');
            await connect(r.page, false);
            await r.page.waitForFunction(() => /Hors ligne — données locales/.test(document.getElementById('asufor-sync-badge').textContent), null, { timeout: 4000 });
            assert.strictEqual(await r.page.$$eval('.facture-item', e => e.length), n0);
            await connect(r.page, true);
            await r.page.waitForFunction(([p, n]) => window.__DB.reads.filter(x => x === p).length > n, ['Asufor/' + FA + '/backup', b0], { timeout: 5000 });
            assert.strictEqual(await r.page.$$eval('.facture-item', e => e.length), n0);
        });
        await r.ctx.close();
    }

    // ══════════ STATISTIQUES v7 : encaissement partiel, FIFO, avance ══════════
    console.log('Statistiques — encaissement');
    let afterPayment = null, paiementId = null;
    {
        const { page, errors } = await newPage(browser, 'trésorier', migratedSeed());
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => [...document.querySelectorAll('#releves-list .btn-paye')].length > 0 && [...document.querySelectorAll('#releves-list .btn-paye')].every(b => !b.disabled), null, { timeout: 8000 });
        await check('après migration : Aminata dû = arriérés 6 000 + relevé du mois 1 500', async () => {
            const t = await page.$$eval('#releves-list .item', els => els.map(e => e.innerText));
            assert.ok(/7[,.\s  ]?500/.test(t.find(x => x.includes('Aminata'))));
        });
        await check('fenêtre d\'encaissement : total dû par défaut, aperçu FIFO, avance et reste après paiement', async () => {
            await page.evaluate(() => window.encaisser('c1'));
            await page.waitForSelector('#cui-montant', { timeout: 8000 });
            assert.strictEqual(await page.inputValue('#cui-montant'), '7500');
            await page.fill('#cui-montant', '7000');
            await page.fill('#cui-ref', 'TX-42');
            const prev = await page.textContent('#cui-prev');
            assert.match(prev, /Juin 2026 : 5[\s  ]?000 F soldée/);
            assert.match(prev, /Juillet 2026 : 1[\s  ]?000 F soldée/);
            assert.match(prev, /Avance créée : 1[\s  ]?000 F/);
            assert.match(prev, /Reste dû après paiement : 500 F/);
        });
        await check('validation : paiement immuable + 2 affectations + factures payées + avance + audit, en UNE écriture', async () => {
            const w0 = await page.evaluate(() => window.__DB.writes.length);
            await page.click('#cui-ok');
            await page.waitForFunction(() => /Encaissement enregistré/.test(document.querySelector('.cui-box').textContent), null, { timeout: 8000 });
            assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), w0 + 1);
            const F = (await db(page)).Asufor[FA];
            const pays = Object.values(F.paiements);
            assert.strictEqual(pays.length, 1);
            const p = pays[0]; paiementId = p.paiement_id;
            assert.deepStrictEqual([p.montant, p.mode, p.reference, p.statut, p.encaisse_par], [7000, 'especes', 'TX-42', 'valide', 'u1']);
            assert.ok(p.numero_recu.length > 0);
            assert.deepStrictEqual(Object.keys(F.affectations[p.paiement_id]).sort(), ['2026-06_c1', '2026-07_c1']);
            assert.strictEqual(F.factures['2026-06_c1'].statut, 'payee');
            assert.strictEqual(F.factures['2026-07_c1'].statut, 'payee');
            assert.strictEqual(F.soldes.c1.avance, 1000);
            assert.strictEqual(F.soldes.c1.arrieres, 0);
            assert.ok(Object.values(F.audit_comptable).some(e => e.action === 'PAIEMENT_CREE' && e.role === 'trésorier'));
            assert.strictEqual(F.compteurs.c1.status, 'impaye');                  // il reste 500 F sur le relevé du mois
            ['apaid', 'arriere', 'arrieres', 'facture', 'print', 'diff'].forEach(k => assert.ok(!(k in F.compteurs.c1), 'champ historique ' + k));
            await page.click('#cui-close');
        });
        await check('indicateurs : Encaissé 7 000 · Arriérés 3 500 (c2 + ancien compteur) · Avances 1 000', async () => {
            await page.waitForFunction(() => /7[\s  ,.]?000/.test(document.getElementById('total-money').textContent), null, { timeout: 8000 });
            assert.strictEqual(num(await page.textContent('#rc-arrieres')), 3500);
            assert.strictEqual(num(await page.textContent('#rc-avances')), 1000);
        });
        await check('« Annuler encaissement » réservé au président : invisible pour le trésorier malgré le paiement existant', async () => {
            assert.strictEqual(await page.$('#releves-list .btn-cancel-pay'), null);
        });
        await check('écriture refusée (droits / concurrence) : message clair, rien d\'écrit', async () => {
            await page.evaluate(() => { window.__DB.denyWrites = true; });
            await page.evaluate(() => window.encaisser('c2'));
            await page.waitForSelector('#cui-ok', { timeout: 8000 });
            const w0 = await page.evaluate(() => window.__DB.writes.length);
            await page.click('#cui-ok');
            await page.waitForFunction(() => /Opération refusée/.test(document.getElementById('cui-err').textContent), null, { timeout: 8000 });
            assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), w0);
            await page.evaluate(() => { window.__DB.denyWrites = false; });
            await page.click('#cui-cancel');
        });
        await check('aucune erreur JavaScript (encaissement)', () => assert.deepStrictEqual(errors.filter(e => !/PERMISSION_DENIED/.test(e)), []));
        afterPayment = await db(page);
        await page.context().close();
    }

    // ══════════ STATISTIQUES v8 : « Annuler encaissement » (correction d'un paiement, président) ══════════
    console.log('Statistiques — annulation d\'un encaissement');
    {
        const { page, errors, ctx } = await newPage(browser, 'président', JSON.parse(JSON.stringify(afterPayment)));
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => document.querySelectorAll('#releves-list .btn-cancel-pay').length > 0, null, { timeout: 8000 });
        await check('bouton visible uniquement sur la carte du client ayant un paiement valide (président)', async () => {
            const has = (name) => page.evaluate((n) => {
                const el = [...document.querySelectorAll('#releves-list .item')].find(e => e.innerText.includes(n));
                return el ? !!el.querySelector('.btn-cancel-pay') : null;
            }, name);
            assert.strictEqual(await has('Aminata'), true);
            assert.strictEqual(await has('Boubacar'), false);   // aucun paiement valide : pas de bouton
        });
        await check('bouton « Annuler » lisible (libellé, pas seulement une icône) et sans débordement à 320 px', async () => {
            await page.setViewportSize({ width: 320, height: 780 });
            const info = await page.evaluate(() => {
                const btn = document.querySelector('#releves-list .btn-cancel-pay');
                if (!btn) return null;
                const card = btn.closest('.item').getBoundingClientRect();
                const r = btn.getBoundingClientRect();
                return { text: btn.textContent.trim(), inside: r.right <= card.right + 0.5 && r.left >= card.left - 0.5, overX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
            assert.ok(info, 'bouton Annuler introuvable');
            assert.match(info.text, /Annuler/);   // libellé visible, plus une simple icône
            assert.ok(info.inside, 'le bouton Annuler déborde de la carte');
            assert.ok(info.overX <= 0, 'scroll horizontal ' + info.overX);
            await page.setViewportSize({ width: 390, height: 780 });
        });
        await check('dialogue : paiement affiché (montant, date, reçu), motif obligatoire, rien sans confirmation', async () => {
            await page.evaluate(() => window.annulerEncaissement('c1'));
            await page.waitForSelector('#cui-yes', { timeout: 8000 });
            const box = await page.textContent('.cui-box');
            assert.match(box, /7[\s\u202f\xa0]?000 F/);
            assert.match(box, /reçu n°/);
            await page.click('#cui-yes');
            assert.match(await page.textContent('#cui-err'), /motif est obligatoire/);
            await page.fill('#cui-motif', 'x');
            await page.click('#cui-yes');
            assert.match(await page.textContent('#cui-err'), /3 caractères/);
        });
        await check('annulation : Encaissé -7 000, arriérés +7 000, UNE écriture, audit PAIEMENT_ANNULE, paiement jamais supprimé', async () => {
            const w0 = await page.evaluate(() => window.__DB.writes.length);
            await page.fill('#cui-motif', 'Montant saisi par erreur');
            await page.click('#cui-yes');
            await page.waitForFunction(() => /Paiement annulé/.test(document.querySelector('.cui-box').textContent), null, { timeout: 8000 });
            assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), w0 + 1);
            const F = (await db(page)).Asufor[FA];
            const p = F.paiements[paiementId];
            assert.strictEqual(p.statut, 'annule');
            assert.strictEqual(p.montant, 7000);                              // jamais supprimé : montant, auteur, date conservés
            assert.strictEqual(p.annule_par, 'u1');
            assert.match(p.motif_annulation, /erreur/);
            assert.ok(Object.values(F.affectations[paiementId]).every(a => a.statut === 'annulee'));
            assert.ok(Object.values(F.audit_comptable).some(e => e.action === 'PAIEMENT_ANNULE' && e.entite_id === paiementId && e.role === 'président'));
            assert.strictEqual(F.soldes.c1.avance, 0);
            assert.strictEqual(F.soldes.c1.arrieres, 6000);                  // les 6 000 d'arriérés qu'il avait réglés redeviennent dus
            await page.click('.cui-box #cui-close2');
        });
        await check('rafraîchissement immédiat sans reload : Bilan (Encaissé/À réclamer), arriérés, carte client, bouton disparu', async () => {
            await page.waitForFunction(() => document.getElementById('total-money').textContent.trim().startsWith('0'), null, { timeout: 8000 });
            assert.strictEqual(num(await page.textContent('#total-money')), 0);       // 7 000 − 7 000
            assert.strictEqual(num(await page.textContent('#rc-arrieres')), 9500);    // 3 500 (inchangé) + 6 000 (Aminata, de nouveau dus)
            const t = await page.$$eval('#releves-list .item', els => els.map(e => e.innerText));
            assert.ok(/7[,.\s\u202f\xa0]?500/.test(t.find(x => x.includes('Aminata'))));      // total dû revenu à l'identique d'avant paiement
            assert.strictEqual(await page.$('#releves-list .btn-cancel-pay'), null);   // plus aucun paiement valide à annuler
        });
        await check('double annulation empêchée proprement (jamais un second contre-passage silencieux)', async () => {
            const err = await page.evaluate((pid) => window.ComptaUI.run((S, base) =>
                window.Compta.buildPaymentCancelOps(S, Object.assign({}, base, { paiementId: pid, motif: 'seconde tentative' }))
            ).then(() => null, (e) => e.message), paiementId);
            assert.match(err, /déjà annulé/);
        });
        await check('aucune erreur JavaScript (annulation)', () => assert.deepStrictEqual(errors.filter(e => !/PERMISSION_DENIED/.test(e)), []));
        await ctx.close();
    }

    // ══════════ STATISTIQUES v8 : encaisser / annuler DEPUIS UNE ARCHIVE (mois passé) ══════════
    console.log('Statistiques — encaissement et annulation depuis une archive');
    {
        const { page, errors, ctx } = await newPage(browser, 'président', migratedSeed());
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => [...document.querySelectorAll('#month-filter option')].some(o => o.value === '2026-06'), null, { timeout: 8000 });
        await page.selectOption('#month-filter', '2026-06');
        await page.waitForSelector('.archive-lock, .item', { timeout: 8000 });
        await page.waitForFunction(() => document.getElementById('archive-banner').classList.contains('visible'));
        let paiementId2;
        await check("encaisser depuis l'archive de juin : le montant par défaut (7 500) vient du relevé RÉELLEMENT en cours (compteur en vigueur), pas de l'archive affichée", async () => {
            // Piège corrigé : si le relevé de l'archive de juin (index 0→20, 5 000 F) était utilisé pour la
            // facture provisoire au lieu du relevé courant (index 24→30, 1 500 F), le montant par défaut
            // serait faux (arriérés 6 000 + 5 000 au lieu de 6 000 + 1 500 = 7 500).
            await page.evaluate(() => window.encaisser('c1'));
            await page.waitForSelector('#cui-montant', { timeout: 8000 });
            assert.strictEqual(await page.inputValue('#cui-montant'), '7500');
            await page.click('#cui-ok');
            await page.waitForFunction(() => /Encaissement enregistré/.test(document.querySelector('.cui-box').textContent), null, { timeout: 8000 });
            const F = (await db(page)).Asufor[FA];
            paiementId2 = Object.values(F.paiements)[0].paiement_id;
            // Le paiement solde tout l'historique (juin + juillet + mois courant) : le compteur EN VIGUEUR
            // (pas l'archive) passe « payé », calculé sur son propre relevé (24 → 30), pas celui de juin.
            assert.strictEqual(F.compteurs.c1.status, 'paye');
            assert.strictEqual(F.soldes.c1.arrieres, 0);
            await page.click('#cui-close');
        });
        await check("annuler ce paiement depuis la même archive : arriérés et statut du compteur EN VIGUEUR recalculés correctement", async () => {
            await page.waitForFunction(() => document.querySelectorAll('#releves-list .btn-cancel-pay').length > 0, null, { timeout: 8000 });
            await page.evaluate(() => window.annulerEncaissement('c1'));
            await page.waitForSelector('#cui-yes', { timeout: 8000 });
            await page.fill('#cui-motif', 'Test : annulation depuis une archive');
            await page.click('#cui-yes');
            await page.waitForFunction(() => /Paiement annulé/.test(document.querySelector('.cui-box').textContent), null, { timeout: 8000 });
            const F = (await db(page)).Asufor[FA];
            assert.strictEqual(F.paiements[paiementId2].statut, 'annule');
            assert.strictEqual(F.soldes.c1.arrieres, 6000);
            assert.strictEqual(F.compteurs.c1.status, 'impaye');   // redevient impayé sur son propre relevé (1 500 dus ce mois)
        });
        await check('aucune erreur JavaScript (encaissement/annulation depuis une archive)', () => assert.deepStrictEqual(errors.filter(e => !/PERMISSION_DENIED/.test(e)), []));
        await ctx.close();
    }

    // ══════════ STATISTIQUES v8 : remettre un mois ARCHIVÉ « Payé » en « Non payé » (président) ══════════
    console.log('Statistiques — archive marquée payée → non payée');
    {
        const { page, errors, ctx } = await newPage(browser, 'président', migratedSeed());
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await page.waitForFunction(() => [...document.querySelectorAll('#month-filter option')].some(o => o.value === '2026-06'), null, { timeout: 8000 });
        await page.selectOption('#month-filter', '2026-06');
        await page.waitForFunction(() => document.getElementById('archive-banner').classList.contains('visible'));
        await page.waitForFunction(() => [...document.querySelectorAll('#releves-list .item')].some(e => e.innerText.includes('Boubacar')), null, { timeout: 8000 });
        const card = (n) => page.evaluate((n) => {
            const el = [...document.querySelectorAll('#releves-list .item')].find(e => e.innerText.includes(n));
            return el ? { paye: /Payé/.test(el.innerText) && !/Impayé/.test(el.innerText), encaisser: !!el.querySelector('.btn-paye'), nonPaye: !!el.querySelector('.btn-unpay') } : null;
        }, n);
        await check('carte archivée « Payé » : bouton « Non payé » présent, pas d\'Encaisser ; carte impayée : pas de « Non payé »', async () => {
            const b = await card('Boubacar'), a = await card('Aminata');
            assert.deepStrictEqual([b.paye, b.encaisser, b.nonPaye], [true, false, true]);
            assert.strictEqual(a.nonPaye, false);
        });
        await check('« Non payé » : motif obligatoire, puis archive impayée + facture créée (dette) + audit, en UNE écriture', async () => {
            await page.evaluate(() => window.marquerNonPaye('c2'));
            await page.waitForSelector('#cui-np-yes', { timeout: 8000 });
            await page.click('#cui-np-yes');
            assert.match(await page.textContent('#cui-np-err'), /motif est obligatoire/);
            await page.fill('#cui-np-motif', 'Paiement jamais reçu');
            const w0 = await page.evaluate(() => window.__DB.writes.length);
            await page.click('#cui-np-yes');
            await page.waitForFunction(() => !document.getElementById('cui-np-yes'), null, { timeout: 8000 });
            assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), w0 + 1);
            const F = (await db(page)).Asufor[FA];
            const row = F.backup['2026-06'].donnees.c2;
            assert.deepStrictEqual([row.status, row.statut, row.date_paiement === undefined, row.correction_motif], ['impaye', false, true, 'Paiement jamais reçu']);
            const f = F.factures['2026-06_c2'];
            assert.deepStrictEqual([f.montant_initial, f.source, f.statut, f.reste_a_payer], [1000, 'correction_releve', 'ouverte', 1000]);
            assert.ok(Object.values(F.audit_comptable).some(e => e.action === 'FACTURE_CREEE' && e.entite_id === '2026-06_c2'));
            assert.strictEqual(F.soldes.c2.arrieres, 2500);                   // 1 500 (juillet) + 1 000 (juin remis en impayé)
            assert.strictEqual(F.paiements, undefined);                        // aucun paiement inventé ni supprimé
        });
        await check('carte rafraîchie : « Impayé », plus de « Non payé », Encaisser disponible', async () => {
            await page.waitForFunction(() => { const el = [...document.querySelectorAll('#releves-list .item')].find(e => e.innerText.includes('Boubacar')); return el && /Impayé/.test(el.innerText); }, null, { timeout: 8000 });
            const b = await card('Boubacar');
            assert.deepStrictEqual([b.paye, b.nonPaye], [false, false]);
        });
        await check('aucune erreur JavaScript (archive non payée)', () => assert.deepStrictEqual(errors.filter(e => !/PERMISSION_DENIED/.test(e)), []));
        await ctx.close();
    }

    // ══════════ RELEVÉ DE COMPTE + REÇU ══════════
    console.log('Relevé de compte et reçu');
    {
        const { page, errors } = await newPage(browser, 'président', JSON.parse(JSON.stringify(afterPayment)));
        await page.goto(base + '/compte/releve.html?c=c1');
        await page.waitForSelector('#timeline .ev', { timeout: 8000 });
        await check('chronologie : 2 factures + 1 paiement (affectations), soldes cohérents', async () => {
            const t = await page.textContent('#timeline');
            assert.match(t, /Facture Juin 2026/); assert.match(t, /Facture Juillet 2026/);
            assert.match(t, /Paiement · reçu n°/);
            assert.strictEqual(num(await page.textContent('#t-avance')), 1000);
            assert.strictEqual(num(await page.textContent('#t-arrieres')), 0);
        });
        for (const width of [320, 360, 390]) {
            await check(`relevé mobile ${width}px : dark, KPI, actions sur une ligne (≥ 44 px), menu ⋮, timeline, aucun débordement`, async () => {
                await page.setViewportSize({ width, height: 780 });
                const r = await page.evaluate(() => {
                    const vis = (e) => e.getBoundingClientRect().width > 0;
                    const row = [...document.querySelectorAll('.card > .actions > .btn')].filter(vis);
                    const tops = new Set(row.map(b => Math.round(b.getBoundingClientRect().top)));
                    const kpi = [...document.querySelectorAll('.kpi')].map(k => k.getBoundingClientRect());
                    return {
                        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                        bg: getComputedStyle(document.body).backgroundColor,
                        oneLine: tops.size === 1, minH: Math.min(...row.map(b => b.getBoundingClientRect().height)),
                        outside: row.filter(b => b.getBoundingClientRect().right > window.innerWidth).length + kpi.filter(k => k.right > window.innerWidth).length,
                        main: [...document.querySelectorAll('.kpis:not(.second) .l')].map(e => e.textContent), second: [...document.querySelectorAll('.kpis.second .l')].map(e => e.textContent),
                        dots: document.querySelectorAll('#timeline .ev .dot').length, meta: document.getElementById('meta').textContent
                    };
                });
                assert.ok(r.over <= 0, 'scroll horizontal ' + r.over);
                assert.strictEqual(r.bg, 'rgb(10, 15, 28)');
                assert.ok(r.oneLine, 'actions sur plusieurs lignes'); assert.ok(r.minH >= 44, 'bouton trop bas : ' + r.minH); assert.strictEqual(r.outside, 0);
                assert.deepStrictEqual(r.main, ['Facturé', 'Payé', 'Solde à payer']); assert.deepStrictEqual(r.second, ['Arriérés', 'Avance', 'Ajustements']);
                assert.ok(r.dots >= 3); assert.match(r.meta, /Compteur n°1/); assert.match(r.meta, /Nord/);
                await page.click('#btn-more');
                assert.ok(await page.isVisible('#menu'));
                await page.keyboard.press('Escape');
                assert.ok(!(await page.isVisible('#menu')));
            });
        }
        if (true) { await page.setViewportSize({ width: 360, height: 780 }); await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/releve-360.png' }); }
        await check('reçu imprimable : n°, montant, factures réglées, avance', async () => {
            const r = await newPage(browser, 'président', JSON.parse(JSON.stringify(afterPayment)));
            await r.page.goto(base + '/compte/recu.html?p=' + encodeURIComponent(paiementId));
            await r.page.waitForSelector('.recu', { timeout: 8000 });
            const t = await r.page.textContent('.recu');
            assert.match(t, /REÇU DE PAIEMENT N°/); assert.match(t, /7[\s  ]?000 FCFA/);
            assert.match(t, /Juin 2026/); assert.match(t, /Avance/);
            await r.page.context().close();
        });
        await check('président : annulation motivée → paiement « annule » conservé, factures rouvertes', async () => {
            await page.click('[data-cancel]');
            await page.fill('#mot', 'Billet refusé à la banque');
            await page.click('#ok');
            await page.waitForFunction(() => /annulé/.test(document.getElementById('timeline').textContent), null, { timeout: 8000 });
            const F = (await db(page)).Asufor[FA];
            const p = F.paiements[paiementId];
            assert.deepStrictEqual([p.statut, p.montant, p.motif_annulation], ['annule', 7000, 'Billet refusé à la banque']);
            assert.strictEqual(F.factures['2026-06_c1'].reste_a_payer, 5000);
            assert.strictEqual(F.soldes.c1.arrieres, 6000);
            assert.ok(Object.values(F.audit_comptable).some(e => e.action === 'PAIEMENT_ANNULE'));
        });
        await check('ajustement : remise validée par le président (motif obligatoire), facture figée intacte', async () => {
            await page.click('#btn-adj');
            await page.selectOption('#typ', 'remise');
            await page.fill('#mnt', '500');
            await page.click('#ok');
            assert.match(await page.textContent('#err'), /motif/i);
            await page.fill('#mot', 'Fuite sur le réseau public');
            await page.click('#ok');
            await page.waitForFunction(() => /Remise/.test(document.getElementById('timeline').textContent), null, { timeout: 8000 });
            const F = (await db(page)).Asufor[FA];
            const j = Object.values(F.ajustements)[0];
            assert.deepStrictEqual([j.type, j.statut, j.montant], ['remise', 'valide', 500]);
            const f = F.factures[j.facture_id];
            assert.strictEqual(f.montant_net, f.montant_initial - 500);
        });
        await check('aucune erreur JavaScript (relevé)', () => assert.deepStrictEqual(errors, []));
        await page.context().close();
    }
    {
        const { page } = await newPage(browser, 'trésorier', JSON.parse(JSON.stringify(afterPayment)));
        await page.goto(base + '/compte/releve.html?c=c1');
        await page.waitForSelector('#timeline .ev', { timeout: 8000 });
        await check('trésorier : ne peut pas annuler un paiement ; son ajustement reste « en attente »', async () => {
            assert.strictEqual(await page.$('[data-cancel]'), null);
            await page.click('#btn-adj');
            await page.selectOption('#typ', 'majoration');
            await page.fill('#mnt', '300');
            await page.fill('#mot', 'Frais de réouverture');
            await page.click('#ok');
            await page.waitForFunction(() => /en attente/.test(document.getElementById('timeline').textContent), null, { timeout: 8000 });
            const j = Object.values((await db(page)).Asufor[FA].ajustements)[0];
            assert.strictEqual(j.statut, 'en_attente');
            assert.strictEqual(await page.$('[data-validate]'), null);
        });
        await page.context().close();
    }

    // ══════════ IMPRESSION (grand livre) ══════════
    console.log('Impression — grand livre');
    {
        const { page, errors } = await newPage(browser, 'président', JSON.parse(JSON.stringify(afterPayment)));
        await page.goto(base + '/impression/impression.html');
        await page.waitForSelector('.facture-item', { timeout: 8000 });
        await check('arriérés et avance depuis le grand livre (c1 : 0 d\'arriéré, 1 000 d\'avance ; c2 : 1 500)', async () => {
            await page.waitForFunction(() => document.getElementById('av-c1'), null, { timeout: 8000 });
            assert.strictEqual(num(await page.textContent('#arr-c1')), 0);
            assert.strictEqual(num(await page.textContent('#av-c1')), 1000);
            assert.strictEqual(num(await page.textContent('#total-c1')), 500);      // 1 500 du mois − 1 000 d'avance
            assert.strictEqual(num(await page.textContent('#arr-c2')), 1500);
        });
        await check('ligne de contrôle : dette d\'un compteur absent de la liste signalée (2 000)', async () => {
            const t = await page.textContent('#prevArrearsInfo');
            assert.match(t, /absent/); assert.match(t, /2[\s  ]?000/);
        });
        await check('plus de correction manuelle d\'arriérés : lien vers le relevé de compte', async () => {
            assert.strictEqual(await page.$('#edit-overlay'), null);
            assert.ok(await page.$('a.btn-edit[href*="compte/releve.html?c=c1"]'));
        });
        await check('facture imprimée : ligne « Avance déduite »', async () => {
            await page.check('.bill-cb[data-id="c1"]');
            await page.evaluate(() => window.renderPrint());
            assert.match(await page.textContent('#print-zone'), /Avance déduite/);
        });
        await check('aucune erreur JavaScript (impression)', () => assert.deepStrictEqual(errors, []));
        await page.context().close();
    }

    // ══════════ IMPRESSION : consommation inhabituelle + impayé → « Arriéré » ══════════
    console.log('Impression — consommation inhabituelle');
    {
        const t = seed();
        const C = t.Asufor[FA].compteurs;
        C.h1 = rec({ name: 'Fuite Impayée', numero_compteur: '11', last_index: '0', new_index: 150 });                       // > 100 m³, impayé
        C.h2 = rec({ name: 'Fuite Payée', numero_compteur: '12', last_index: '0', new_index: 150, status: 'paye', statut: true }); // > 100 m³, payé
        C.h3 = rec({ name: 'Normal Impayé', numero_compteur: '13', last_index: '0', new_index: 10 });                         // impayé normal
        const { page, errors } = await newPage(browser, 'président', t);
        await page.goto(base + '/impression/impression.html');
        await page.waitForSelector('.facture-item', { timeout: 8000 });
        const chip = (name) => page.$$eval('.facture-item', (els, n) => {
            const el = els.find(e => e.innerText.includes(n));
            return el ? el.querySelector('.status-chip').className + '|' + el.querySelector('.status-chip').textContent.trim() : null;
        }, name);
        await check('consommation inhabituelle + impayé : pastille « Arriéré », montant inchangé', async () => {
            assert.match(await chip('Fuite Impayée'), /chip-arriere\|.*Arriéré/);
            assert.strictEqual(num(await page.textContent('#total-h1')), 37500);          // 150 m³ × 250, sans arriéré ancien
            assert.strictEqual(num(await page.textContent('#arr-h1')), 0);
        });
        await check('consommation normale et impayé : reste « Impayé »', async () => {
            assert.match(await chip('Normal Impayé'), /chip-impaye\|.*Impayé/);
        });
        await check('consommation inhabituelle mais PAYÉE : pas classée « Arriéré »', async () => {
            assert.doesNotMatch(await chip('Fuite Payée'), /Arriéré/);
        });
        await check('décompte du bandeau : l\'« Arriéré » inclut le compteur à consommation inhabituelle', async () => {
            const nArr = num(await page.textContent('#countArriere'));
            // c1 (6000) et c2 (1500) ont de vrais arriérés + h1 = 3
            assert.strictEqual(nArr, 3);
        });
        await check('aucune erreur JavaScript (impression, conso inhabituelle)', () => assert.deepStrictEqual(errors, []));
        await page.context().close();
    }

    // ══════════ MAINTENANCE / CLÔTURE ══════════
    console.log('Maintenance (clôture)');
    {
        const crypto = require(ROOT + '/crypto.js');
        const hash = await crypto.hashMaintenancePasscode('ABCD1234');
        const now = new Date();
        const ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const cycle = ym(now);
        const prev = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const mk = (opts) => {
            const t = seed();
            t.Asufor[FA].config.maintenance_passcode_hash = hash;
            t.Asufor[FA].backup[prev] = { info: { cycle: prev }, donnees: { c1: rec({ name: 'Aminata', last_index: '24', new_index: 30 }) } };  // 1500 impayé
            t.Asufor[FA].backup['2026-05'] = { info: { cycle: '2026-05' }, donnees: { c1: rec({ name: 'Aminata', last_index: '500', new_index: 50 }) } };   // anomalie
            return (opts && opts.sansMigration) ? t : migratedSeed(t);
        };
        const open = async (tree) => {
            const r = await newPage(browser, 'président', tree);
            await r.page.goto(base + '/reset/zero.html');
            await r.page.waitForFunction(() => { const b = document.getElementById('btn-action'); return b && !b.disabled && /Lancer/.test(b.textContent); }, null, { timeout: 8000 });
            return r;
        };
        const run = async (page) => {
            await page.fill('#passcode', 'ABCD1234');
            await page.click('#btn-action');
        };

        {
            const { page, errors } = await open(mk());
            await check('clôture : archive + remise à zéro + FACTURES figées + avance, en une écriture', async () => {
                await run(page);
                await page.waitForFunction(() => /MAINTENANCE RÉUSSIE/.test(document.getElementById('log-msg').textContent), null, { timeout: 8000 });
                const t = await db(page);
                const F = t.Asufor[FA];
                assert.ok(F.backup[cycle].donnees.c1);
                assert.strictEqual(F.backup[cycle].info.total_entrees, 3);
                assert.strictEqual(F.compteurs.c1.new_index, 0);
                assert.strictEqual(F.compteurs.c1.last_index, '30');
                assert.strictEqual(F.compteurs.c1.status, 'impaye');
                ['apaid', 'arrieres', 'facture', 'print'].forEach(k => assert.ok(!(k in F.compteurs.c1), 'champ historique ' + k));
                const f = F.factures[cycle + '_c1'];
                assert.deepStrictEqual([f.montant_initial, f.source, f.statut, f.verrouillee], [1500, 'cloture', 'ouverte', true]);
                assert.ok(F.factures[cycle + '_c3']);                                  // c3 marqué payé sans paiement : facturé (rien d'inventé)
                assert.ok(Object.values(F.audit_comptable).some(e => e.action === 'CLOTURE_EFFECTUEE'));
                assert.match(await page.textContent('#log-msg'), /facture\(s\) émise\(s\)/);
                const w = await page.evaluate(() => window.__DB.writes.length);
                assert.strictEqual(w, 1, 'une seule écriture (atomique)');
            });
            await check('aucune erreur JavaScript (clôture)', () => assert.deepStrictEqual(errors, []));
            await page.context().close();
        }
        {
            const { page } = await open(mk({ sansMigration: true }));
            await check('clôture SANS migration comptable : refusée avec message, rien d\'écrit', async () => {
                await run(page);
                await page.waitForFunction(() => /Migration comptable requise/.test(document.getElementById('log-msg').textContent), null, { timeout: 8000 });
                assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), 0);
            });
            await page.context().close();
        }
        {
            const { page } = await open(mk());
            await check('clôture refusée par Firebase (autre clôture passée avant) : message clair, rien de modifié', async () => {
                await page.evaluate(() => { window.__DB.denyWrites = true; });
                await run(page);
                await page.waitForFunction(() => /Clôture refusée/.test(document.getElementById('log-msg').textContent), null, { timeout: 8000 });
                const t = await db(page);
                assert.strictEqual(t.Asufor[FA].backup[cycle], undefined);
                assert.strictEqual(t.Asufor[FA].compteurs.c1.new_index, 30);
            });
            await page.context().close();
        }
        {
            const { page } = await open(mk());
            await check('compteurs modifiés pendant la préparation : clôture stoppée sans rien écrire', async () => {
                await page.evaluate(() => {
                    window.__hook = (path, n, h) => { if (path.endsWith('/compteurs') && n === 3) h.setAt(path + '/c2/status', 'paye'); };
                });
                await run(page);
                await page.waitForFunction(() => /modifiés pendant la préparation/.test(document.getElementById('log-msg').textContent), null, { timeout: 8000 });
                const t = await db(page);
                assert.strictEqual(t.Asufor[FA].backup[cycle], undefined);
                assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), 0);
            });
            await page.context().close();
        }
        {
            const { page } = await open(mk());
            await check('correction d\'index d\'une archive facturée : facture figée intacte + ajustement « correction » validé', async () => {
                await page.click('#btn-verify');
                await page.waitForSelector('#idx_c1', { timeout: 8000 });
                assert.strictEqual(await page.$('#stat_c1'), null, 'plus de statut « payé » modifiable ici');
                await page.fill('#idx_c1', '28');                                        // 30 → 28 : 1 500 → 1 000
                await page.click('#item_c1 .btn-save-item');
                await page.waitForFunction(() => /Corrigé/.test(document.querySelector('#item_c1 .btn-save-item').textContent), null, { timeout: 8000 });
                const F = (await db(page)).Asufor[FA];
                assert.strictEqual(F.backup[prev].donnees.c1.new_index, 28);
                const f = F.factures[prev + '_c1'];
                assert.deepStrictEqual([f.montant_initial, f.montant_net], [1500, 1000]);
                const j = Object.values(F.ajustements)[0];
                assert.deepStrictEqual([j.type, j.montant, j.statut], ['correction', -500, 'valide']);
                assert.strictEqual(F.backup['2026-05'].donnees.c1.status, 'impaye');
            });
            await page.context().close();
        }
    }


    // ══════════ VERROUILLAGE BIOMÉTRIQUE (WebAuthn, authentificateur virtuel Chromium) ══════════
    console.log('Verrouillage biométrique');
    {
        const local = base.replace('127.0.0.1', 'localhost');     // un rpId WebAuthn ne peut pas être une adresse IP
        const openHome = async (opts) => {
            opts = opts || {};
            const r = await newPage(browser, 'président', seed());
            let cdp = null, authId = null;
            if (opts.authenticator !== false) {
                cdp = await r.ctx.newCDPSession(r.page);
                await cdp.send('WebAuthn.enable');
                const a = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
                    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
                    isUserVerified: true, automaticPresenceSimulation: true } });
                authId = a.authenticatorId;
            }
            await r.page.addInitScript(() => {
                try {
                    if (sessionStorage.getItem('__force_stale')) {
                        sessionStorage.setItem('asufor_bio_active', String(Date.now() - 10 * 60 * 1000));
                        sessionStorage.removeItem('__force_stale');
                    }
                } catch (e) { /* ignoré */ }
            });
            await r.page.goto(local + '/home/accueil.html');
            return Object.assign(r, { cdp, authId });
        };
        const setVerified = (r, v) => r.cdp.send('WebAuthn.setUserVerified', { authenticatorId: r.authId, isUserVerified: v });
        const lsHas = (page, k) => page.evaluate((key) => localStorage.getItem(key) !== null, k);
        // Absence prolongée simulée AU PROCHAIN chargement (au déchargement, pagehide rafraîchit l'activité :
        // c'est voulu — naviguer entre pages ne reverrouille pas — donc on impose la péremption après coup).
        const makeStale = (page) => page.evaluate(() => sessionStorage.setItem('__force_stale', '1'));

        {
            const r = await openHome();
            const { page, errors } = r;
            await check('appareil compatible : proposition d\'activation à la première visite', async () => {
                await page.waitForSelector('#asufor-bio-offer', { timeout: 8000 });
                assert.match(await page.textContent('#asufor-bio-offer'), /Protéger l'application/);
            });
            await check('activer : identifiant créé, contrôle réussi, ligne « Activé »', async () => {
                await page.click('#asufor-bio-offer .bo-yes');
                await page.waitForFunction(() => !document.getElementById('asufor-bio-offer'), null, { timeout: 8000 });
                assert.ok(await lsHas(page, 'asufor_bio_v1'));
                const rec = JSON.parse(await page.evaluate(() => localStorage.getItem('asufor_bio_v1')));
                assert.strictEqual(rec.rpId, 'localhost');
                assert.ok([-7, -257].includes(rec.alg));
                assert.strictEqual(rec.email, 'x@asufor.local');
                assert.strictEqual(await page.textContent('#bio-state'), 'Activé');
                assert.ok(await page.isVisible('#btn-biometric'));
            });
            await check('rechargement juste après usage : pas de verrou (utilisateur actif)', async () => {
                await page.reload();
                await page.waitForSelector('#btn-biometric');
                assert.strictEqual(await page.$('#asufor-lock'), null);
            });
            await check('absence prolongée : page masquée + écran de verrouillage ; déverrouillage automatique par biométrie', async () => {
                await makeStale(page);
                await page.reload();
                // au premier instant : verrouillé et contenu masqué
                await page.waitForSelector('#asufor-lock', { state: 'attached', timeout: 8000 });
                // l'invite biométrique (virtuelle, vérifiée) se déclenche seule → verrou levé
                await page.waitForFunction(() => !document.getElementById('asufor-lock') && !document.documentElement.classList.contains('asufor-locked'), null, { timeout: 8000 });
                assert.strictEqual(await page.evaluate(() => document.body.inert), false);
            });
            await check('biométrie REFUSÉE (utilisateur non vérifié) : la page reste verrouillée et masquée', async () => {
                await setVerified(r, false);
                await makeStale(page);
                await page.reload();
                await page.waitForSelector('#asufor-lock', { timeout: 8000 });
                await page.waitForFunction(() => document.querySelector('#asufor-lock .msg').textContent.length > 0, null, { timeout: 8000 });
                assert.ok(await page.evaluate(() => document.documentElement.classList.contains('asufor-locked')));
                assert.strictEqual(await page.evaluate(() => getComputedStyle(document.body).visibility), 'hidden');
                assert.strictEqual(await page.evaluate(() => document.body.inert), true);
                assert.ok(await page.isVisible('#asufor-lock'));
            });
            await check('bouton « Déverrouiller » : réussit dès que l\'utilisateur est vérifié', async () => {
                await setVerified(r, true);
                await page.click('#asufor-lock .primary');
                await page.waitForFunction(() => !document.getElementById('asufor-lock'), null, { timeout: 8000 });
                assert.ok(await page.isVisible('#btn-biometric'));
            });
            await check('clé publique enregistrée remplacée (falsification) : signature refusée, reste verrouillé', async () => {
                await page.evaluate(async () => {
                    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
                    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
                    let s = ''; spki.forEach(b => s += String.fromCharCode(b));
                    const rec = JSON.parse(localStorage.getItem('asufor_bio_v1'));
                    rec.publicKey = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                    rec.alg = -7;
                    localStorage.setItem('asufor_bio_v1', JSON.stringify(rec));
                    sessionStorage.setItem('__force_stale', '1');
                });
                await page.reload();
                await page.waitForSelector('#asufor-lock', { timeout: 8000 });
                await page.waitForFunction(() => /refusée|Réessayez/.test(document.querySelector('#asufor-lock .msg').textContent), null, { timeout: 8000 });
                assert.ok(await page.evaluate(() => document.documentElement.classList.contains('asufor-locked')));
            });
            await check('« Se déconnecter » depuis l\'écran de verrouillage : session effacée, retour à la connexion', async () => {
                // (le script d'initialisation du test recrée la session à chaque page : on observe donc l'effacement lui-même)
                await page.evaluate(() => {
                    const orig = Storage.prototype.removeItem;
                    Storage.prototype.removeItem = function (k) { if (k === 'asufor_session') sessionStorage.setItem('__session_removed', '1'); return orig.apply(this, arguments); };
                });
                await page.click('#asufor-lock .link');
                await page.waitForURL(/index\.html/, { timeout: 8000 });
                assert.strictEqual(await page.evaluate(() => sessionStorage.getItem('__session_removed')), '1');
            });
            await check('aucune erreur JavaScript (biométrie)', () => assert.deepStrictEqual(errors.filter(e => !/NotAllowed|Verification|Vérification|firebase-config/i.test(e)), []));
            await page.context().close();
        }
        {
            const r = await openHome();
            const { page } = r;
            await page.waitForSelector('#asufor-bio-offer', { timeout: 8000 });
            await page.click('#asufor-bio-offer .bo-yes');
            await page.waitForFunction(() => !document.getElementById('asufor-bio-offer'), null, { timeout: 8000 });
            await check('désactiver : exige une vérification réussie puis retire le verrou', async () => {
                await page.click('#btn-biometric');
                await page.waitForFunction(() => document.getElementById('bio-state').textContent === 'Désactivé', null, { timeout: 8000 });
                assert.strictEqual(await lsHas(page, 'asufor_bio_v1'), false);
            });
            await check('désactiver avec biométrie refusée : le verrou reste actif', async () => {
                await page.click('#btn-biometric');                    // réactive (proposition « Activer » manuelle)
                await page.waitForFunction(() => document.getElementById('bio-state').textContent === 'Activé', null, { timeout: 8000 });
                await setVerified(r, false);
                await page.click('#btn-biometric');                    // demande de désactivation → vérification échoue
                await page.waitForTimeout(1500);
                assert.strictEqual(await lsHas(page, 'asufor_bio_v1'), true);
                assert.strictEqual(await page.textContent('#bio-state'), 'Activé');
            });
            await check('identifiant d\'un AUTRE compte : effacé, aucun verrou étranger', async () => {
                await page.evaluate(() => {
                    const rec = JSON.parse(localStorage.getItem('asufor_bio_v1')); rec.email = 'autre@asufor.local';
                    localStorage.setItem('asufor_bio_v1', JSON.stringify(rec));
                    sessionStorage.setItem('__force_stale', '1');
                });
                await page.reload();
                await page.waitForSelector('#btn-biometric', { state: 'attached' });
                assert.strictEqual(await page.$('#asufor-lock'), null);
                assert.strictEqual(await lsHas(page, 'asufor_bio_v1'), false);
            });
            await page.context().close();
        }
        {
            const r = await openHome();
            await r.page.waitForSelector('#asufor-bio-offer', { timeout: 8000 });
            await r.page.click('#asufor-bio-offer .bo-never');
            await check('« Ne plus demander » : la proposition ne réapparaît plus', async () => {
                await r.page.reload();
                await r.page.waitForSelector('#btn-biometric', { state: 'attached' });
                await r.page.waitForTimeout(800);
                assert.strictEqual(await r.page.$('#asufor-bio-offer'), null);
            });
            await r.page.context().close();
        }
        {
            const r = await openHome({ authenticator: false });
            await r.page.waitForTimeout(800);
            await check('appareil sans biométrie/verrouillage d\'écran : ni proposition ni ligne de réglage', async () => {
                assert.strictEqual(await r.page.$('#asufor-bio-offer'), null);
                assert.strictEqual(await r.page.isVisible('#btn-biometric'), false);
                assert.strictEqual(await r.page.$('#asufor-lock'), null);
            });
            await r.page.context().close();
        }
        {
            // le verrou protège TOUTES les pages protégées (via checkAccess), pas seulement l'accueil
            const r = await openHome();
            await r.page.waitForSelector('#asufor-bio-offer', { timeout: 8000 });
            await r.page.click('#asufor-bio-offer .bo-yes');
            await r.page.waitForFunction(() => !document.getElementById('asufor-bio-offer'), null, { timeout: 8000 });
            await setVerified(r, false);
            await makeStale(r.page);
            await check('page Statistiques : verrouillée aussi après une absence prolongée', async () => {
                await r.page.goto(local + '/statistiques/stats.html');
                await r.page.waitForSelector('#asufor-lock', { state: 'attached', timeout: 8000 });
                assert.ok(await r.page.evaluate(() => document.documentElement.classList.contains('asufor-locked')));
            });
            await r.page.context().close();
        }
    }

    await browser.close();
    server.close();
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests navigateur passent.');
    process.exit(failures ? 1 : 0);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(2); });
