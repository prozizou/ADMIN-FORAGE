/**
 * migrate-passcodes.js — Migration des passcodes agents legacy (clair → SHA-256)
 * ================================================================================
 *
 * Convertit les champs `passcode` (6 chiffres en clair) des agents existants
 * en `passcode_hash` (SHA-256 salé, format identique à crypto.js), puis
 * supprime le champ en clair.
 *
 * Nœuds traités :
 *   - db_agents (legacy mono-forage)
 *   - Asufor/{forageKey}/agents (multi-forage) pour chaque forage
 *
 * USAGE :
 *   # Prévisualisation (aucune écriture)
 *   node scripts/migrate-passcodes.js --dry-run \
 *     --service-account ./serviceAccountKey.json \
 *     --db-url https://asufor-67a06-default-rtdb.firebaseio.com
 *
 *   # Application réelle
 *   node scripts/migrate-passcodes.js --apply \
 *     --service-account ./serviceAccountKey.json \
 *     --db-url https://asufor-67a06-default-rtdb.firebaseio.com
 */
'use strict';

const { program } = require('commander');
const ASUFORCrypto = require('../crypto.js');

program
    .requiredOption('--service-account <path>', 'Chemin vers la clé de service Firebase')
    .requiredOption('--db-url <url>', 'URL de la base de données Firebase')
    .option('--dry-run', 'Prévisualiser sans écrire')
    .option('--apply', 'Appliquer les modifications');

program.parse(process.argv);
const opts = program.opts();

if (!opts.apply && !opts.dryRun) {
    console.error('Précisez --dry-run (prévisualisation) ou --apply (application).');
    process.exit(1);
}
const isDryRun = !opts.apply;

async function migrateNode(db, path, label) {
    const snap = await db.ref(path).once('value');
    if (!snap.exists()) {
        console.log(`  [${label}] Nœud vide ou absent — ignoré.`);
        return { migrated: 0, skipped: 0 };
    }

    const agents = snap.val();
    let migrated = 0, skipped = 0;

    for (const [agentId, agent] of Object.entries(agents)) {
        if (!agent || typeof agent !== 'object') { skipped++; continue; }

        if (agent.passcode_hash && !agent.passcode) {
            // Déjà migré
            skipped++;
            continue;
        }

        if (!agent.passcode) {
            console.log(`  [${label}] ${agentId} (${agent.agent || '?'}) : ni passcode ni hash — ignoré.`);
            skipped++;
            continue;
        }

        const hash = await ASUFORCrypto.hashAgentPasscode(agent.passcode);
        console.log(`  [${label}] ${agentId} (${agent.agent || '?'}) : passcode clair → hash ${hash.substring(0, 12)}…`);

        if (!isDryRun) {
            await db.ref(`${path}/${agentId}`).update({
                passcode_hash: hash,
                passcode: null   // suppression du champ en clair
            });
        }
        migrated++;
    }

    return { migrated, skipped };
}

async function main() {
    const admin = require('firebase-admin');
    admin.initializeApp({
        credential: admin.credential.cert(require(require('path').resolve(opts.serviceAccount))),
        databaseURL: opts.dbUrl
    });
    const db = admin.database();

    console.log('═══ Migration des passcodes agents (clair → SHA-256) ═══');
    console.log(`Mode : ${isDryRun ? 'DRY-RUN (aucune écriture)' : 'APPLY (écritures actives)'}`);
    console.log('');

    let totalMigrated = 0, totalSkipped = 0;

    // 1. Nœud legacy
    console.log('── db_agents (legacy) ──');
    const legacy = await migrateNode(db, 'db_agents', 'legacy');
    totalMigrated += legacy.migrated; totalSkipped += legacy.skipped;

    // 2. Nœuds multi-forage
    console.log('── Asufor/{forageKey}/agents (multi-forage) ──');
    const foragesSnap = await db.ref('Asufor').once('value');
    if (foragesSnap.exists()) {
        for (const forageKey of Object.keys(foragesSnap.val())) {
            const result = await migrateNode(db, `Asufor/${forageKey}/agents`, forageKey);
            totalMigrated += result.migrated; totalSkipped += result.skipped;
        }
    } else {
        console.log('  Aucun forage multi-forage trouvé.');
    }

    console.log('');
    console.log(`═══ Résultat : ${totalMigrated} agent(s) migré(s), ${totalSkipped} ignoré(s) ═══`);
    if (isDryRun && totalMigrated > 0) {
        console.log('Relancez avec --apply pour appliquer ces migrations.');
    }

    await admin.app().delete();
}

main().catch(err => {
    console.error('Erreur :', err.message);
    process.exit(1);
});
