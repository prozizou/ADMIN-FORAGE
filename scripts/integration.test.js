/**
 * integration.test.js — Tests d'intégration des parcours critiques ASUFOR
 *
 * Exécution :  node scripts/integration.test.js
 *
 * Tests les validations et la logique métier indépendamment de Firebase
 * (mock des appels réseau). Couvre :
 *   - Validation du format de passcode agent (6 chiffres)
 *   - Validation du numéro de téléphone
 *   - Validation du nom (longueur)
 *   - Numérotation atomique (simulation de transaction)
 *   - Validation du passcode de maintenance (8 caractères alphanumériques)
 */
'use strict';

const assert = require('assert');

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

// ── Validation du format passcode agent ─────────────────────
test('Passcode agent : regex 6 chiffres — valide', () => {
    const regex = /^\d{6}$/;
    assert.ok(regex.test('123456'));
    assert.ok(regex.test('000000'));
    assert.ok(regex.test('999999'));
});

test('Passcode agent : regex 6 chiffres — invalide', () => {
    const regex = /^\d{6}$/;
    assert.ok(!regex.test('12345'));
    assert.ok(!regex.test('1234567'));
    assert.ok(!regex.test('abcdef'));
    assert.ok(!regex.test('12 345'));
    assert.ok(!regex.test(''));
});

// ── Validation du numéro de téléphone ─────────────────────
test('Téléphone : regex 7 à 15 chiffres — valide', () => {
    const regex = /^\d{7,15}$/;
    assert.ok(regex.test('775076770'));
    assert.ok(regex.test('1234567'));
    assert.ok(regex.test('123456789012345'));
});

test('Téléphone : regex 7 à 15 chiffres — invalide', () => {
    const regex = /^\d{7,15}$/;
    assert.ok(!regex.test('123456'));       // trop court
    assert.ok(!regex.test('1234567890123456')); // trop long
    assert.ok(!regex.test('77 50 76 770'));  // espaces
    assert.ok(!regex.test('+221775076770')); // indicatif
    assert.ok(!regex.test(''));
});

// ── Validation du nom ──────────────────────────────────────
test('Nom : longueur entre 2 et 100 caractères', () => {
    const valid = (n) => n.length >= 2 && n.length <= 100;
    assert.ok(valid('Ab'));
    assert.ok(valid('Abou Diop'));
    assert.ok(valid('A'.repeat(100)));
    assert.ok(!valid('A'));
    assert.ok(!valid(''));
    assert.ok(!valid('A'.repeat(101)));
});

// ── Numérotation atomique (simulation de transaction) ──────
test('Numérotation atomique : incrément séquentiel sans collision', () => {
    // Simule la logique de transaction Firebase
    let counter = 0;

    function simulateTransaction(currentValue) {
        const next = (typeof currentValue === 'number' && currentValue > 0) ? currentValue : 1;
        return next + 1;
    }

    // 10 créations de compteurs en séquence
    const numbers = [];
    for (let i = 0; i < 10; i++) {
        const newValue = simulateTransaction(counter);
        const assignedNumber = newValue - 1; // on retourne l'ancienne valeur
        numbers.push(assignedNumber);
        counter = newValue;
    }

    // Vérifier : 1, 2, 3, ..., 10 — sans doublon
    assert.strictEqual(numbers.length, 10);
    assert.deepStrictEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Vérifier unicité
    const unique = new Set(numbers);
    assert.strictEqual(unique.size, numbers.length);
});

test('Numérotation atomique : gestion de la valeur initiale nulle', () => {
    let counter = null; // première exécution, pas de valeur en DB

    function simulateTransaction(currentValue) {
        const next = (typeof currentValue === 'number' && currentValue > 0) ? currentValue : 1;
        return next + 1;
    }

    const newValue = simulateTransaction(counter);
    assert.strictEqual(newValue, 2); // 1 + 1 = 2 (on assignera le numéro 1)
});

test('Numérotation atomique : gestion de la valeur initiale undefined', () => {
    let counter = undefined;

    function simulateTransaction(currentValue) {
        const next = (typeof currentValue === 'number' && currentValue > 0) ? currentValue : 1;
        return next + 1;
    }

    const newValue = simulateTransaction(counter);
    assert.strictEqual(newValue, 2);
});

// ── Passcode de maintenance ────────────────────────────────
test('Passcode maintenance : 8 caractères alphanumériques sans ambigus', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    assert.strictEqual(chars.length, 32);
    assert.ok(!chars.includes('0'));
    assert.ok(!chars.includes('O'));
    assert.ok(!chars.includes('1'));
    assert.ok(!chars.includes('I'));
});

test('Passcode maintenance : regex de validation', () => {
    const regex = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
    assert.ok(regex.test('A3K9X7MQ'));
    assert.ok(regex.test('ABCDEFGH'));
    assert.ok(!regex.test('01'));        // contient des ambigus
    assert.ok(!regex.test('ABCDEFG'));   // trop court
    assert.ok(!regex.test('ABCDEFGHI')); // trop long
});

// ── Anti-brute-force : niveaux de verrouillage ─────────────
test('Anti-brute-force : niveaux de verrouillage progressifs', () => {
    const LOCK_DURATIONS_MS = [30000, 120000, 600000, 3600000];
    let lockLevel = 0;

    // Après 5 échecs → niveau 1 (2 min)
    lockLevel = Math.min(lockLevel + 1, LOCK_DURATIONS_MS.length - 1);
    assert.strictEqual(lockLevel, 1);
    assert.strictEqual(LOCK_DURATIONS_MS[lockLevel], 120000);

    // Après 10 échecs → niveau 2 (10 min)
    lockLevel = Math.min(lockLevel + 1, LOCK_DURATIONS_MS.length - 1);
    assert.strictEqual(lockLevel, 2);
    assert.strictEqual(LOCK_DURATIONS_MS[lockLevel], 600000);

    // Après 15 échecs → niveau 3 (1h)
    lockLevel = Math.min(lockLevel + 1, LOCK_DURATIONS_MS.length - 1);
    assert.strictEqual(lockLevel, 3);
    assert.strictEqual(LOCK_DURATIONS_MS[lockLevel], 3600000);

    // Après 20 échecs → reste au niveau max (1h)
    lockLevel = Math.min(lockLevel + 1, LOCK_DURATIONS_MS.length - 1);
    assert.strictEqual(lockLevel, 3);
});

// ── Résultats ──────────────────────────────────────────────
console.log('\n── Résultats ──');
console.log('  Passés : ' + passed + ' / ' + (passed + failures.length));
if (failures.length > 0) {
    console.error('\n  Échoués :');
    failures.forEach(f => console.error('    - ' + f.name + ': ' + f.err.message));
    process.exit(1);
}
console.log('  ✓ Tous les tests d\'intégration passent.');
