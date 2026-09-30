# Facturation & comptabilité ASUFOR — Guide technique

> Depuis la v7, les arriérés ne sont **plus stockés ni saisis** sur les compteurs. Ils se déduisent
> du grand livre `factures` / `paiements` / `affectations` / `ajustements`.
> Architecture complète, migration et déploiement : [`docs/COMPTABILITE-v7.md`](../docs/COMPTABILITE-v7.md).

## Répartition du code

| Fichier | Rôle |
|---|---|
| `billing.js` | Relevés : consommation, montant du mois, anomalies (index qui régresse ou manquant), surconsommation (> 100 m³), index des archives, calcul historique depuis `backup` (mode lecture seule d'avant la migration), écritures de clôture des compteurs |
| `compta.js` | Grand livre : factures, paiements, affectation FIFO, avances, ajustements, problèmes, clôture, migration, soldes, statistiques de période. Chaque opération renvoie un objet `updates` multi-chemins, appliqué en une seule écriture atomique |
| `compta-ui.js` | Lien avec Firebase (relecture avant écriture, boîtes « Encaisser » et « Migrer ») |

## Règles métier

1. **Montant d'un relevé** = `(new_index − last_index) × facteur`. Les valeurs texte sont
   converties (`Billing.toInt`).
2. **Anomalie** si l'index régresse ou manque : aucune facture n'est émise.
3. **Surconsommation** (> 100 m³) : facturée normalement, avec un bloc `probleme` sur la facture.
   Elle n'est comptée qu'une fois dans les arriérés.
4. **Clôture mensuelle** (Maintenance, président, après migration) : elle archive le mois, émet une
   facture par relevé valide (`factures/{cycle}_{compteurId}`) et impute automatiquement les
   avances existantes.
5. **Encaissement** (bouton « Encaisser », président ou trésorier) : il crée un paiement immuable,
   l'affecte en FIFO aux factures les plus anciennes, et garde le surplus en avance. Il ouvre le
   reçu imprimable.
6. **Arriérés** = Σ `reste_a_payer` des factures échues. **Avance** = paiements non affectés.
   **Total dû maintenant** = arriérés + montant du mois en cours − avance.
7. **Corrections** : un paiement ne se modifie jamais. Il s'annule (président, avec motif), ou on
   passe par un ajustement (remise, majoration, correction, annulation, avec motif obligatoire).

## Scripts

| Script | Usage |
|---|---|
| `migrate-comptable.js` | Aperçu hors ligne de la migration v7 sur un export JSON : `node scripts/migrate-comptable.js --input export.json [--forage Asufor_x] [--out ecritures.json] [--csv rapport.csv]`. N'écrit rien dans Firebase. La migration réelle se lance dans l'application (Statistiques, « Migrer ») |
| `rules-compact.js` | Génère `database.rules.min.json` (sans indentation) pour la console Firebase mobile |
| `migrate-multi-forage.js` | Migration historique vers la structure multi-forage |

Dans `scripts/`, `npm run migration-comptable-apercu` lance le premier script sur `./export.json`.

## Sécurité

- Les exports JSON contiennent des données personnelles : ne jamais les commiter.
- Les clés de compte de service restent hors du dépôt (`.gitignore`).
