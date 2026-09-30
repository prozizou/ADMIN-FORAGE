/**
 * biometric.test.js — Tests de la vérification d'assertion WebAuthn (biometric.js)
 *
 * Exécution :  node scripts/biometric.test.js
 * On fabrique de vraies assertions (authenticatorData + clientDataJSON signés par une
 * vraie paire de clés) et on vérifie que CHAQUE falsification est refusée.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { webcrypto } = require('crypto');
const Bio = require(path.join(__dirname, '..', 'biometric.js'));

const subtle = webcrypto.subtle;
const RP_ID = 'admin-forage.vercel.app';
const ORIGIN = 'https://admin-forage.vercel.app';

let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (err) { failures.push({ name, err }); console.error('  ✗ ' + name + '\n    ' + err.message); }
}

const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** Signature brute r‖s (WebCrypto) → DER, comme la renvoie un authentificateur. */
function rawToDer(raw) {
    const trim = (v) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? cat(new Uint8Array([0]), v) : v; };
    const r = trim(raw.slice(0, 32)), s = trim(raw.slice(32));
    const body = cat(cat(new Uint8Array([0x02, r.length]), r), cat(new Uint8Array([0x02, s.length]), s));
    return cat(new Uint8Array([0x30, body.length]), body);
}

async function makeEs256() {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return { kp, spki: new Uint8Array(await subtle.exportKey('spki', kp.publicKey)) };
}

/** Fabrique une assertion valide (modifiable par `over`). */
async function makeAssertion(key, over) {
    over = over || {};
    const challenge = over.challenge || Bio.b64uEncode(webcrypto.getRandomValues(new Uint8Array(32)));
    const rpHash = await sha256(enc(over.rpId || RP_ID));
    const flags = over.flags === undefined ? 0x05 : over.flags;             // UP + UV
    const authData = cat(rpHash, new Uint8Array([flags, 0, 0, 0, 1]));
    const clientDataJSON = enc(JSON.stringify({ type: over.type || 'webauthn.get', challenge, origin: over.origin || ORIGIN }));
    const signed = cat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (over.signWith || key).kp.privateKey, signed));
    return { authenticatorData: authData, clientDataJSON, signature: rawToDer(raw), challenge };
}

const verify = (a, key, over) => Bio.verifyAssertion(Object.assign({
    authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature,
    publicKey: key.spki, alg: -7, expectedChallenge: a.challenge, expectedOrigin: ORIGIN, rpId: RP_ID
}, over || {}));

(async () => {
    const key = await makeEs256();

    await test('assertion valide (ES256, signature DER) : acceptée', async () => {
        assert.strictEqual(await verify(await makeAssertion(key), key), true);
    });

    await test('mauvais challenge (rejeu d\'une ancienne assertion) : refusé', async () => {
        const a = await makeAssertion(key);
        assert.strictEqual(await verify(a, key, { expectedChallenge: Bio.b64uEncode(webcrypto.getRandomValues(new Uint8Array(32))) }), false);
    });

    await test('mauvaise origine (autre site) : refusé', async () => {
        const a = await makeAssertion(key, { origin: 'https://pirate.example' });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('mauvais rpId : refusé', async () => {
        const a = await makeAssertion(key, { rpId: 'pirate.example' });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('utilisateur NON vérifié (drapeau UV absent : simple présence) : refusé', async () => {
        const a = await makeAssertion(key, { flags: 0x01 });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('présence absente (drapeau UP) : refusé', async () => {
        const a = await makeAssertion(key, { flags: 0x04 });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('type de client incorrect (création au lieu d\'assertion) : refusé', async () => {
        const a = await makeAssertion(key, { type: 'webauthn.create' });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('signature d\'une AUTRE clé : refusé', async () => {
        const other = await makeEs256();
        const a = await makeAssertion(key, { signWith: other });
        assert.strictEqual(await verify(a, key), false);
    });

    await test('signature altérée : refusé', async () => {
        const a = await makeAssertion(key);
        const sig = new Uint8Array(a.signature); sig[sig.length - 1] ^= 0xff;
        assert.strictEqual(await verify(Object.assign({}, a, { signature: sig }), key), false);
    });

    await test('données authentificateur altérées après signature : refusé', async () => {
        const a = await makeAssertion(key);
        const ad = new Uint8Array(a.authenticatorData); ad[36] ^= 1;      // compteur modifié
        assert.strictEqual(await verify(Object.assign({}, a, { authenticatorData: ad }), key), false);
    });

    await test('clientDataJSON altéré après signature : refusé', async () => {
        const a = await makeAssertion(key);
        const cdj = enc(JSON.stringify({ type: 'webauthn.get', challenge: a.challenge, origin: ORIGIN, extra: 1 }));
        assert.strictEqual(await verify(Object.assign({}, a, { clientDataJSON: cdj }), key), false);
    });

    await test('entrées invalides / vides : refusé sans lever d\'exception', async () => {
        assert.strictEqual(await Bio.verifyAssertion({}), false);
        assert.strictEqual(await Bio.verifyAssertion({ authenticatorData: new Uint8Array(3), clientDataJSON: enc('{}'), signature: new Uint8Array(1), publicKey: new Uint8Array(1), alg: -7, expectedChallenge: 'x', expectedOrigin: ORIGIN, rpId: RP_ID }), false);
    });

    await test('algorithme non pris en charge : refusé', async () => {
        assert.strictEqual(await verify(await makeAssertion(key), key, { alg: -8 }), false);
    });

    await test('RS256 : assertion valide acceptée, signature d\'une autre clé refusée', async () => {
        const gen = () => subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
        const kp = await gen(), kp2 = await gen();
        const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
        const build = async (signKp) => {
            const challenge = Bio.b64uEncode(webcrypto.getRandomValues(new Uint8Array(32)));
            const authData = cat(await sha256(enc(RP_ID)), new Uint8Array([0x05, 0, 0, 0, 2]));
            const cdj = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
            const sig = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', signKp.privateKey, cat(authData, await sha256(cdj))));
            return { authenticatorData: authData, clientDataJSON: cdj, signature: sig, publicKey: spki, alg: -257, expectedChallenge: challenge, expectedOrigin: ORIGIN, rpId: RP_ID };
        };
        assert.strictEqual(await Bio.verifyAssertion(await build(kp)), true);
        assert.strictEqual(await Bio.verifyAssertion(await build(kp2)), false);
    });

    await test('derToRaw : entiers avec/sans octet de tête 0x00, ramenés à 32 octets', () => {
        const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0xff, 0x02, 0x02, 0x00, 0x80]);
        const raw = Bio.derToRaw(der, 32);
        assert.strictEqual(raw.length, 64);
        assert.strictEqual(raw[31], 0xff); assert.strictEqual(raw[63], 0x80);
        assert.throws(() => Bio.derToRaw(new Uint8Array([0x31, 0x00]), 32));
    });

    await test('base64url : aller-retour sans perte (octets arbitraires)', () => {
        const b = webcrypto.getRandomValues(new Uint8Array(101));
        assert.deepStrictEqual(Array.from(Bio.b64uDecode(Bio.b64uEncode(b))), Array.from(b));
        assert.ok(!/[+/=]/.test(Bio.b64uEncode(b)));
    });

    console.log('\n' + passed + ' test(s) réussi(s), ' + failures.length + ' échec(s).');
    if (failures.length) process.exit(1);
})();
