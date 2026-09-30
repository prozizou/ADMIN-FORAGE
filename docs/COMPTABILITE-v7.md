# Comptabilité v7 — factures, paiements, arriérés, avances

Ce document décrit la refonte comptable v7 d'ADMIN-FORAGE : audit de départ, architecture,
plan de migration, déploiement, règles de sécurité et tests.

## 1. Audit de l'existant (avant v7)

| Constat | Conséquence |
|---|---|
| Arriérés stockés dans `compteurs/*/arriere` et `arrieres`, recalculés depuis `backup` (`computeArrears`) et parfois surchargés à la main (impression) | Deux sources de vérité, montants divergents entre Statistiques et Impression |
| Paiement = bascule `status: paye` sur le relevé du mois et en cascade sur les archives | Pas de montant, de mode ni de reçu. Aucun paiement partiel, aucune avance, pas d'historique |
| Annulation d'un paiement = remise à `impaye` | Rien n'est tracé |
| Champs hérités `apaid`, `arriere`, `arrieres`, `facture`, `print`, `diff`… réécrits par la clôture, la liste compteurs et les statistiques | Ces champs reviennent dans la base après chaque nettoyage |
| Consommation > 100 m³ : alerte visuelle seulement | Rien n'est traçable, et un montant est rajouté à chaque cycle impayé |
| Export de référence (`asufor-67a06`) | 93 500 F d'impayés réels répartis sur 20 relevés et 17 compteurs, plus 55 relevés en anomalie (régression d'index) exclus |

## 2. Architecture

### Nœuds (sous `Asufor/{forageKey}/`)

| Nœud | Contenu | Écriture |
|---|---|---|
| `factures/{cycle_compteurId}` | Facture figée à la clôture (index, consommation, `montant_initial`, `montant_net`, `montant_paye`, `reste_a_payer`, `statut`, `probleme`, `source`, `verrouillee`, `rev`) | Clôture, migration. Les champs dérivés sont recalculés à chaque opération |
| `paiements/{id}` | Encaissement immuable : montant, mode, référence, n° de reçu, auteur, date | Création seulement. L'annulation (président) ne change que `statut` et les champs `annule_*` |
| `affectations/{paiementId}/{factureId}` | Répartition FIFO : `facture_id`, `cycle`, `montant`, `ordre` | Calculée par le moteur. Une annulation la passe à `annulee` |
| `ajustements/{id}` | `remise`, `majoration`, `correction`, `annulation`, avec un motif obligatoire | Le trésorier propose (`en_attente`), le président valide ou rejette |
| `soldes/{compteurId}` | Cache : facturé, payé, arriérés, avance, `rev` | Réécrit à chaque opération. Reconstructible (`buildSoldesRebuild`) |
| `audit_comptable/{id}` | Événements `FACTURE_CREEE`, `PAIEMENT_CREE`, `PAIEMENT_ANNULE`, `AJUSTEMENT_*`, `FACTURE_ANNULEE`, `PROBLEME_RESOLU`, `CLOTURE_EFFECTUEE`, `MIGRATION_EFFECTUEE` | Création seulement, jamais modifiés |
| `migration_comptable/v1` | Date, source, `total_arrieres`, `nb_factures_migrees`, statut, auteur | Écrit une seule fois |

Les compteurs ne portent plus aucun arriéré. Leur `status` (payé ou impayé) n'est plus qu'un
indicateur d'affichage : le moteur l'écrit après chaque opération.

### Code

- **`compta.js`**, le moteur pur (UMD, sans Firebase, testé sous Node). Il calcule et prépare
  toutes les écritures d'une opération sous forme d'un objet `updates` multi-chemins, appliqué
  en une seule fois par `update(ref(db), updates)`. L'écriture est donc atomique : tout passe,
  ou rien.
- **`compta-ui.js`** fait le lien avec Firebase :
  - il relit les nœuds comptables juste avant chaque écriture ;
  - il ouvre la boîte « Encaisser » (montant, mode, n° de reçu, référence, aperçu des factures
    soldées et du reste) ;
  - il affiche la bannière et la boîte de migration.
- **`billing.js`** garde le calcul des relevés (consommation, anomalies, calcul historique
  depuis les archives) et la clôture des compteurs, sans les champs interdits.
