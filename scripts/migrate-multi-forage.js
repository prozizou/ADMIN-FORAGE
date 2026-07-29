#!/usr/bin/env node
/**
 * migrate-multi-forage.js — Migration Phase 4 : legacy → forages/{forageKey}/…
 * ==============================================================================
 *
 * Copie les 4 noeuds racine legacy vers leur emplacement namespacé, sans RIEN
 * supprimer (les noeuds legacy restent intacts — leur retrait est une étape
 * MANUELLE et séparée, cf. étape 6 du runbook dans docs/MULTI-FORAGE.md) :
 *
 *   db_agents            → forages/{forageKey}/agents
 *   asufor_db_diandioly  → forages/{forageKey}/compteurs
 *   asufor_backup        → forages/{forageKey}/backup
 *   asufor_depenses      → forages/{forageKey}/depenses
 *
 * Si forages/{forageKey}/config n'existe pas encore, un branding minimal est
 * créé automatiquement (nom "ASUFOR Diandioly").
 *
 * Prérequis (runbook étapes 1-3, docs/MULTI-FORAGE.md) : règles déployées,
 * super-admin créé, forage Diandioly provisionné (une forageKey existe déjà —
 * voir la colonne "Clé" de admin/admin.html, ou le noeud `forages/` dans la
 * console Firebase).
 *
 * ⚠️ Cette migration NE modifie PAS `ForageContext.LEGACY` : l'application
 * continue de lire les chemins legacy tant que vous ne passez pas
 * `LEGACY = false` à la main dans forage-context.js, une fois la copie
 * vérifiée. C'est un choix délibéré : jamais de bascule automatique sur des
 * données de production.
 *
 * ── UTILISATION ──
 *
 *   A) Contre les fichiers JSON exportés (aucune écriture, 100% sûr) :
 *      node scripts/migrate-multi-forage.js --dry-run \
 *           --forage-key <forageKeyDiandioly> \
 *           --agents ./db_agents.json \
 *           --compteurs ./asufor_db_diandioly.json \
 *           --backup ./asufor_backup.json \
 *           --depenses ./asufor_depenses.json
 *
 *   B) Contre Firebase en vrai (écriture) :
 *      Nécessite un compte de service (clé privée Admin SDK), voir
 *      scripts/README-FACTURATION.md §Sécurité pour l'obtenir.
 *      npm install firebase-admin
 *      node scripts/migrate-multi-forage.js --apply \
 *           --forage-key <forageKeyDiandioly> \
 *           --service-account ./serviceAccountKey.json \
 *           --db-url https://asufor-67a06-default-rtdb.firebaseio.com
 *
 * Options :
 *   --dry-run              (défaut) n'écrit rien, affiche le rapport
 *   --apply                applique réellement les écritures
 *   --forage-key <key>     REQUIS : forageKey cible (voir admin/admin.html)
 *   --agents/--compteurs/--backup/--depenses <path>  fichiers JSON (mode fichier)
 *   --service-account <path>  clé Admin SDK (mode Firebase)
 *   --db-url <url>         databaseURL (mode Firebase)
 *   --force                autorise l'écrasement si forages/{key}/compteurs
 *                          contient déjà des données (déconseillé — vérifiez
 *                          d'abord pourquoi une migration semble déjà faite)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_NODES = {
    agents:    'db_agents',
    compteurs: 'asufor_db_diandioly',
    backup:    'asufor_backup',
    depenses:  'asufor_depenses'
};

// ─────────────────────────────────────────────
// Parsing des arguments
// ─────────────────────────────────────────────
function parseArgs(argv) {
    const args = { dryRun: true, force: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--apply':   args.dryRun = false; break;
            case '--dry-run': args.dryRun = true; break;
            case '--force':   args.force = true; break;
            case '--forage-key': args.forageKey = argv[++i]; break;
            case '--agents':     args.agents = argv[++i]; break;
            case '--compteurs':  args.compteurs = argv[++i]; break;
            case '--backup':     args.backup = argv[++i]; break;
            case '--depenses':   args.depenses = argv[++i]; break;
            case '--service-account': args.serviceAccount = argv[++i]; break;
            case '--db-url':  args.dbUrl = argv[++i]; break;
            case '--help': case '-h': args.help = true; break;
            default:
                console.warn('Argument inconnu ignoré :', a);
        }
    }
    return args;
}

function countRecords(obj) {
    return obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
}

// ─────────────────────────────────────────────
// Chargement : fichiers JSON OU Firebase (lecture)
// ─────────────────────────────────────────────
function loadFromFiles(args) {
    const root = {};
    Object.keys(LEGACY_NODES).forEach((target) => {
        const file = args[target];
        if (!file) {
            throw new Error(`--${target} <fichier.json> requis en mode fichier (ou passez --service-account + --db-url pour lire Firebase directement).`);
        }
        root[target] = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) || {};
    });
    return root;
}

async function loadFromFirebase(db) {
    const root = {};
    for (const [target, legacyPath] of Object.entries(LEGACY_NODES)) {
        root[target] = (await db.ref(legacyPath).get()).val() || {};
    }
    return root;
}

// ─────────────────────────────────────────────
// Rapport console
// ─────────────────────────────────────────────
function printReport(root, forageKey) {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  RAPPORT DE MIGRATION MULTI-FORAGE');
    console.log('══════════════════════════════════════════════════════');
    console.log('  Forage cible : forages/' + forageKey);
    console.log('──────────────────────────────────────────────────────');
    Object.keys(LEGACY_NODES).forEach((target) => {
        const n = countRecords(root[target]);
        console.log('  ' + LEGACY_NODES[target].padEnd(22) + ' → forages/' + forageKey + '/' + target.padEnd(11) + ' (' + n + ' entrées)');
    });
    console.log('══════════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────
// Application Firebase (mode --apply)
// ─────────────────────────────────────────────
async function applyToFirebase(db, root, forageKey, force) {
    // Garde-fou : refuse d'écraser une migration déjà en place, sauf --force.
    const existing = await db.ref(`forages/${forageKey}/compteurs`).get();
    if (existing.exists() && !force) {
        throw new Error(
            `forages/${forageKey}/compteurs contient déjà des données. ` +
            `Cette forageKey semble déjà migrée — vérifiez avant de continuer. ` +
            `Utilisez --force pour écraser quand même (déconseillé).`
        );
    }

    const updates = {};
    Object.keys(LEGACY_NODES).forEach((target) => {
        updates[`forages/${forageKey}/${target}`] = root[target];
    });

    const configSnap = await db.ref(`forages/${forageKey}/config`).get();
    if (!configSnap.exists()) {
        updates[`forages/${forageKey}/config`] = {
            nom: 'ASUFOR Diandioly',
            siege: 'Diandioly',
            migrated_at: new Date().toISOString()
        };
        console.log('ℹ️  forages/' + forageKey + '/config absent : branding par défaut créé.');
    }

    await db.ref().update(updates);
    console.log('\n✅ Migration appliquée à Firebase : forages/' + forageKey + ' peuplé.');
    console.log('   Les noeuds legacy (db_agents, asufor_db_diandioly, asufor_backup,');
    console.log('   asufor_depenses) sont INCHANGÉS — vérifiez les données avant de');
    console.log('   passer ForageContext.LEGACY = false dans forage-context.js.\n');
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
        return;
    }

    if (!args.forageKey) {
        console.error('\n❌ --forage-key <key> est requis (voir la colonne "Clé" dans admin/admin.html).\n');
        process.exit(1);
    }

    let root, db, admin;

    const hasFirebaseCreds = args.serviceAccount && args.dbUrl;
    const hasFileArgs = args.agents && args.compteurs && args.backup && args.depenses;

    if (hasFirebaseCreds) {
        admin = require('firebase-admin');
        const serviceAccount = require(path.resolve(args.serviceAccount));
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: args.dbUrl
            });
        }
        db = admin.database();
        console.log('Source : Firebase (lecture)…');
        root = await loadFromFirebase(db);
    } else if (hasFileArgs) {
        root = loadFromFiles(args);
        console.log('Source : fichiers JSON locaux.');
    } else {
        console.error('\n❌ Fournissez soit les 4 fichiers (--agents --compteurs --backup --depenses),');
        console.error('   soit --service-account + --db-url (Firebase).');
        console.error('   Exemple sûr :\n   node scripts/migrate-multi-forage.js --dry-run --forage-key <key> \\');
        console.error('        --agents ./db_agents.json --compteurs ./asufor_db_diandioly.json \\');
        console.error('        --backup ./asufor_backup.json --depenses ./asufor_depenses.json\n');
        process.exit(1);
    }

    printReport(root, args.forageKey);

    if (args.dryRun) {
        console.log('🔎 DRY-RUN : aucune écriture effectuée. Ajoutez --apply pour écrire.\n');
        if (admin) await admin.app().delete();
        return;
    }

    if (!hasFirebaseCreds) {
        console.error('\n❌ --apply requiert --service-account <clé.json> et --db-url <url> (l\'écriture ne peut pas se faire depuis des fichiers).\n');
        process.exit(1);
    }

    await applyToFirebase(db, root, args.forageKey, args.force);
    await admin.app().delete();
}

main().catch(err => {
    console.error('\n💥 Erreur :', err.message || err);
    process.exit(1);
});
