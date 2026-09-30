# ASUFOR Admin

Application web (PWA) de gestion administrative des forages ruraux ASUFOR :
relevés de compteurs d'eau, facturation à l'index, suivi des arriérés,
statistiques de paiement, gestion d'équipe et — depuis la refonte
multi-forage — hébergement de **plusieurs villages** sur une même base
Firebase. 100 % HTML/CSS/JS statique, sans build ni framework, déployé sur
Vercel.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Stack technique](#stack-technique)
- [Architecture](#architecture)
- [Forces](#forces)
- [Faiblesses / limites connues](#faiblesses--limites-connues)
- [Améliorations prioritaires](#améliorations-prioritaires)
- [Déployer](#déployer)
- [Tests](#tests)
- [Documentation complémentaire](#documentation-complémentaire)

## Fonctionnalités

| Page | Rôle(s) | Description |
|------|---------|-------------|
| `index.html` | tous | Connexion (identifiant = téléphone + code PIN à 6 chiffres) |
| `home/accueil.html` | tous | Tableau de bord, accès aux modules selon le rôle |
| `agents/agent.html` | président, secrétaire | Création/gestion des agents releveurs de terrain |
| `counter/list.html` | président, secrétaire, trésorier | Liste et saisie des compteurs (relevés d'index) |
| `statistiques/stats.html` | tous | Statistiques de paiement, marquage payé/impayé (inclut les anomalies au niveau du compteur) |
| `impression/impression.html` | tous | Impression des factures et relances d'arriérés |
| `reset/zero.html` | président | Clôture de cycle mensuel (archivage + remise à zéro) |
| `equipe/equipe.html` | président | Création des comptes secrétaire/trésorier de son forage |
| `admin/admin.html` | super-admin | Création des présidents, vue à 360° sur tous les forages |

## Stack technique

- **Frontend** : HTML/CSS/JS vanilla, pas de framework, pas d'étape de build.
- **Backend** : Firebase (Auth + Realtime Database), SDK compat chargé en CDN.
- **PWA** : `manifest.json`, `sw.js` (service worker), installable/hors-ligne partiel.
- **Hébergement** : Vercel (site statique).
- **Scripts de maintenance** : Node.js (`scripts/`, `firebase-admin` en dépendance optionnelle).
- **CI** : GitHub Actions — exécute les tests unitaires de `billing.js` à chaque push/PR (`.github/workflows/ci.yml`).

## Architecture

- **`billing.js`** — source unique de vérité pour tous les calculs de
  facturation (facture courante, détection d'anomalie, cumul des arriérés,
  updates de paiement/révocation). Partagé par le navigateur (`window.Billing`)
  et Node.js (scripts de migration), ce qui garantit des montants identiques
  partout.
- **`forage-context.js`** — couche d'abstraction multi-forage : résout la
  `forageKey` de l'utilisateur courant et construit tous les chemins Firebase
  (`Asufor/{forageKey}/...`), avec un mode `LEGACY` pour la migration en douceur.
- **`security.js`** — session locale (`asufor_session`, expiration 8h),
  contrôle d'accès par rôle (`checkAccess`), échappement HTML partagé (`escHtml`).
- **`provisioning.js`** — création de comptes via une instance Firebase
  secondaire (le créateur reste connecté pendant qu'il crée le compte d'un tiers).
- **`database.rules.json`** — règles de sécurité Realtime Database : refus par
  défaut, accès scopé par rôle et par `forageKey`, super-admin (`prozizou298@gmail.com`)
  ayant accès à tout.
- **Modèle multi-forage** : `Asufor/{forageKey}/{config,compteurs,backup,agents,depenses,team}`
  + `users/{uid} = {role, forageKey}`. Détails complets dans
  [`docs/MULTI-FORAGE.md`](docs/MULTI-FORAGE.md).

## Forces

- **Logique métier centralisée et testée** : tous les calculs de facturation
  passent par `billing.js`, avec une suite de tests unitaires
  (`scripts/billing.test.js`) exécutée automatiquement en CI à chaque push/PR —
  évite les montants divergents entre l'impression, les statistiques et les
  scripts de migration.
- **Gestion robuste des anomalies** : un index décroissant ou manquant ne
  génère jamais une facture aberrante ; le mois est marqué en anomalie et
  exclu du cumul des arriérés plutôt que de fausser silencieusement les comptes.
- **Tolérance aux données réelles hétérogènes** : `billing.js` et les règles
  Firebase acceptent indifféremment `facteur`/`last_index` en `string` ou
  `number`, reflet de données de production imparfaites plutôt que de bugs
  applicatifs.
- **Architecture multi-forage bien pensée** : schéma de données strictement
  identique pour chaque village (`Asufor/{forageKey}/...`), ajout d'un nouveau
  forage sans changement de code, isolation garantie par les règles Firebase
  (un président ne peut ni lire ni écrire hors de son forage).
- **Migration progressive et réversible** : bascule `LEGACY` par village,
  scripts de migration en mode `--dry-run` par défaut (jamais d'écriture
  accidentelle), rapport détaillé avant toute application réelle.
- **Sécurité applicative soignée** : échappement HTML systématique
  (`escHtml`) contre le XSS stocké, règles Firebase en refus par défaut avec
  validation de schéma par champ (`$other: false` sur les nœuds sensibles),
  expiration de session (8h), verrou anti-brute-force sur le code PIN.
- **PWA fonctionnelle** : installable, icônes complètes, raccourcis
  d'application, service worker versionné.
- **Documentation technique dense** : `docs/MULTI-FORAGE.md` et
  `scripts/README-FACTURATION.md` documentent en détail le modèle de
  données, le runbook de déploiement et les cas de test des règles de
  sécurité.

## Faiblesses / limites connues

- **Pas de suite de tests pour le frontend** : seul `billing.js` (logique
  pure) est testé. Les 3000+ lignes de HTML/JS des pages (`stats.js`,
  `impression.html`, `zero.html`…) n'ont aucun test
  automatisé — les régressions ne sont détectables qu'en manuel.
- **Comptes Firebase partagés historiques** : les comptes legacy
  (`president@diandioly.com`, etc.) ne permettent aucune traçabilité
  individuelle de qui a fait quelle action, tant qu'ils n'ont pas été
  remplacés par des comptes individuels (téléphone + PIN).
- **Verrou anti-brute-force côté client uniquement** (`sessionStorage`) :
  contournable en navigation privée ou en vidant le storage local — une
  vraie protection nécessiterait Firebase App Check ou une Cloud Function.
- **Rôles déduits par e-mail dans les règles legacy** : `database.rules.json`
  compare `auth.token.email` à des adresses en dur pour Diandioly plutôt que
  d'utiliser des *custom claims* — plus fragile (renommer un compte casse les
  règles) que les règles namespacées `Asufor/{forageKey}` qui, elles,
  utilisent déjà `users/{uid}.role`.
- **Pas de Cloud Functions** : toute la logique (calculs, provisioning,
  migrations) s'exécute côté client ou via des scripts Node lancés
  manuellement — aucune validation serveur indépendante du client, aucune
  tâche planifiée (ex. clôture automatique de cycle, rappels de paiement).
- **Absence de `.gitignore`** : le dépôt ne contient aucun `.gitignore` alors
  que `scripts/README-FACTURATION.md` affirme que `serviceAccountKey.json`
  « est couverte par .gitignore » — ce n'est pas le cas, risque réel de
  commit accidentel d'une clé de service Firebase.
- **`firebase-config.js` commité avec une vraie clé API** : acceptable pour
  une config Firebase côté client (protégée par les règles de sécurité et la
  restriction de domaine), mais `messagingSenderId`/`appId` sont vides
  depuis plusieurs versions — dette non résolue.
- **Pas de CI pour le linting/format ni de vérification HTML** : le seul
  job CI couvre `billing.js` ; aucune vérification automatique de la syntaxe
  ou de la cohérence des ~10 pages HTML.
- **Pas de gestion des dépendances frontend** : Firebase SDK chargé en CDN
  (`firebasejs/10.7.1/...`), sans verrouillage de version ni fallback en cas
  d'indisponibilité du CDN.
- **Fonctionnement hors-ligne partiel** : le service worker met en cache les
  ressources statiques mais l'application dépend de Firebase Realtime
  Database en direct pour toute donnée — pas de vraie synchronisation
  offline-first.
- **Un seul super-admin en dur** (`SUPERADMIN_EMAIL` codé en dur dans
  `forage-context.js` et dans les règles Firebase) : pas de gestion multi
  super-admin sans modifier le code et redéployer les règles.

## Améliorations prioritaires

1. **Ajouter un `.gitignore`** couvrant au minimum `scripts/*.json` (exports
   Firebase, `serviceAccountKey.json`), `node_modules/`, fichiers `.env`.
2. **Basculer les rôles legacy vers des *custom claims* Firebase** (`role`,
   `forageKey`) au lieu de comparer des e-mails en dur dans les règles —
   plus robuste et déjà amorcé côté multi-forage via `users/{uid}`.
3. **Étendre la couverture de tests** : au minimum des tests d'intégration
   légers (ex. Playwright) sur les parcours critiques — connexion, saisie
   d'un relevé, marquage payé/impayé, clôture de cycle.
4. **Migrer les 3 comptes partagés Diandioly** vers des comptes individuels
   (téléphone + PIN) pour la traçabilité, comme prévu en Phase 5 de
   `docs/MULTI-FORAGE.md`.
5. **Renforcer l'anti-brute-force** avec Firebase App Check ou une Cloud
   Function de rate-limiting, le verrou `sessionStorage` actuel étant
   uniquement dissuasif.
6. **Ajouter une CI de vérification statique** (lint JS, validation HTML) en
   plus des tests `billing.js` déjà en place.
7. **Compléter `firebase-config.js`** (`messagingSenderId`, `appId`) et
   documenter la restriction de domaine de la clé API dans la console
   Firebase.
8. **Support multi super-admin** : remplacer la constante unique
   `SUPERADMIN_EMAIL` par un noeud `superadmins/{uid}` (déjà envisagé dans
   `docs/MULTI-FORAGE.md`), pour ne plus nécessiter un redéploiement de code
   à chaque changement d'administrateur.
9. **Vraie stratégie offline-first** pour les zones à connectivité limitée
   (file d'attente d'écritures en attente de réseau), cohérent avec le
   contexte rural de l'application.

## Déployer

```bash
# Option CLI
npm i -g vercel
vercel --prod

# Ou : https://vercel.com/new → drag & drop ce dossier
```

> ⚠️ La racine du déploiement Vercel doit être ce dossier (où se trouvent
> `index.html`, `firebase-config.js`, `sw.js`) : toutes les ressources sont
> référencées en chemins absolus.

Après déploiement, vérifier (F12 → Console) :
- ✅ `[PWA] Service Worker enregistré : https://<ton-site>/`
- ❌ Aucune erreur `404` ni `Firebase: Need to provide api options`

## Tests

```bash
cd scripts
npm install
npm test        # exécute scripts/billing.test.js
```

Ces tests couvrent `billing.js` (facture courante, détection d'anomalie,
cumul des arriérés, updates de paiement) et tournent automatiquement en CI
sur chaque push/PR (`.github/workflows/ci.yml`).

## Documentation complémentaire

- [`docs/MULTI-FORAGE.md`](docs/MULTI-FORAGE.md) — architecture multi-forage,
  modèle de données, runbook de déploiement, cas de test des règles Firebase.
- [`docs/COMPTABILITE-v7.md`](docs/COMPTABILITE-v7.md) — comptabilité v7 :
  factures, paiements, affectations FIFO, avances, ajustements, migration.
- [`scripts/README-FACTURATION.md`](scripts/README-FACTURATION.md) — logique
  de facturation et guide des scripts (`migrate-comptable.js`,
  `migrate-multi-forage.js`).