- Pages nouvelles et modifiées :
  - `compte/releve.html` : relevé de compte d'un client, avec son historique et ses actions ;
  - `compte/recu.html` : reçu imprimable, filigrane « ANNULÉ » si le paiement est annulé ;
  - Statistiques : bouton Encaisser, lien Relevé, récapitulatif (Facturé, Encaissé, Arriérés,
    Avances, Ajustements, Problèmes) ;
  - Impression : total dû tiré du grand livre, avance déduite ;
  - Maintenance : la clôture émet les factures.

### Formules

- `montant_net` = `montant_initial` + majorations − remises ± corrections (ajustements validés).
- `reste_a_payer` = `montant_net` − Σ des affectations actives.
- **Arriérés** = Σ `reste_a_payer` des factures échues. Une facture est échue dès sa création,
  c'est-à-dire à la clôture du mois.
- **Avance** = Σ (montant du paiement − montant affecté) sur les paiements valides.
- **Affectation FIFO** : les factures ouvertes sont prises par cycle croissant, les paiements par
  date. Le surplus reste en avance et s'impute automatiquement sur la facture suivante, dès sa
  création à la clôture.
- **Encaissé** (statistiques) = Σ des paiements valides datés dans la période. Un arriéré réglé
  ce mois-ci compte donc dans l'encaissé du mois.
- **Consommation > 100 m³** : facturée normalement, avec `probleme` = {type `surconsommation`,
  niveau `alerte`, ou `critique` au-delà de 200 m³}. Elle compte comme un problème, et son
  montant n'entre qu'une fois dans les arriérés (une seule facture). « Résolu » ne veut pas dire
  « payé ».
- **Régression d'index** : aucune facture, le relevé est signalé en anomalie.

### Droits

