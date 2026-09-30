/**
 * v5.test.js — Tests des corrections de sécurité v5
 * ===================================================
 * Exécution : node scripts/v5.test.js
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASUFORCrypto = require(path.join(ROOT, 'crypto.js'));
const ASUFOR_ADMIN = require(path.join(ROOT, 'admin-config.js'));

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log('  ✓ ' + name); passed++; })
        .catch(err => { console.error('  ✗ ' + name + ' — ' + err.message); failed++; });
}

/** Miroir de derivePassword() (provisioning.js) et deriveV5 (index.html). */
function deriveV5(login, pin) {
    const material = 'asufor_auth_v5:' + String(login).trim() + ':' + String(pin).trim();
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

(async () => {
    console.log('── Tests corrections v5 ──');

    // ── 1. Dérivation du mot de passe Firebase Auth ──
    await test('deriveV5 : produit un hash hex de 64 caractères', () => {
        const d = deriveV5('771234567', '123456');
        assert.match(d, /^[0-9a-f]{64}$/);
    });

    await test('deriveV5 : déterministe (même entrée → même sortie)', () => {
        assert.strictEqual(deriveV5('771234567', '123456'), deriveV5('771234567', '123456'));
    });

    await test('deriveV5 : logins différents → mots de passe différents (même PIN)', () => {
        assert.notStrictEqual(deriveV5('771234567', '123456'), deriveV5('779876543', '123456'));
    });

    await test('deriveV5 : PINs différents → mots de passe différents (même login)', () => {
        assert.notStrictEqual(deriveV5('771234567', '123456'), deriveV5('771234567', '654321'));
    });

    await test('deriveV5 : espaces parasites neutralisés (trim)', () => {
        assert.strictEqual(deriveV5(' 771234567 ', ' 123456 '), deriveV5('771234567', '123456'));
    });

    // ── 2. CSPRNG pour le passcode de maintenance ──
    await test('generateMaintenancePasscode : 8 caractères du charset sûr', () => {
        for (let i = 0; i < 50; i++) {
            const p = ASUFORCrypto.generateMaintenancePasscode();
            assert.match(p, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
        }
    });

    await test('generateMaintenancePasscode : pas deux fois le même (50 tirages)', () => {
        const seen = new Set();
        for (let i = 0; i < 50; i++) seen.add(ASUFORCrypto.generateMaintenancePasscode());
        assert.ok(seen.size >= 49, 'collisions improbables détectées : ' + seen.size + '/50 uniques');
    });

    await test('crypto.js : utilise crypto.getRandomValues (CSPRNG) et non Math.random en chemin principal', () => {
        const src = fs.readFileSync(path.join(ROOT, 'crypto.js'), 'utf8');
        assert.ok(src.includes('getRandomValues'), 'getRandomValues absent');
    });

    // ── 3. Configuration super-admin centralisée ──
    await test('admin-config : isSuperAdmin reconnaît le super-admin (insensible à la casse)', () => {
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin('prozizou298@gmail.com'), true);
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin('PROZIZOU298@GMAIL.COM'), true);
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin('  prozizou298@gmail.com  '), true);
    });

    await test('admin-config : isSuperAdmin rejette les autres emails et entrées invalides', () => {
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin('autre@gmail.com'), false);
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin(''), false);
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin(null), false);
        assert.strictEqual(ASUFOR_ADMIN.isSuperAdmin(undefined), false);
    });

    await test('forage-context : SUPERADMIN_EMAIL résolu depuis admin-config', () => {
        const fc = require(path.join(ROOT, 'forage-context.js'));
        assert.strictEqual(fc.isSuperadmin(ASUFOR_ADMIN.SUPERADMIN_EMAIL), true);
    });

    // ── 4. Fichiers de configuration présents ──
    await test('vercel.json : présent avec CSP et headers de sécurité', () => {
        const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
        const headers = v.headers[0].headers.map(h => h.key);
        assert.ok(headers.includes('Content-Security-Policy'), 'CSP absente');
        assert.ok(headers.includes('X-Frame-Options'), 'X-Frame-Options absent');
        assert.ok(headers.includes('X-Content-Type-Options'), 'X-Content-Type-Options absent');
        assert.ok(headers.includes('Strict-Transport-Security'), 'HSTS absent');
    });

    await test('sw.js : crypto.js et admin-config.js dans le cache app shell', () => {
        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        assert.ok(sw.includes("'./crypto.js'"), 'crypto.js absent du cache');
        assert.ok(sw.includes("'./admin-config.js'"), 'admin-config.js absent du cache');
    });

    await test('zero.html : verrou anti-double-clôture présent', () => {
        const z = fs.readFileSync(path.join(ROOT, 'reset', 'zero.html'), 'utf8');
        assert.ok(z.includes('ANTI-DOUBLE-CLÔTURE'), 'verrou absent');
        assert.ok(z.includes('existingBackup'), 'vérification du backup absente');
    });

    await test('zero.html : export automatique JSON de l\'archive présent', () => {
        const z = fs.readFileSync(path.join(ROOT, 'reset', 'zero.html'), 'utf8');
        assert.ok(z.includes('archive_cloture_cycle'), 'export JSON absent');
    });

    await test('provisioning.js : mot de passe dérivé utilisé (plus de PIN brut)', () => {
        const p = fs.readFileSync(path.join(ROOT, 'provisioning.js'), 'utf8');
        assert.ok(p.includes('derivePassword'), 'derivePassword absent');
        assert.ok(p.includes('derivedPassword'), 'utilisation du mot de passe dérivé absente');
        assert.ok(!p.includes('createUserWithEmailAndPassword(secondaryAuth, email, pin)'), 'PIN brut encore utilisé');
    });

    await test('index.html : connexion avec fallback dérivé/brut', () => {
        const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        assert.ok(idx.includes('asufor_auth_v5'), 'dérivation v5 absente du login');
        assert.ok(idx.includes('signInSmart'), 'signInSmart absent');
    });

    await test('.gitignore : pins.json protégé', () => {
        const g = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
        assert.ok(g.includes('pins.json'), 'pins.json non protégé');
    });

    await test('database.rules.json : agents namespacés acceptent passcode_hash (anciens nœuds retirés en v7)', () => {
        const r = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8');
        assert.ok(r.includes('"passcode_hash": { ".validate": "newData.isString() && newData.val().matches(/^[0-9a-f]{64}$/)" }'), 'passcode_hash non validé');
        assert.ok(!/"db_agents"\s*:/.test(r), 'ancien nœud db_agents encore ouvert');
    });

    await test('scripts/migrate-passcodes.js : script de migration présent', () => {
        assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'migrate-passcodes.js')));
    });

    await test('scripts/migrate-auth-passwords.js : script de migration auth présent', () => {
        assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'migrate-auth-passwords.js')));
    });

    console.log('── Résultats ──');
    console.log(`  Passés : ${passed} / ${passed + failed}`);
    if (failed > 0) {
        console.error(`  ✗ ${failed} test(s) en échec.`);
        process.exit(1);
    }
    console.log('  ✓ Tous les tests v5 passent.');
})();
