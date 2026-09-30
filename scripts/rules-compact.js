#!/usr/bin/env node
/**
 * rules-compact.js — Génère une version COMPACTE (sans commentaires, minifiée) de database.rules.json.
 *
 * La console Firebase (surtout sur mobile) tronque les très longs collages : la version compacte,
 * sémantiquement identique, est plus sûre à coller. `firebase deploy --only database` n'a pas
 * cette limite et utilise directement database.rules.json.
 *
 *   node scripts/rules-compact.js [sortie.json]      (défaut : database.rules.min.json, ignoré par git)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
const rules = JSON.parse(src.replace(/^\s*\/\/.*$/gm, ''));
const out = process.argv[2] || path.join(__dirname, '..', 'database.rules.min.json');
fs.writeFileSync(out, JSON.stringify(rules));
console.log(out + ' : ' + fs.statSync(out).size + ' octets (source : ' + Buffer.byteLength(src) + ' octets)');
