/**
 * init-counter-number.js — Initialisation du compteur de numérotation atomique
 *
 * USAGE :
 *   node scripts/init-counter-number.js \
 *     --service-account ./serviceAccountKey.json \
 *     --db-url https://asufor-67a06-default-rtdb.firebaseio.com \
 *     --forage-key Asufor_diandioly
 *
 * Ce script :
 *   1. Lit le nombre de compteurs existants dans Asufor/{forageKey}/compteurs
 *   2. Lit la valeur actuelle de Asufor/{forageKey}/config/next_counter_number
 *   3. Si absente, initialise à (nombre de compteurs + 1)
 *   4. Si présente mais inférieure au nombre de compteurs + 1, la met à jour
 *
 * Exécutez d'abord avec --dry-run pour prévisualiser, puis --apply pour appliquer.
 */
'use strict';

const { program } = require('commander');
const { createApp } = require('firebase-admin/app');
const { getDatabase, ref, get, set } = require('firebase-admin/database');

program
    .requiredOption('--service-account <path>', 'Chemin vers la clé de service Firebase')
    .requiredOption('--db-url <url>', 'URL de la base de données Firebase')
    .requiredOption('--forage-key <key>', 'Clé du forage (ex: Asufor_diandioly)')
    .option('--dry-run', 'Prévisualiser sans écrire', true)
    .option('--apply', 'Appliquer les modifications (remplace --dry-run)');

program.parse(process.argv);
const opts = program.opts();

if (opts.apply && opts.dryRun) {
    console.error('Erreur : --apply et --dry-run sont mutuellement exclusifs.');
    process.exit(1);
}

const isDryRun = !opts.apply;

async function main() {
    const app = createApp({
        credential: require('firebase-admin/credential').cert(opts.serviceAccount),
        databaseURL: opts.dbUrl
    });

    const db = getDatabase(app);
    const forageRef = ref(db, `Asufor/${opts.forageKey}`);

    console.log('═══ Initialisation du compteur de numérotation ═══');
    console.log(`Forage : ${opts.forageKey}`);
    console.log(`Mode   : ${isDryRun ? 'DRY-RUN (aucune écriture)' : 'APPLY (écritures actives)'}`);
    console.log('');

    try {
        // 1. Lire les compteurs existants
        const compteursSnap = await get(ref(db, `${opts.forageKey}/compteurs`));
        const compteursData = compteursSnap.exists() ? compteursSnap.val() : {};
        const existingCount = Object.keys(compteursData).length;
        const existingNumbers = Object.values(compteursData)
            .map(c => parseInt(c.numero_compteur, 10))
            .filter(n => !isNaN(n) && n > 0);
        const maxExisting = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;

        console.log(`Compteurs existants : ${existingCount}`);
        console.log(`Numéro max actuel   : ${maxExisting}`);
        console.log('');

        // 2. Lire la valeur actuelle de next_counter_number
        const configSnap = await get(ref(db, `${opts.forageKey}/config/next_counter_number`));
        const currentValue = configSnap.exists() ? configSnap.val() : null;
        console.log(`next_counter_number actuel : ${currentValue !== null ? currentValue : '(absent)'}`);
        console.log('');

        // 3. Calculer la nouvelle valeur
        const desiredValue = Math.max(maxExisting + 1, existingCount + 1);
        console.log(`Valeur souhaitée : ${desiredValue}`);

        if (currentValue !== null && currentValue >= desiredValue) {
            console.log('');
            console.log('✓ Le compteur est déjà positionné correctement. Aucune action requise.');
            process.exit(0);
        }

        if (currentValue !== null && currentValue < desiredValue) {
            console.log(`⚠ Le compteur (${currentValue}) est inférieur au minimum requis (${desiredValue}).`);
            console.log(`  Il sera mis à jour à ${desiredValue}.`);
        } else {
            console.log(`Le compteur sera initialisé à ${desiredValue}.`);
        }

        console.log('');

        if (isDryRun) {
            console.log('[DRY-RUN] Aucune écriture effectuée. Relancez avec --apply pour appliquer.');
        } else {
            await set(ref(db, `${opts.forageKey}/config/next_counter_number`), desiredValue);
            console.log(`✓ next_counter_number mis à jour à ${desiredValue}`);

            // Vérification
            const verifySnap = await get(ref(db, `${opts.forageKey}/config/next_counter_number`));
            console.log(`  Vérification : ${verifySnap.val()}`);
        }

    } catch (err) {
        console.error('Erreur :', err.message);
        process.exit(1);
    } finally {
        await app.delete();
    }
}

main();
