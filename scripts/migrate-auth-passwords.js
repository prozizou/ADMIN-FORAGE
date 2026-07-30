/**
 * migrate-auth-passwords.js — Migration des mots de passe Firebase Auth (PIN brut → dérivé v5)
 * =============================================================================================
 *
 * Les comptes créés avant v5 utilisent le PIN 6 chiffres BRUT comme mot de
 * passe Firebase Auth (espace de clés 10^6 — vulnérable au brute force API).
 * Ce script les migre vers le mot de passe dérivé v5 :
 *     SHA-256('asufor_auth_v5:' + login + ':' + pin)  → 64 caractères hex
 *
 * ⚠️  PRÉREQUIS : connaître le PIN de chaque compte à migrer. Le PIN n'est PAS
 * stocké dans la base — il faut le fournir via un fichier JSON :
 *
 *   pins.json : { "771234567": "123456", "779876543": "654321" }
 *   (clé = login/téléphone, valeur = PIN à 6 chiffres)
 *
 * USAGE :
 *   node scripts/migrate-auth-passwords.js --dry-run \
 *     --service-account ./serviceAccountKey.json \
 *     --db-url https://asufor-67a06-default-rtdb.firebaseio.com \
 *     --pins ./pins.json
 *
 *   node scripts/migrate-auth-passwords.js --apply ... (mêmes options)
 *
 * NOTE : le fichier pins.json est SENSIBLE. Supprimez-le immédiatement après
 * la migration (il est couvert par .gitignore : *.local.json recommandé).
 */
'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const path = require('path');

program
    .requiredOption('--service-account <path>', 'Chemin vers la clé de service Firebase')
    .requiredOption('--db-url <url>', 'URL de la base de données Firebase')
    .requiredOption('--pins <path>', 'Fichier JSON {login: pin} des comptes à migrer')
    .option('--dry-run', 'Prévisualiser sans écrire')
    .option('--apply', 'Appliquer les modifications');

program.parse(process.argv);
const opts = program.opts();

if (!opts.apply && !opts.dryRun) {
    console.error('Précisez --dry-run (prévisualisation) ou --apply (application).');
    process.exit(1);
}
const isDryRun = !opts.apply;

/** Miroir exact de derivePassword() dans provisioning.js. */
function deriveV5(login, pin) {
    const material = 'asufor_auth_v5:' + String(login).trim() + ':' + String(pin).trim();
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

async function main() {
    const admin = require('firebase-admin');
    admin.initializeApp({
        credential: admin.credential.cert(require(path.resolve(opts.serviceAccount))),
        databaseURL: opts.dbUrl
    });

    const pins = require(path.resolve(opts.pins));
    const logins = Object.keys(pins);

    console.log('═══ Migration des mots de passe Firebase Auth (PIN brut → dérivé v5) ═══');
    console.log(`Mode : ${isDryRun ? 'DRY-RUN' : 'APPLY'} — ${logins.length} compte(s) à traiter`);
    console.log('');

    let migrated = 0, failed = 0;

    for (const login of logins) {
        const pin = String(pins[login]);
        if (!/^\d{6}$/.test(pin)) {
            console.log(`  ✗ ${login} : PIN invalide (doit être 6 chiffres) — ignoré.`);
            failed++;
            continue;
        }

        const email = login.includes('@') ? login : login + '@asufor.local';
        try {
            const user = await admin.auth().getUserByEmail(email);
            const newPassword = deriveV5(login, pin);

            console.log(`  ${isDryRun ? '[DRY]' : '✓'} ${login} (uid ${user.uid.substring(0, 8)}…) → mot de passe dérivé ${newPassword.substring(0, 12)}…`);

            if (!isDryRun) {
                await admin.auth().updateUser(user.uid, { password: newPassword });
            }
            migrated++;
        } catch (err) {
            console.log(`  ✗ ${login} : ${err.message}`);
            failed++;
        }
    }

    console.log('');
    console.log(`═══ Résultat : ${migrated} migré(s), ${failed} échec(s) ═══`);
    if (isDryRun && migrated > 0) {
        console.log('Relancez avec --apply pour appliquer.');
    }
    console.log('');
    console.log('⚠️  RAPPEL : supprimez le fichier pins.json après la migration !');

    await admin.app().delete();
}

main().catch(err => {
    console.error('Erreur :', err.message);
    process.exit(1);
});
