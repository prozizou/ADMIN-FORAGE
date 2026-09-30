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
const FB_AUTH = `export const getAuth = () => ({}); export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 'u1', email: 'x@asufor.local' }), 0); return () => {}; };
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
export const get = async (r) => { window.__DB.reads.push(r.path); if (DB().delays[r.path]) await new Promise(res => setTimeout(res, DB().delays[r.path])); if (DB().failReads.includes(r.path)) throw Object.assign(new Error('offline'), { code: 'NETWORK' }); const n = DB().reads.filter(x => x === r.path).length; if (window.__hook) window.__hook(r.path, n, { getAt, setAt }); return snap(r.path, JSON.parse(JSON.stringify(getAt(r.path)))); };
export const update = async (r, updates) => { if (DB().denyWrites) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  DB().writes.push(JSON.parse(JSON.stringify(updates))); for (const [k, v] of Object.entries(updates)) setAt((r.path ? r.path + '/' : '') + k, v);
  for (const l of DB().listeners) l(); };
export const set = async (r, v) => { setAt(r.path, v); for (const l of DB().listeners) l(); };
export const push = (r) => ({ key: '-Pid' + (DB().pushN = (DB().pushN || 0) + 1), path: r.path + '/-Pid' + DB().pushN });
export const onValue = (r, cb) => { const fire = () => cb(snap(r.path, getAt(r.path))); DB().listeners.push(fire); setTimeout(fire, 0); return () => { DB().listeners = DB().listeners.filter(x => x !== fire); }; };
export const onChildAdded = () => () => {}; export const onChildChanged = () => () => {}; export const onChildRemoved = () => () => {};
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
const num = (t) => parseInt(String(t).replace(/[^\d-]/g, ''), 10) || 0;

module.exports = { server, newPage, seed, FA, chromium };
async function main() {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    let failures = 0;
    const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('  ✓ ' + name), (e) => { failures++; console.log('  ✗ ' + name + '\n    ' + (e.message || e)); });

    // ══════════ STATISTIQUES ══════════
    console.log('Statistiques');
    {
        const { page, errors } = await newPage(browser, 'trésorier', seed());
        // les archives arrivent avec retard : l'encaissement doit être bloqué d'ici là
        await page.addInitScript((f) => { window.__DB.delays['Asufor/' + f + '/backup'] = 1200; }, FA);
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });

        await check('bouton Encaisser grisé tant que les archives ne sont pas chargées', async () => {
            const dis = await page.$$eval('#releves-list .btn-paye', bs => bs.every(b => b.disabled));
            assert.ok(dis, 'les boutons devraient être disabled');
            await page.evaluate(() => window.updateStatus('c1', 'paye'));
            const toast = await page.textContent('#toast');
            assert.match(toast, /Archives en cours de chargement/);
            const w = await page.evaluate(() => window.__DB.writes.length);
            assert.strictEqual(w, 0, 'aucune écriture avant chargement complet');
        });

        await page.waitForFunction(() => [...document.querySelectorAll('#releves-list .btn-paye')].every(b => !b.disabled), null, { timeout: 8000 });

        await check('cumul intégral affiché : Aminata = 1500 + 6000 (juin 5000 + juillet 1000)', async () => {
            const t = await page.$$eval('#releves-list .item', els => els.map(e => e.innerText));
            const a = t.find(x => x.includes('Aminata'));
            assert.ok(/7[,.\s  ]?500/.test(a), a);
        });

        await check('à réclamer = mois + arriérés (c1 7500 + c2 500+1500), reçu = c3 seulement', async () => {
            assert.strictEqual(num(await page.textContent('#total-debt')), 7500 + 500 + 1500);
            assert.strictEqual(num(await page.textContent('#total-money')), 1000);   // c3 : 4 m³ × 250
        });

        await check('Encaisser en cascade : archives réglées + mémoire, reçu inclut les arriérés réglés', async () => {
            await page.evaluate(() => window.updateStatus('c1', 'paye'));
            await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('arriérés réglé'), null, { timeout: 5000 });
            const t = await db(page);
            const c1 = t.Asufor[FA].compteurs.c1;
            assert.strictEqual(c1.status, 'paye');
            assert.strictEqual(c1.arrieres_regles, 6000);
            assert.deepStrictEqual(c1.cycles_regles, ['2026-06|c1', '2026-07|c1']);
            assert.strictEqual(t.Asufor[FA].backup['2026-06'].donnees.c1.status, 'paye');
            assert.strictEqual(t.Asufor[FA].backup['2026-07'].donnees.c1.status, 'paye');
            // c2 (autre client) : ses archives ne sont pas touchées
            assert.strictEqual(t.Asufor[FA].backup['2026-07'].donnees.c2.status, 'impaye');
            // reçu = c3 (1000) + c1 (1500 + 6000 réglés)
            assert.strictEqual(num(await page.textContent('#total-money')), 1000 + 1500 + 6000);
        });

        await check('la ligne « ghost » (archive sans compteur) n\'est attribuée à personne', async () => {
            const t = await db(page);
            assert.strictEqual(t.Asufor[FA].backup['2026-06'].donnees.ghost.status, 'impaye');
        });

        await check('Corriger le paiement : mois courant ET cycles réglés remis à impayé', async () => {
            await page.evaluate(() => window.updateStatus('c1', 'impaye'));
            await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('remis à encaisser'), null, { timeout: 5000 });
            const t = await db(page);
            assert.strictEqual(t.Asufor[FA].compteurs.c1.status, 'impaye');
            assert.strictEqual(t.Asufor[FA].compteurs.c1.arrieres_regles, undefined);
            assert.strictEqual(t.Asufor[FA].backup['2026-06'].donnees.c1.status, 'impaye');
            assert.strictEqual(t.Asufor[FA].backup['2026-07'].donnees.c1.status, 'impaye');
            assert.strictEqual(num(await page.textContent('#total-debt')), 7500 + 500 + 1500);
        });

        await check('droits insuffisants : message clair + rien de modifié localement', async () => {
            await page.evaluate(() => { window.__DB.denyWrites = true; });
            await page.evaluate(() => window.updateStatus('c1', 'paye'));
            await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Droits insuffisants'), null, { timeout: 5000 });
            const t = await db(page);
            assert.strictEqual(t.Asufor[FA].compteurs.c1.status, 'impaye');
            await page.evaluate(() => { window.__DB.denyWrites = false; });
        });
        await check('aucune erreur JavaScript (stats)', () => assert.deepStrictEqual(errors, []));
        await page.context().close();
    }

    // archives illisibles : l'encaissement reste bloqué
    {
        const { page, errors } = await newPage(browser, 'trésorier', seed());
        await page.addInitScript((f) => { window.__DB.failReads.push('Asufor/' + f + '/backup'); }, FA);
        await page.goto(base + '/statistiques/stats.html');
        await page.waitForSelector('#releves-list .item', { timeout: 8000 });
        await check('archives en échec de chargement : encaissement bloqué', async () => {
            await page.evaluate(() => window.updateStatus('c1', 'paye'));
            assert.match(await page.textContent('#toast'), /Archives|archives/);
            assert.strictEqual(await page.evaluate(() => window.__DB.writes.length), 0);
        });
        await page.context().close();
    }

    // ══════════ IMPRESSION ══════════
    console.log('Impression');
    {
        const { page, errors } = await newPage(browser, 'président', seed());
        await page.goto(base + '/impression/impression.html');
        await page.waitForSelector('.facture-item', { timeout: 8000 });

        await check('arriérés = cumul intégral des archives (c1 : 6000, c2 : 1500, c3 : 0)', async () => {
            const arr = async (k) => num(await page.textContent('#arr-' + k));
            assert.strictEqual(await arr('c1'), 6000);
            assert.strictEqual(await arr('c2'), 1500);
            assert.strictEqual(await arr('c3'), 0);
        });
        await check('ligne de contrôle : cumul + dette orpheline signalée (Parti)', async () => {
            const t = await page.textContent('#prevArrearsInfo');
            assert.match(t, /7[,.\s  ]?500/);
            assert.match(t, /Parti/);
        });
        await check('correction manuelle : enregistrée (ajustement + audit atomique), affichée et persistante', async () => {
            await page.evaluate(() => window.openEditModal('c1'));
            await page.fill('#edit-input-arrieres', '4000');
            await page.evaluate(() => window.confirmEdit());
            await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Correction enregistrée'), null, { timeout: 5000 });
            const t = await db(page);
            assert.strictEqual(t.Asufor[FA].compteurs.c1.arrieres_ajustement, -2000);
            const audits = Object.values(t.Asufor[FA].audit_arrieres || {});
            assert.strictEqual(audits.length, 1);
            assert.strictEqual(audits[0].nouveauArrieres, 4000);
            assert.strictEqual(audits[0].ancienArrieres, 6000);
            assert.strictEqual(num(await page.textContent('#arr-c1')), 4000);
            // « rechargement » : le listener relit la base → même valeur (persistante)
            await page.evaluate(() => window.changeMonth());
            await page.waitForSelector('.facture-item');
            assert.strictEqual(num(await page.textContent('#arr-c1')), 4000);
            assert.ok(await page.$('.facture-item.is-modified'));
        });
        await check('même correction visible dans Statistiques (cohérence)', async () => {
            const tree = await db(page);
            const { page: p2, errors: e2 } = await newPage(browser, 'président', tree);
            await p2.goto(base + '/statistiques/stats.html');
            await p2.waitForSelector('#releves-list .item', { timeout: 8000 });
            await p2.waitForFunction(() => [...document.querySelectorAll('#releves-list .btn-paye')].every(b => !b.disabled), null, { timeout: 8000 });
            const t = await p2.$$eval('#releves-list .item', els => els.map(e => e.innerText));
            assert.ok(/5[,.\s  ]?500/.test(t.find(x => x.includes('Aminata'))), 'Aminata = 1500 + 4000');
            assert.deepStrictEqual(e2, []);
            await p2.context().close();
        });
        await check('annuler la correction : ajustement supprimé', async () => {
            await page.evaluate(() => window.openEditModal('c1'));
            await page.evaluate(() => window.resetOneOverride());
            await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Correction annulée'), null, { timeout: 5000 });
            const t = await db(page);
            assert.strictEqual(t.Asufor[FA].compteurs.c1.arrieres_ajustement, undefined);
            assert.strictEqual(num(await page.textContent('#arr-c1')), 6000);
        });
        await check('échec d\'écriture : rien n\'est modifié à l\'écran, message d\'erreur', async () => {
            await page.evaluate(() => { window.__DB.denyWrites = true; });
            await page.evaluate(() => window.openEditModal('c1'));
            await page.fill('#edit-input-arrieres', '1');
            await page.evaluate(() => window.confirmEdit());
            await page.waitForFunction(() => /Droits insuffisants/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
            assert.strictEqual(num(await page.textContent('#arr-c1')), 6000);
            await page.evaluate(() => { window.__DB.denyWrites = false; });
        });
        await check('aucune erreur JavaScript inattendue (impression)', () => assert.deepStrictEqual(errors.filter(e => !/PERMISSION_DENIED/.test(e)), []));
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
        const mk = () => {
            const t = seed();
            t.Asufor[FA].config.maintenance_passcode_hash = hash;
            t.Asufor[FA].backup[prev] = { info: { cycle: prev }, donnees: { c1: rec({ name: 'Aminata', last_index: '24', new_index: 30 }) } };  // 1500 impayé
            t.Asufor[FA].backup['2026-05'] = { info: { cycle: '2026-05' }, donnees: { c1: rec({ name: 'Aminata', last_index: '500', new_index: 50 }) } };   // anomalie
            return t;
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
            await check('clôture : archive créée ET compteurs remis à zéro en une écriture', async () => {
                await run(page);
                await page.waitForFunction(() => /MAINTENANCE RÉUSSIE/.test(document.getElementById('log-msg').textContent), null, { timeout: 8000 });
                const t = await db(page);
                assert.ok(t.Asufor[FA].backup[cycle].donnees.c1);
                assert.strictEqual(t.Asufor[FA].backup[cycle].info.total_entrees, 3);
                assert.strictEqual(t.Asufor[FA].compteurs.c1.new_index, 0);
                assert.strictEqual(t.Asufor[FA].compteurs.c1.last_index, '30');
                assert.strictEqual(t.Asufor[FA].compteurs.c1.status, 'impaye');
                const w = await page.evaluate(() => window.__DB.writes.length);
                assert.strictEqual(w, 1, 'une seule écriture (atomique)');
            });
            await check('aucune erreur JavaScript (clôture)', () => assert.deepStrictEqual(errors, []));
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
            await check('corriger l\'archive « payé » : solde aussi les mois plus anciens, hors anomalie', async () => {
                await page.click('#btn-verify');
                await page.waitForSelector('#stat_c1', { timeout: 8000 });
                await page.selectOption('#stat_c1', 'paye');
                await page.click('#item_c1 .btn-save-item');
                await page.waitForFunction(() => !document.getElementById('item_c1'), null, { timeout: 8000 });
                const t = await db(page);
                const B = t.Asufor[FA].backup;
                assert.strictEqual(B[prev].donnees.c1.status, 'paye');
                assert.strictEqual(B['2026-06'].donnees.c1.status, 'paye');
                assert.strictEqual(B['2026-07'].donnees.c1.status, 'paye');
                assert.strictEqual(B['2026-05'].donnees.c1.status, 'impaye', 'anomalie jamais réglée automatiquement');
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
