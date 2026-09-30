#!/usr/bin/env node
/**
 * migrate-comptable.js — Aperçu / vérification de la migration comptable v7 depuis un export Firebase
 * ====================================================================================================
 *
 * La migration RÉELLE se lance dans l'application (Statistiques → « Migrer », président) : elle
 * télécharge d'abord une sauvegarde, puis écrit en une seule opération sous les règles de sécurité.
 * Ce script sert à la VÉRIFIER hors ligne sur un export JSON de la base (console Firebase →
 * Realtime Database → ⋮ → Exporter le JSON) : aucune écriture, aucune connexion.
 *
 *   node scripts/migrate-comptable.js --input export.json [--forage Asufor_x] [--out ecritures.json] [--csv rapport.csv]
 *
 * Il affiche, par forage : total des arriérés retrouvés, nombre de factures « migration_backup »,
 * compteurs concernés, détail par mois, relevés en anomalie exclus, et compare au calcul historique
 * (billing.js). --out écrit l'objet de mises à jour qui serait appliqué (pour relecture).
 *
 * ⚠️ Les exports contiennent des données personnelles : ne jamais les commiter.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Billing = require(path.join(__dirname, '..', 'billing.js'));
const Compta = require(path.join(__dirname, '..', 'compta.js'));

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 ? process.argv[i + 1] : null;
}

const input = arg('input');
if (!input) {
    console.error('Usage : node scripts/migrate-comptable.js --input export.json [--forage Asufor_x] [--out ecritures.json] [--csv rapport.csv]');
    process.exit(2);
}
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const forages = arg('forage') ? [arg('forage')] : Object.keys(data.Asufor || {});
const now = new Date().toISOString();
let seq = 0;
const newId = () => 'apercu-' + (++seq);
const allUpdates = {};
const csv = ['forage;cycle;compteur_id;numero;client;consommation_m3;montant;probleme'];
let exitCode = 0;

forages.forEach((fk) => {
    const F = (data.Asufor || {})[fk];
    if (!F) { console.error('Forage introuvable : ' + fk); exitCode = 1; return; }
    const paths = Compta.pathsFor('Asufor/' + fk);
    const existing = Compta.normState(F);
    if (F.migration_comptable && F.migration_comptable.v1) {
        console.log(`\n${fk} : migration déjà effectuée le ${F.migration_comptable.v1.date} (${F.migration_comptable.v1.total_arrieres} F).`);
        return;
    }
    const r = Compta.buildMigrationOps(existing, { paths, backup: F.backup || {}, now, user: { uid: 'apercu', nom: 'aperçu', role: 'président' }, newId });
    const idx = Billing.indexBackups(F.backup || {});
    let historique = 0;
    Object.keys(F.compteurs || {}).forEach(k => { historique += Billing.computeArrears(F.compteurs[k], idx, { fbKey: k }).arriere; });

    const m = r.resume;
    console.log(`\n══ ${fk} ══`);
    console.log(`  Arriérés retrouvés dans les archives : ${m.total_arrieres} F`);
    console.log(`  Factures « migration_backup »         : ${m.nb_factures_migrees}`);
    console.log(`  Compteurs concernés                   : ${m.nb_compteurs}`);
    console.log(`  Relevés en anomalie exclus            : ${m.anomalies_exclues}`);
    console.log(`  Par mois                              : ${Object.keys(m.par_cycle).sort().map(c => c + ' = ' + m.par_cycle[c] + ' F').join(', ') || '—'}`);
    console.log(`  Calcul historique (billing.js)        : ${historique} F ${historique === m.total_arrieres ? '✓ identique' : '✗ DIFFÉRENT'}`);
    console.log(`  Paiements créés                       : 0 (aucun paiement rétroactif)`);
    if (historique !== m.total_arrieres) exitCode = 1;

    Object.keys(r.updates).forEach(k => {
        allUpdates[k] = r.updates[k];
        const f = r.updates[k];
        if (k.indexOf('/factures/') !== -1 && f && f.facture_id) {
            csv.push([fk, f.cycle, f.compteur_id, f.numero_compteur, String(f.client).replace(/;/g, ' '), f.consommation, f.montant_initial, f.probleme ? f.probleme.type : ''].join(';'));
        }
    });
});

if (arg('out')) { fs.writeFileSync(arg('out'), JSON.stringify(allUpdates, null, 2)); console.log('\nÉcritures prévues : ' + arg('out')); }
if (arg('csv')) { fs.writeFileSync(arg('csv'), '﻿' + csv.join('\n') + '\n'); console.log('Rapport CSV : ' + arg('csv')); }
process.exit(exitCode);
