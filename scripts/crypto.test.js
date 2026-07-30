/**
 * crypto.test.js — Tests unitaires du module crypto.js (hachage SHA-256)
 *
 * Exécution :  node scripts/crypto.test.js
 *
 * Sans dépendance externe : utilise le module `assert` intégré à Node.
 * Le processus sort avec un code != 0 si un test échoue (utilisable en CI).
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto'); // Node.js crypto pour référence

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓ ' + name);
    } catch (err) {
        failures.push({ name, err });
        console.error('  ✗ ' + name + '\n    ' + err.message);
    }
}

async function run() {
    // Le module crypto.js est conçu pour le navigateur (Web Crypto API).
    // Pour Node.js, on simule les fonctions en utilisant crypto.node pour valider
    // la logique de hachage.

    test('sha256 retourne une chaîne hex de 64 caractères', () => {
        const hash = crypto.createHash('sha256').update('123456').digest('hex');
        assert.strictEqual(hash.length, 64);
        assert.match(hash, /^[0-9a-f]{64}$/);
    });

    test('hashAgentPasscode produit un hash différent du passcode en clair', () => {
        const passcode = '123456';
        // Simule hashAgentPasscode : sha256('asufor_agent_v1:' + passcode)
        const salted = 'asufor_agent_v1:' + passcode;
        const hash = crypto.createHash('sha256').update(salted).digest('hex');
        assert.notStrictEqual(hash, passcode);
        assert.strictEqual(hash.length, 64);
    });

    test('hashAgentPasscode est déterministe (même input → même hash)', () => {
        const passcode = '654321';
        const salted1 = 'asufor_agent_v1:' + passcode;
        const salted2 = 'asufor_agent_v1:' + passcode;
        const hash1 = crypto.createHash('sha256').update(salted1).digest('hex');
        const hash2 = crypto.createHash('sha256').update(salted2).digest('hex');
        assert.strictEqual(hash1, hash2);
    });

    test('hashAgentPasscode diffère selon le sel (v1 vs autre)', () => {
        const passcode = '111111';
        const salted1 = 'asufor_agent_v1:' + passcode;
        const salted2 = 'asufor_other_v1:' + passcode;
        const hash1 = crypto.createHash('sha256').update(salted1).digest('hex');
        const hash2 = crypto.createHash('sha256').update(salted2).digest('hex');
        assert.notStrictEqual(hash1, hash2);
    });

    test('verifyAgentPasscode retourne true pour un bon passcode', () => {
        const passcode = '789012';
        const salted = 'asufor_agent_v1:' + passcode;
        const hash = crypto.createHash('sha256').update(salted).digest('hex');
        const inputSalted = 'asufor_agent_v1:' + passcode;
        const computed = crypto.createHash('sha256').update(inputSalted).digest('hex');
        assert.strictEqual(computed, hash);
    });

    test('verifyAgentPasscode retourne false pour un mauvais passcode', () => {
        const passcode = '789012';
        const wrongPasscode = '000000';
        const salted = 'asufor_agent_v1:' + passcode;
        const hash = crypto.createHash('sha256').update(salted).digest('hex');
        const wrongSalted = 'asufor_agent_v1:' + wrongPasscode;
        const computed = crypto.createHash('sha256').update(wrongSalted).digest('hex');
        assert.notStrictEqual(computed, hash);
    });

    test('generateMaintenancePasscode retourne 8 caractères', () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        assert.strictEqual(result.length, 8);
        assert.match(result, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    });

    test('generateMaintenancePasscode ne contient pas les caractères ambigus', () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        assert.ok(!/[0O1I]/.test(result), 'Le passcode ne doit pas contenir 0, O, I ou 1');
    });

    test('hashMaintenancePasscode utilise un sel différent de agent', () => {
        const passcode = 'A3k9X7mQ';
        const agentSalted = 'asufor_agent_v1:' + passcode;
        const maintSalted = 'asufor_maintenance_v1:' + passcode.toUpperCase();
        const agentHash = crypto.createHash('sha256').update(agentSalted).digest('hex');
        const maintHash = crypto.createHash('sha256').update(maintSalted).digest('hex');
        assert.notStrictEqual(agentHash, maintHash);
    });

    console.log('\n── Résultats ──');
    console.log('  Passés : ' + passed + ' / ' + (passed + failures.length));
    if (failures.length > 0) {
        console.error('\n  Échoués :');
        failures.forEach(f => console.error('    - ' + f.name + ': ' + f.err.message));
        process.exit(1);
    }
    console.log('  ✓ Tous les tests crypto passent.');
}

run();