| Action | Président | Trésorier | Secrétaire |
|---|---|---|---|
| Encaisser | ✔ | ✔ | ✘ |
| Annuler un paiement | ✔ (motif) | ✘ | ✘ |
| Ajustement | Crée et valide | Propose (`en_attente`) | ✘ |
| Annuler une facture | ✔ (si rien n'est encore payé) | ✘ | ✘ |
| Résoudre un problème | ✔ | ✘ | ✔ |
| Clôture, migration | ✔ | ✘ | ✘ |
| Supprimer quoi que ce soit | ✘ | ✘ | ✘ |

L'annulation d'un paiement (correction d'une saisie erronée) est accessible aussi bien depuis le relevé
de compte que depuis un bouton dédié dans Statistiques, sur la carte du client concerné — les deux
appellent `Compta.buildPaymentCancelOps` et n'affichent le bouton que s'il existe au moins un paiement
valide à annuler.

### Corriger un mois archivé

Un mois clôturé reste modifiable, chaque correction restant tracée :

- **Index / facteur** : le crayon (« Modifier ») ouvre le même formulaire que pour le mois en cours.
  La facture déjà figée n'est jamais réécrite ; l'écart devient un ajustement `correction`, validé
  automatiquement (`Compta.buildArchiveCorrectionOps`), avec l'ancien et le nouvel index dans le motif.
- **Encaisser / annuler un encaissement** : disponibles depuis n'importe quel mois affiché dans
  Statistiques, y compris une archive — régler une vieille dette ou corriger un paiement mal saisi ne
  dépend pas du mois consulté à l'écran. Le paiement reste daté d'aujourd'hui et réglé en FIFO sur les
  factures ouvertes les plus anciennes. Le relevé utilisé pour la facture provisoire du mois en cours et
  pour le statut payé/impayé du compteur est toujours le relevé RÉELLEMENT en cours (relu depuis
  `compteurs/{id}` si une archive est affichée), jamais celui de l'archive à l'écran.
- **Mois archivé marqué « Payé » à remettre en « Non payé »** (président) : bouton « Non payé » sur la
  carte d'archive. Si le mois n'a aucun encaissement enregistré (ancien statut), l'archive repasse à
  `impaye` et la facture correspondante est créée dans le grand livre (`Compta.buildArchiveCorrectionOps`,
  source `correction_releve`, audit `FACTURE_CREEE`, motif obligatoire), en une seule écriture atomique :
  la dette réapparaît dans les arriérés. Si la facture a été réglée par un vrai encaissement, on ne la
  « dé-paie » pas isolément : « Annuler encaissement » s'ouvre (contre-écriture tracée du paiement).
- **Remise, majoration, annulation d'une facture** : depuis le relevé de compte (bouton Ajustement),
  qui liste les factures de tous les mois, archivés compris.

Les règles Firebase imposent ces droits en plus de l'interface :
- création seule (`!data.exists()`) sur les paiements, les affectations et l'audit ;
- champs immuables sur les factures et les paiements ;
- `rev` = ancien + 1 sur `factures` et `soldes`, pour qu'une écriture concurrente périmée soit
  refusée ;
- énumérations vérifiées par expression régulière.

## 3. Plan de migration

1. **Sauvegarde** : la boîte de migration oblige à télécharger le JSON complet du forage avant
   d'activer le bouton « Migrer ».
2. **Calcul** (`Compta.buildMigrationOps`) : pour chaque relevé archivé `impaye` et non anormal,
   une facture `source: "migration_backup"` est créée pour son cycle. Les doublons entre archives
   sont dédupliqués par numéro de compteur et zone.
3. **Écriture** en une seule opération : factures, soldes, audit `MIGRATION_EFFECTUEE`, puis
   `migration_comptable/v1`.
4. **Aucun paiement rétroactif.** Les relevés du mois courant déjà marqués « payé » sont
   seulement comptés (`releves_marques_payes`) et signalés : il faudra les encaisser avec leur
   montant réel.
5. Archives et compteurs restent intacts.

Tant que la migration n'est pas faite, la clôture est bloquée et le bouton Encaisser est
désactivé. Les statistiques restent disponibles en mode historique, calculé depuis les archives.

Vérification hors ligne sur un export :

```bash
node scripts/migrate-comptable.js --input export.json --csv rapport.csv
```

Résultat sur l'export de référence : **93 500 F**, 20 factures, 17 compteurs, 55 relevés en
anomalie exclus, dont une facture en surconsommation (115 m³, 28 750 F, septembre). Le total est
identique au calcul historique de `billing.js`.

## 4. Déploiement (dans cet ordre)

1. Publier `database.rules.json`. Si la console mobile tronque le texte, générer la version
   compacte (environ 18 Ko) avec `node scripts/rules-compact.js`, qui produit
   `database.rules.min.json`, ignoré par git.
2. Déployer le site. Le service worker passe en `asufor-cache-v52`.
3. Le président ouvre Statistiques, clique sur « Migrer », télécharge la sauvegarde puis confirme.
4. Les encaissements et les clôtures suivent le nouveau flux.

⚠️ Les règles n'autorisent plus d'écriture sur les anciens nœuds hérités (refus par défaut). Une
application de relevé externe qui écrirait encore `arriere` ou `apaid` sur les compteurs n'est
pas bloquée par les règles, mais ces champs ne sont plus lus.

## 5. Tests

| Suite | Commande | Contenu |
|---|---|---|
| Moteur comptable | `node scripts/compta.test.js` | 24 scénarios, plus une vérification sur l'export réel (`COMPTA_JSON=…`). Couvre : paiement total, partiel, multiple ; FIFO ; avance puis imputation ; annulation et réaffectation ; ajustements et droits ; surconsommation comptée une fois ; régression ; clôture idempotente ; migration ; cache des soldes ; statistiques de période |
| Facturation | `node scripts/billing.test.js` | 29 tests (relevés, anomalies, calcul historique, clôture sans champs interdits) |
| Règles | `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9010 node --test scripts/rules-test/rules.test.js` | 39 tests sur l'émulateur, avec la version complète et la version compacte des règles |
| Interface | `node --test scripts/smoke/smoke.test.js` (Chromium) | Migration, encaissement, relevé, reçu, impression, maintenance |
| Autres | `npm test` dans `scripts/` | Biométrie, crypto, intégration, v5 |

## 6. Décisions et limites

- La date d'échéance est la date de création : un mois clôturé est dû.
- Les règles des anciens nœuds ont été retirées. La base de référence n'en contient pas.
- Le trésorier propose les ajustements, le président les valide.
- La secrétaire peut marquer un problème résolu, sans aucun droit financier.
- Les relevés marqués « payé » sans paiement ne sont pas convertis en faux paiements.
- Les éventuels écarts du cache `soldes` se corrigent par reconstruction (`buildSoldesRebuild`,
  `checkSoldes`). Le cache ne fait jamais foi.
