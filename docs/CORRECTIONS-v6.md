# Corrections v6 — arriérés, paiements, clôture, isolation par forage

## 1. Ce qui change

| Sujet | Avant | Maintenant |
|---|---|---|
| **Isolation des comptes** | un président pouvait réécrire la fiche `users/{uid}` de n'importe quel utilisateur (y compris le président d'un autre forage) en y posant sa `forageKey` ; il lisait le journal d'audit de tous les forages ; un compte sans `forageKey` retombait sur Diandioly | règle `users/$uid` : un compte existant n'est modifiable que s'il est déjà du forage du président (jamais un président) ; `audit_arrieres` lisible seulement par le président **du forage** ; `index.html` refuse un compte sans forage |
| **Arriérés (impression + Statistiques)** | deux calculs qui divergeaient | **un seul calcul** (`billing.js`) : cumul intégral des mois archivés impayés (payés et anomalies exclus) + correction manuelle enregistrée |
| **Recherche dans les archives** | numéro + zone (collisions, clients sans numéro, numéro modifié) | clé Firebase d'abord ; repli numéro + zone seulement s'il est renseigné, unique dans le cycle et pas la fiche d'un autre client actuel |
| **Régularisation par le trésorier** | refusée par les règles dès qu'il y avait des arriérés (écriture dans `backup`) | le trésorier (et le président) peut modifier **uniquement** les champs de paiement d'une ligne d'archive existante (`status`, `statut`, `date_paiement`, `last_modified_by/at`) |
| **Encaissement avant chargement des archives** | possible → arriérés non réglés | bouton grisé + refus tant que les archives ne sont pas chargées en entier ; relecture fraîche des lignes du client au moment de payer |
| **Clôture de cycle** | lecture puis écriture séparées : deux clôtures simultanées écrasaient l'archive avec des compteurs déjà remis à zéro | un seul `update` multi-chemins (`Billing.buildClosureUpdates`) ; les règles n'autorisent la **création** d'une archive de cycle qu'une fois (`!data.exists()`) → la 2ᵉ clôture est refusée en entier ; relecture juste avant l'écriture |
| **Accès legacy** | `db_agents`, `asufor_db_diandioly`, `asufor_backup`, `asufor_depenses`, `asufor_motivations` lisibles par tout utilisateur connecté | lecture : super-admin ou membre du forage `Asufor_diandioly` ; écriture : e-mails historiques **et** membre de Diandioly |
| **Corrections d'arriérés** | écrites dans `arrieres` mais jamais relues ; erreurs ignorées | enregistrées comme **ajustement** (`arrieres_ajustement`) relu par tous les écrans, journal d'audit dans la même écriture atomique, erreurs affichées |
| **« Encaissé »** | ignorait les arriérés réglés | encaissé = factures du mois payées + arriérés réglés (`arrieres_regles`) ; tendances calculées avec la même définition |
| **Numérotation** | le secrétaire ne pouvait pas écrire `config/next_counter_number` → échec à la création d'un compteur | le secrétaire peut **incrémenter** ce compteur (jamais le faire reculer, ni écrire un autre champ de config) |
| **Anomalies** | réglées d'office par le paiement en cascade | jamais réglées automatiquement (paiement, correction d'archive) ; signalées à l'écran |

Autres correctifs : corriger un paiement remet aussi à impayé les mois que ce paiement avait réglés ;
`refreshCard` (impression) supprimait le montant des arriérés de la carte après une correction ;
marquer une archive « payé » (maintenance) règle aussi les mois plus anciens du client.

## 2. Nouveaux champs (additifs, aucune migration)

Sur un relevé (base active, copiés tels quels dans l'archive à la clôture) :

- `arrieres_ajustement` — correction manuelle, FCFA signé (souhaité − cumul calculé) ; `arrieres_ajuste_par`, `arrieres_ajuste_le`.
- `arrieres_regles`, `cycles_regles` (`["2026-06|clé", …]`) — ce qu'un paiement a réglé (bilan « encaissé » + annulation exacte) ; `arrieres_ajustement_regle`.

Les champs historiques `arrieres`, `arriere`, `apaid` ne sont **pas** lus par le calcul (ils restent écrits comme avant par la clôture / le paiement).

## 3. Déploiement (dans cet ordre)

1. **Publier les règles** : `firebase deploy --only database` (un `firebase.json` est fourni à la racine) ou coller `database.rules.json` dans la console → Realtime Database → Règles.
2. Déployer le site (le service worker passe en `asufor-cache-v49`).

Les règles et le site sont compatibles dans les deux sens sauf : sans les nouvelles règles, l'encaissement en cascade reste refusé au trésorier ; avec les règles mais l'ancien site, une clôture reste possible (l'ancien code écrit bien l'archive en une écriture).

## 4. Tests

```bash
cd scripts && node billing.test.js            # moteur de calcul (44 tests)
cd scripts/rules-test && npm install && npm test   # règles sur le Firebase Emulator (34 tests)
cd scripts/smoke && npm install && npm test        # pages dans Chromium, Firebase simulé (21 vérifications)
```

`RULES_FILE=/chemin/ancien.rules.json` rejoue la suite de règles contre une autre version (sur les règles d'avant, 15 tests échouent : ils détectent bien les défauts corrigés).

## 5. Décisions et limites à connaître

- **Archives** : seul le super-admin peut récrire/supprimer une archive de cycle en bloc (restauration de secours). Le président corrige une ligne à la fois, sans pouvoir la supprimer.
- **Règlement d'arriérés d'archives** : président et trésorier. Un **secrétaire** qui encaisse un client ayant des arriérés reçoit un message clair (droits insuffisants) ; sans arriéré, rien ne change pour lui.
- **Correction d'arriérés sur un mois archivé** : réservée au président (message dédié pour les autres rôles).
- **`audit_arrieres`** : la règle de lecture « président du forage » ne peut pas restreindre en dessous du `.read` du forage (les règles Firebase se cumulent) : tout membre du forage peut le lire. Le journal reste isolé entre forages.
- **Clôture** : le garde-fou est côté serveur (création unique) + une relecture des compteurs juste avant l'écriture ; un paiement qui arriverait dans la fraction de seconde entre cette relecture et l'écriture ne peut pas être exclu par une écriture multi-chemins Firebase.
