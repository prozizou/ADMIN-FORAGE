# Facturation & Arriérés ASUFOR — Guide technique

Ce document décrit la logique de facturation basée sur l'index de consommation,
le suivi des arriérés, et l'usage des scripts de migration.

## Vue d'ensemble

Toute la logique de calcul vit désormais dans **un seul fichier** : `billing.js`
(à la racine du projet). `impression.html`, `stats.js` et le script de migration
l'utilisent tous, ce qui garantit des montants identiques partout.

## Règles métier

1. **Facture courante** = `(new_index − last_index) × facteur`
   Les valeurs Firebase sont souvent stockées en texte ; `billing.js` les convertit
   systématiquement en nombres (`Billing.toInt`).

2. **Anomalie** si `new_index < last_index` (compteur non relevé, remis à zéro ou
   remplacé) ou si un index est manquant/non numérique.
   → la facture n'est pas calculée (montant = 0), un drapeau `anomalie` est levé,
   et **ce mois est exclu du cumul des arriérés**.

3. **Arriérés** = somme des factures **recalculées** pour chaque cycle passé
   (`asufor_backup`) où `status === "impaye"`, pour un même compteur identifié par
   **numéro de compteur + zone** (les numéros ne sont uniques que par zone).

4. **Total dû** à l'instant T = `facture_courante + arriere`.

## Régularisation d'un paiement (cascade)

Quand un usager paie (bouton « Payé » dans les statistiques) :

- Base active `asufor_db_diandioly` : `status → paye`, `arriere → 0`,
  `date_paiement` renseignée.
- Historique `asufor_backup` : chaque cycle impayé de ce compteur passe à `paye`
  avec une `date_paiement` (traçabilité comptable).

La révocation (« NON PAYÉ ») ne touche que la base active.

## Schéma de données cible (`asufor_db_diandioly/<clé>`)

Champs ajoutés par la migration :

| champ              | type    | rôle                                   |
|--------------------|---------|----------------------------------------|
| `facture_courante` | number  | facture du mois en cours               |
| `arriere`          | number  | cumul des cycles passés impayés (≥ 0)  |
| `total_du`         | number  | `facture_courante + arriere`           |
| `anomalie`         | boolean | mois courant en anomalie ?             |
| `anomalie_raison`  | string  | libellé si anomalie                    |
| `arriere_calc_at`  | ISO     | horodatage du dernier calcul           |

## Script de migration

Le script `migrate-arrears.js` calcule ces champs pour les 417 compteurs.

### Étape 1 — Simulation (aucune écriture, 100 % sûr)

Placez les deux exports Firebase à côté du script (renommés `active.json` et
`backup.json`), puis :

```bash
cd scripts
node migrate-arrears.js --dry-run \
     --active ./active.json \
     --backup ./backup.json \
     --current-cycle 2026-07 \
     --report ./rapport-arrieres.csv
```

Vous obtenez un rapport (total des arriérés, top 10, liste des anomalies) et un
CSV détaillé, **sans toucher à Firebase**.

### Étape 2 — Application réelle

1. Dans la console Firebase → Paramètres → Comptes de service → générez une clé
   privée (fichier JSON). Placez-la dans `scripts/serviceAccountKey.json`.
   **Ne la committez jamais.**
2. Installez la dépendance : `npm install` (dans `scripts/`).
3. Lancez :

```bash
node migrate-arrears.js --apply \
     --service-account ./serviceAccountKey.json \
     --db-url https://asufor-67a06-default-rtdb.firebaseio.com \
     --current-cycle 2026-07
```

Le script lit la base en direct, calcule, puis écrit par lots.

### Option `--current-cycle`

Détermine quel mois est « courant » : tout cycle de `asufor_backup` dont la clé
est **supérieure ou égale** à cette valeur est ignoré dans le cumul (on ne compte
comme arriéré que le passé strict). Par défaut, le mois calendaire courant.

## Sécurité

- La clé de compte de service donne un accès administrateur complet : gardez-la
  hors du dépôt (elle est couverte par `.gitignore`).
- Toujours lancer un `--dry-run` et vérifier le rapport avant `--apply`.
