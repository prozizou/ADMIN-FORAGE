#!/usr/bin/env node
/**
 * migrate-arrears.js — Migration one-shot des arriérés ASUFOR
 * ===========================================================
 *
 * Calcule, pour CHAQUE compteur de la base active (asufor_db_diandioly),
 * la facture courante et l'arriéré cumulé (via billing.js), puis :
 *   • en mode --dry-run (défaut) : produit un RAPPORT sans rien écrire ;
 *   • en mode --apply            : écrit les champs dans Firebase.
 *
 * Champs écrits dans asufor_db_diandioly/<key> :
 *   facture_courante  (number)   facture du mois en cours
 *   arriere           (number)   somme des cycles passés impayés (>= 0)
 *   total_du          (number)   facture_courante + arriere (confort d'affichage)
 *   anomalie          (bool)     true si le mois courant est en anomalie
 *   anomalie_raison   (string?)  libellé, sinon supprimé
 *   arriere_calc_at   (ISO)      horodatage du calcul
 *
 * ── UTILISATION ──
 *
 *   A) Contre les fichiers JSON exportés (aucune écriture, 100% sûr) :
 *      node scripts/migrate-arrears.js --dry-run \
 *           --active ./asufor_db_diandioly.json \
 *           --backup ./asufor_backup.json
 *
 *   B) Contre Firebase en vrai (écriture) :
 *      Nécessite un compte de service (clé privée Admin SDK).
 *      npm install firebase-admin
 *      node scripts/migrate-arrears.js --apply \
 *           --service-account ./serviceAccountKey.json \
 *           --db-url https://asufor-67a06-default-rtdb.firebaseio.com
 *
 * Options :
 *   --dry-run            (défaut) n'écrit rien, affiche le rapport
 *   --apply              applique réellement les écritures
 *   --active <path>      fichier JSON de la base active (mode fichier)
 *   --backup <path>      fichier JSON des backups (mode fichier)
 *   --service-account <path>  clé Admin SDK (mode Firebase)
 *   --db-url <url>       databaseURL (mode Firebase)
 *   --current-cycle <YYYY-MM>  cycle courant, exclut les cycles >= de ce mois
 *                              du cumul (défaut : mois calendaire courant)
 *   --report <path>      écrit aussi le rapport CSV des anomalies
 *   --batch <n>          taille des lots d'écriture Firebase (défaut 200)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Billing = require(path.join(__dirname, '..', 'billing.js'));

// ─────────────────────────────────────────────
// Parsing des arguments
// ─────────────────────────────────────────────
function parseArgs(argv) {
    const args = { dryRun: true, batch: 200 };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--apply':   args.dryRun = false; break;
            case '--dry-run': args.dryRun = true; break;
            case '--active':  args.active = argv[++i]; break;
            case '--backup':  args.backup = argv[++i]; break;
            case '--service-account': args.serviceAccount = argv[++i]; break;
            case '--db-url':  args.dbUrl = argv[++i]; break;
            case '--current-cycle': args.currentCycle = argv[++i]; break;
            case '--report':  args.report = argv[++i]; break;
            case '--batch':   args.batch = parseInt(argv[++i], 10) || 200; break;
            case '--help': case '-h': args.help = true; break;
            default:
                console.warn('Argument inconnu ignoré :', a);
        }
    }
    return args;
}

function defaultCurrentCycle() {
    const d = new Date();
    // Le cycle courant = mois calendaire ; on exclut du cumul tout cycle >= ce mois.
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${d.getFullYear()}-${m}`;
}

function fmt(n) { return Number(n).toLocaleString('fr-FR'); }

// ─────────────────────────────────────────────
// Cœur : calcule tous les statements
// ─────────────────────────────────────────────
function computeAll(activeRoot, backupRoot, currentCycle) {
    const idx = Billing.indexBackups(backupRoot);
    const opts = { beforeCycle: currentCycle };
    const results = [];

    Object.keys(activeRoot).forEach((key) => {
        const rec = activeRoot[key];
        if (!rec || typeof rec !== 'object') return;
        const st = Billing.computeStatement(rec, idx, opts);
        results.push({
            key,
            name: rec.name || '',
            numero_compteur: rec.numero_compteur || '',
            zone: rec.zone || '',
            statement: st
        });
    });
    return { idx, results };
}

// ─────────────────────────────────────────────
// Construit l'objet d'updates multi-chemins
// ─────────────────────────────────────────────
function buildUpdates(results, activePath, calcAt) {
    const updates = {};
    results.forEach(({ key, statement }) => {
        const p = `${activePath}/${key}`;
        updates[`${p}/facture_courante`] = statement.facture_courante;
        updates[`${p}/arriere`]          = statement.arriere;
        updates[`${p}/total_du`]         = statement.total;
        updates[`${p}/anomalie`]         = statement.anomalie;
        updates[`${p}/anomalie_raison`]  = statement.anomalie ? statement.raison : null;
        updates[`${p}/arriere_calc_at`]  = calcAt;
    });
    return updates;
}

// ─────────────────────────────────────────────
// Rapport console + CSV
// ─────────────────────────────────────────────
function printReport(results, currentCycle) {
    const total = results.length;
    const avecArriere = results.filter(r => r.statement.arriere > 0);
    const anomaliesCourant = results.filter(r => r.statement.anomalie);
    const anomaliesArrieres = results.filter(r => r.statement.arrearsAnomalies.length > 0);
    const sommeArrieres = results.reduce((s, r) => s + r.statement.arriere, 0);
    const sommeCourant  = results.reduce((s, r) => s + r.statement.facture_courante, 0);

    console.log('\n══════════════════════════════════════════════════════');
    console.log('  RAPPORT DE MIGRATION DES ARRIÉRÉS');
    console.log('══════════════════════════════════════════════════════');
    console.log('  Cycle courant (exclu du cumul) :', currentCycle);
    console.log('  Compteurs traités              :', total);
    console.log('  Compteurs avec arriéré > 0     :', avecArriere.length);
    console.log('  Somme facture courante         :', fmt(sommeCourant), 'FCFA');
    console.log('  Somme arriérés                 :', fmt(sommeArrieres), 'FCFA');
    console.log('  TOTAL DÛ (courant + arriérés)   :', fmt(sommeCourant + sommeArrieres), 'FCFA');
    console.log('  ⚠️  Anomalies mois courant      :', anomaliesCourant.length);
    console.log('  ⚠️  Compteurs à arriéré anormal :', anomaliesArrieres.length);
    console.log('──────────────────────────────────────────────────────');

    // Top 10 des plus gros arriérés
    const top = [...avecArriere].sort((a, b) => b.statement.arriere - a.statement.arriere).slice(0, 10);
    if (top.length) {
        console.log('  TOP 10 ARRIÉRÉS :');
        top.forEach(r => {
            console.log('   • ' + (r.name || '(sans nom)').padEnd(28) +
                ' Cpt ' + String(r.numero_compteur).padEnd(5) +
                ' [' + r.zone + ']  ' + fmt(r.statement.arriere) + ' FCFA');
        });
    }

    if (anomaliesCourant.length) {
        console.log('──────────────────────────────────────────────────────');
        console.log('  ANOMALIES MOIS COURANT (facture non calculée) :');
        anomaliesCourant.slice(0, 20).forEach(r => {
            console.log('   • ' + (r.name || '(sans nom)') +
                ' Cpt ' + r.numero_compteur + ' [' + r.zone + '] → ' + r.statement.raison);
        });
        if (anomaliesCourant.length > 20) {
            console.log('   … et ' + (anomaliesCourant.length - 20) + ' autres (voir CSV).');
        }
    }
    console.log('══════════════════════════════════════════════════════\n');

    return { total, avecArriere, anomaliesCourant, anomaliesArrieres, sommeArrieres, sommeCourant };
}

function writeCsvReport(results, reportPath) {
    const rows = ['\uFEFFClient;N Compteur;Zone;Facture Courante;Arriere;Total Du;Anomalie Courant;Raison;Cycles Arriere Anormaux'];
    results.forEach(r => {
        const s = r.statement;
        const anomArr = s.arrearsAnomalies.map(a => a.cycle).join(' ');
        const clean = (x) => String(x == null ? '' : x).replace(/;/g, ',');
        rows.push([
            clean(r.name), clean(r.numero_compteur), clean(r.zone),
            s.facture_courante, s.arriere, s.total,
            s.anomalie ? 'OUI' : 'non',
            clean(s.raison || ''),
            anomArr
        ].join(';'));
    });
    fs.writeFileSync(reportPath, rows.join('\n'), 'utf8');
    console.log('📄 Rapport CSV écrit :', reportPath);
}

// ─────────────────────────────────────────────
// Application Firebase (mode --apply)
// ─────────────────────────────────────────────
async function applyToFirebase(args, results, calcAt) {
    let admin;
    try {
        admin = require('firebase-admin');
    } catch (e) {
        console.error('\n❌ Module firebase-admin absent. Installez-le :  npm install firebase-admin\n');
        process.exit(1);
    }
    if (!args.serviceAccount || !args.dbUrl) {
        console.error('\n❌ --apply requiert --service-account <clé.json> et --db-url <url>\n');
        process.exit(1);
    }
    const serviceAccount = require(path.resolve(args.serviceAccount));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: args.dbUrl
    });
    const db = admin.database();
    const activePath = 'asufor_db_diandioly';

    // Écriture par lots pour ne pas dépasser les limites RTDB
    const batchSize = args.batch;
    let written = 0;
    for (let i = 0; i < results.length; i += batchSize) {
        const chunk = results.slice(i, i + batchSize);
        const updates = buildUpdates(chunk, activePath, calcAt);
        await db.ref().update(updates);
        written += chunk.length;
        console.log(`   … ${written}/${results.length} compteurs écrits`);
    }
    console.log('\n✅ Migration appliquée à Firebase :', written, 'compteurs mis à jour.');
    await admin.app().delete();
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

    const currentCycle = args.currentCycle || defaultCurrentCycle();
    const calcAt = new Date().toISOString();

    // Chargement des données : fichiers JSON OU Firebase (lecture)
    let activeRoot, backupRoot;

    if (args.active && args.backup) {
        // Mode fichier
        activeRoot = JSON.parse(fs.readFileSync(path.resolve(args.active), 'utf8'));
        backupRoot = JSON.parse(fs.readFileSync(path.resolve(args.backup), 'utf8'));
        console.log('Source : fichiers JSON locaux.');
    } else if (!args.dryRun && args.serviceAccount && args.dbUrl) {
        // Mode Firebase : on lit d'abord la base pour calculer
        const admin = require('firebase-admin');
        const serviceAccount = require(path.resolve(args.serviceAccount));
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: args.dbUrl
            });
        }
        const db = admin.database();
        console.log('Source : Firebase (lecture)…');
        activeRoot = (await db.ref('asufor_db_diandioly').get()).val() || {};
        backupRoot = (await db.ref('asufor_backup').get()).val() || {};
    } else {
        console.error('\n❌ Fournissez soit --active + --backup (fichiers), soit --service-account + --db-url (Firebase).');
        console.error('   Exemple sûr :\n   node scripts/migrate-arrears.js --dry-run --active ./active.json --backup ./backup.json\n');
        process.exit(1);
    }

    const { results } = computeAll(activeRoot, backupRoot, currentCycle);
    const summary = printReport(results, currentCycle);

    if (args.report) writeCsvReport(results, path.resolve(args.report));

    if (args.dryRun) {
        console.log('🔎 DRY-RUN : aucune écriture effectuée. Ajoutez --apply pour écrire.\n');
        return;
    }

    await applyToFirebase(args, results, calcAt);
}

main().catch(err => {
    console.error('\n💥 Erreur :', err);
    process.exit(1);
});
