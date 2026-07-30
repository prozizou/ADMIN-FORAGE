/**
 * perf-bench.js — Micro-benchmarks des opérations ajoutées par les corrections v4/v5
 * ===================================================================================
 * Mesure le surcoût réel des opérations cryptographiques et de sérialisation
 * introduites par les corrections de sécurité.
 *
 * Exécution : node scripts/perf-bench.js
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const ASUFORCrypto = require(path.join(__dirname, '..', 'crypto.js'));

function bench(name, iterations, fn) {
    // Warmup
    for (let i = 0; i < Math.min(iterations, 100); i++) fn(i);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn(i);
    const t1 = process.hrtime.bigint();
    const totalMs = Number(t1 - t0) / 1e6;
    const perOpUs = (totalMs * 1000) / iterations;
    console.log(`  ${name.padEnd(58)} ${perOpUs.toFixed(2).padStart(10)} µs/op   (${iterations} itérations, total ${totalMs.toFixed(1)} ms)`);
    return perOpUs;
}

async function benchAsync(name, iterations, fn) {
    for (let i = 0; i < Math.min(iterations, 50); i++) await fn(i);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) await fn(i);
    const t1 = process.hrtime.bigint();
    const totalMs = Number(t1 - t0) / 1e6;
    const perOpUs = (totalMs * 1000) / iterations;
    console.log(`  ${name.padEnd(58)} ${perOpUs.toFixed(2).padStart(10)} µs/op   (${iterations} itérations, total ${totalMs.toFixed(1)} ms)`);
    return perOpUs;
}

function deriveV5(login, pin) {
    const material = 'asufor_auth_v5:' + String(login).trim() + ':' + String(pin).trim();
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

(async () => {
    console.log('═══ Micro-benchmarks corrections v4/v5 (Node ' + process.version + ') ═══');
    console.log('');

    console.log('── Cryptographie (v5) ──');
    bench('SHA-256 dérivation mot de passe (deriveV5)', 100000, i => deriveV5('771234567', String(100000 + (i % 900000))));
    bench('generateMaintenancePasscode (CSPRNG)', 100000, () => ASUFORCrypto.generateMaintenancePasscode());
    // Comparaison Math.random pour référence
    bench('[référence] génération 8 chars via Math.random', 100000, () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let r = '';
        for (let j = 0; j < 8; j++) r += chars.charAt(Math.floor(Math.random() * chars.length));
        return r;
    });

    console.log('');
    console.log('── Hachage passcode agent (v4, WebCrypto async) ──');
    await benchAsync('hashAgentPasscode (SHA-256 salé)', 20000, i => ASUFORCrypto.hashAgentPasscode(String(100000 + (i % 900000))));

    console.log('');
    console.log('── Échappement XSS (v5) ──');
    const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    bench('escHtml sur un nom d\'agent typique (20 chars)', 200000, () => escHtml('MAMADOU DIALLO SARR'));

    console.log('');
    console.log('── Export JSON archive (v5) — simulation clôture ──');
    // Simule une base de 500 compteurs (bien au-delà des ~200 réels de Diandioly)
    const makeDb = n => {
        const db = {};
        for (let i = 0; i < n; i++) {
            db['compteur_' + i] = {
                nom: 'Client ' + i, compteur: 'CPT-' + (1000 + i), zone: 'Zone ' + (i % 8),
                ancien_index: 1200 + i * 3, nouvel_index: 1230 + i * 3,
                arrieres: i % 5 === 0 ? 4500 : 0, statut: i % 3 === 0 ? 'impaye' : 'paye',
                agent: 'agent_' + (i % 6), date_releve: '2026-07-15', montant: 3750
            };
        }
        return db;
    };
    for (const size of [100, 200, 500]) {
        const db = makeDb(size);
        bench(`JSON.stringify archive ${size} compteurs (indent 2)`, 2000, () => JSON.stringify({ meta: {}, donnees: db }, null, 2));
        const bytes = Buffer.byteLength(JSON.stringify({ meta: {}, donnees: db }, null, 2), 'utf8');
        console.log(`    → taille du fichier exporté : ${(bytes / 1024).toFixed(1)} Ko`);
    }

    console.log('');
    console.log('── Anti-brute-force localStorage (v4) — simulation ──');
    // localStorage n'existe pas en Node : on simule le coût du JSON parse/stringify
    const lockState = { failCount: 2, lockUntil: Date.now() + 30000, lockLevel: 1 };
    bench('sérialisation + parse état de verrouillage', 200000, () => JSON.parse(JSON.stringify(lockState)));

    console.log('');
    console.log('═══ Benchmarks terminés ═══');
})();
