# Multi-forage — Architecture & plan de déploiement

Ce document décrit le passage d'ASUFOR d'un déploiement **mono-forage**
(Diandioly, chemins en dur) à un système **multi-forage** hébergeant plusieurs
ASUFOR sur la même base Firebase.

---

## 1. Modèle

- **Super-admin** : `prozizou298@gmail.com`. Accès à **tous** les forages
  (lecture/écriture), gestion des présidents.
- **Forage** = un village + son président + son équipe. Identifié par une
  **`forageKey`** au format **`Asufor_<village>`** (ex. `Asufor_diandioly`,
  `Asufor_ogo`) — lisible, dérivée automatiquement du siège saisi à la création
  (`admin/admin.html`), modifiable si besoin. Pas de clé opaque.
- **Héritage de key** : chaque membre (secrétaire, trésorier, agent) hérite
  automatiquement de la `forageKey` de son président à sa création. À la
  connexion, cette key indique la « direction » / le forage de l'utilisateur.
- **Un utilisateur = un forage** (pas de multi-appartenance, hors super-admin).

### Structure de données cible

```
Asufor/
   ├── Asufor_diandioly/
   │       ├── config     = { nom, siege, ... }   ← branding du forage
   │       ├── compteurs  (ex-asufor_db_diandioly, une fois migré)
   │       ├── backup     (ex-asufor_backup)
   │       ├── agents     (ex-db_agents)
   │       ├── depenses   (ex-asufor_depenses)
   │       └── team       ← miroir léger de users/{uid}, pour que le président liste son équipe
   ├── Asufor_ogo/        ← même schéma, sous-noeuds génériques et identiques pour CHAQUE village
   └── Asufor_orka/
users/{uid} = { role, forageKey, nom, actif }   ← identité → forage
```

Les sous-noeuds (`config`, `compteurs`, `backup`, `agents`, `depenses`, `team`)
sont **strictement identiques d'un village à l'autre** : ajouter un village
ne demande aucun changement de code, juste une nouvelle `Asufor_<village>`.

Le super-admin est reconnu par son e-mail (constante `SUPERADMIN_EMAIL`) ; on
pourra ajouter un noeud `superadmins/{uid}: true` si plusieurs super-admins sont
nécessaires.

### Résolution au login (cible, phase 3)

1. L'utilisateur s'authentifie (Firebase Auth).
2. On lit `users/{auth.uid}` → `{ role, forageKey }`.
3. `forageKey` + `role` sont écrits dans la session locale (`asufor_session`).
4. Toutes les pages construisent leurs chemins via `ForageContext.paths()`.
5. Le super-admin obtient en plus un **sélecteur de forage**.

---

## 2. Provisioning (sans Cloud Function)

La création de comptes se fait **côté client** via une **instance Firebase
secondaire** (`initializeApp(config, 'admin')`) : le créateur reste connecté à sa
propre session pendant qu'il crée le compte d'un tiers.

- Le **super-admin** crée un **président** → dérive sa `forageKey` du siège
  saisi (`Asufor_<village>`), écrit `users/{uid}` et initialise
  `Asufor/{forageKey}/config`.
- Le **président** (ou le super-admin) crée son **équipe** → `users/{uid}` avec la
  `forageKey` du président (héritage).

> Aucune Cloud Function n'est requise. Une migration ultérieure vers des
> *custom claims* reste possible sans changer les écrans.

---

## 3. Découpage en phases (une PR par phase, app fonctionnelle à chaque étape)

| Phase | Contenu | État |
|-------|---------|------|
| **1. Fondations** | `forage-context.js` (résolution key + construction des chemins, mode LEGACY) ; `billing.js` déparamétré (`backupPath`) ; tests ; ce document. **Aucun changement de comportement.** | ✅ PR #4 |
| **2. Adoption** | Toutes les pages consomment `ForageContext.paths()` au lieu des chemins en dur (toujours en LEGACY → comportement identique). **Aucun changement de comportement.** | ✅ cette PR |
| **3a. Règles & modèle** | Règles de sécurité généralisées `Asufor/{forageKey}` + `users/{uid}` + super-admin ; ce document. | ✅ PR #7 |
| **3b. Identité & écrans admin** | Login résout `role`/`forageKey` depuis `users/{uid}` (onglet « Identifiant » en plus du sélecteur de rôle legacy) ; écran super-admin `admin/admin.html` ; écran président `equipe/equipe.html` via instance Firebase secondaire (`provisioning.js`). | ✅ PR #11 |
| **3c. Isolation multi-forage** | **Correctif critique** : `LEGACY` ne s'applique désormais qu'au forage `Asufor_diandioly` — tout autre forage utilise `Asufor/{key}/…` dès sa création, jamais les chemins historiques. Identifiant = numéro de téléphone (sans indicatif) pour président/secrétaire/trésorier. | ✅ cette PR |
| **3d. Racine `Asufor/` par village** | **Changement de paradigme** (décision explicite de l'utilisateur) : la racine namespacée passe de `forages/{forageKey}` à `Asufor/{forageKey}`, avec `forageKey` au format lisible `Asufor_<village>` dérivé du siège (plus de clé opaque générée). Sous-noeuds génériques et identiques pour chaque village (`config`, `compteurs`, `backup`, `agents`, `depenses`, `team`). ⚠️ Nécessite un redéploiement des règles Firebase (§8). | ✅ cette PR |
| **4. Migration** | Script `scripts/migrate-multi-forage.js` (**dry-run** par défaut, copie non-destructive) ; bascule `ForageContext.LEGACY = false` **après vérification manuelle**, pour Diandioly uniquement (les autres forages n'en ont pas besoin, cf. 3c). | ✅ données migrées, vérifiées en console Firebase, `LEGACY = false` |
| **5. Retrait du login legacy** | Code prêt (onglet « Compte du forage » + sélecteur de rôle supprimés d'`index.html`, seul « Identifiant » subsiste). **⚠️ Ne pas déployer avant que le président/secrétaire/trésorier de Diandioly aient chacun un compte individuel** (téléphone + PIN) créé via `equipe/equipe.html`, sans quoi ils perdent tout accès (cf. §8). | ⚙️ code prêt — déploiement conditionné |

### Bascule LEGACY (précision post-bug isolation)

`forage-context.js` expose `LEGACY`, applicable **uniquement au forage
`Asufor_diandioly`** (voir `paths()`) — c'était le seul dont les données
réelles vivaient encore aux chemins historiques. Tout autre forage (Ogo,
etc.) utilise `Asufor/{key}/…` dès sa création, quel que soit l'état de
`LEGACY` — sinon ses données se mélangent avec celles de Diandioly (bug
constaté et corrigé dans une PR précédente). Les données de Diandioly ont
depuis été migrées et vérifiées (§7) : `LEGACY = false` est désormais commité.
`asufor_db_diandioly` a été retiré (règle supprimée, noeud à supprimer
manuellement en base) ; les autres nœuds legacy (`db_agents`, `asufor_backup`,
`asufor_depenses`) restent en base jusqu'à l'étape 6 du runbook (retrait
manuel, après période de validation en production) ; `legacyPaths()` reste
disponible via `paths(key, { legacy: true })` en attendant.

---

## 4. Connexion (Option A retenue) — identifiant + code PIN

Chaque utilisateur a un **compte individuel**. Firebase Auth reste en
**e-mail + mot de passe** sous le capot. Seul login désormais dans `index.html`
(le sélecteur de rôle legacy et son onglet ont été retirés — §3 phase 5) :

- L'**identifiant** est le **numéro de téléphone sans indicatif** (7-15
  chiffres) de la personne — président, secrétaire, trésorier — mappé vers un
  **e-mail interne synthétisé** : `{identifiant}@asufor.local`.
- Le **PIN** (6 chiffres) sert de **mot de passe**.
- Connexion : `signInWithEmailAndPassword('{identifiant}@asufor.local', pin)`.
- Après connexion : on lit `users/{auth.uid}` → `{ role, forageKey }`, qu'on écrit
  dans la session locale (`asufor_session`) pour que `ForageContext` résolve les
  chemins du bon forage.

> L'identifiant doit être **unique globalement** (tous forages confondus), puisque
> l'e-mail synthétisé l'est. Il est attribué à la création du compte. L'unicité
> est garantie gratuitement par Firebase Auth (`auth/email-already-in-use`),
> aucune vérification côté base n'est nécessaire.

> **Super-admin** : un identifiant contenant déjà un « @ » est utilisé tel quel
> (non synthétisé) — c'est ainsi que `prozizou298@gmail.com` reste reconnu par
> les règles (`auth.token.email == '...'`) tout en passant par le même onglet
> « Identifiant » que les autres comptes. Conséquence pratique : le mot de passe
> Firebase Auth du compte super-admin doit être un **PIN à 6 chiffres**, comme
> tous les autres comptes (contrainte du clavier de connexion).

## 5. Provisioning — via instance Firebase secondaire (implémenté : `provisioning.js`)

`provisioning.js` (module partagé, SDK modulaire) expose `createAccount(...)` :
crée le compte Auth via une instance secondaire jetable (`initializeApp(config,
'provisioning-'+Date.now())`, supprimée après usage), puis écrit `users/{uid}`
**et** un miroir `Asufor/{forageKey}/team/{uid} = { role, nom, login }` via la
base primaire (session du créateur). Ce miroir est nécessaire car les règles
n'autorisent le listing du noeud `users` entier qu'au super-admin ; un président
liste donc son équipe via `Asufor/{sonForageKey}/team`, couvert par le `.read`
déjà accordé aux membres du forage.

- **Super-admin** (`prozizou298@gmail.com`) crée un **président** via
  `admin/admin.html` :
  1. dérive une `forageKey` (`Asufor_<village>`) depuis le siège saisi
     (`slugify` côté client), modifiable avant validation, vérifiée unique ;
  2. `createAccount({ role:'président', forageKey, ... })` (compte Auth + `users/{uid}` + `team/{uid}`) ;
  3. initialise `Asufor/{forageKey}/config` (nom, siège).
- **Président** (ou le super-admin, avec sélecteur de forage) crée son **équipe**
  (secrétaire, trésorier) via `equipe/equipe.html` : même `createAccount(...)`,
  avec **sa** `forageKey` (héritage) et un rôle ≠ président/superadmin.

## 6. Runbook de déploiement (ordre impératif)

La Phase 3 est un **basculement**, à exécuter dans cet ordre :

1. **Déployer les règles** de cette PR (`firebase deploy --only database`) — elles
   sont **additives** : la connexion actuelle (comptes partagés + noeuds legacy)
   continue de fonctionner. ⚠️ **À refaire même si déjà fait avant** : le noeud
   `forages` a été renommé `Asufor` (§3 phase 3d, §8) — sans ce redéploiement,
   aucune règle ne couvre `Asufor/…`.
2. **Créer le compte super-admin** (`prozizou298@gmail.com`) dans Firebase Auth,
   avec un **mot de passe à 6 chiffres** (voir §4). Se connecter via l'onglet
   « Identifiant » de `index.html` en saisissant l'adresse complète.
3. **Provisionner** le forage Diandioly avec la clé **`Asufor_diandioly`**
   (déjà la valeur de `ForageContext.DEFAULT_FORAGE_KEY`, donc zéro changement
   de code) : dans `admin/admin.html`, saisir « Diandioly » dans le champ
   Siège — la clé s'auto-remplit en `Asufor_diandioly` (vérifier qu'elle
   correspond avant de valider). Pour les **comptes legacy existants**
   (`president@diandioly.com`…), écrire manuellement `users/{uid} = { role,
   forageKey:'Asufor_diandioly', login, nom }` dans la console Firebase pour
   chacun des 3 UID (ils continuent de fonctionner sans cette fiche, voir §8).
4. **Migrer les données** legacy → `Asufor/Asufor_diandioly/…` (Phase 4, `npm run
   forage-dry-run -- --forage-key Asufor_diandioly` puis `forage-apply`) puis passer
   `ForageContext.LEGACY = false`. (Optionnel avant l'étape 5 — voir §3 phase 5,
   le retrait du login legacy n'exige PAS que les données soient déjà migrées.)
5. **Déployer le retrait du login legacy** (code déjà prêt, §3 phase 5) : **au
   préalable**, vérifier que `users/{uid}` existe pour les 3 comptes partagés
   Diandioly (étape 3 ci-dessus) — sans ça, `president@diandioly.com` etc. ne
   pourront plus se connecter du tout une fois le sélecteur de rôle retiré.
   Une fois vérifié : merger/déployer `index.html`. Les 3 comptes partagés
   continuent de fonctionner en tapant leur e-mail complet dans le champ
   Identifiant (reconnu grâce au « @ ») ; à terme, les remplacer par des
   comptes individuels (téléphone + PIN) via `equipe/equipe.html`.
6. Une fois validé, **retirer** les noeuds/règles legacy et les comptes partagés.

> ⚠️ Les règles de sécurité **n'ont pas pu être testées dans ce dépôt** (pas
> d'accès Firebase). **Valider chaque cas ci-dessous dans le simulateur de règles**
> (Firebase Console → Realtime Database → Règles → Simulateur) avant l'étape 3.

### Cas de test à valider (simulateur de règles)

| Auth | Opération | Attendu |
|------|-----------|---------|
| non authentifié | lire `Asufor/K/compteurs` | **refusé** |
| `users/U.forageKey=K`, role=secrétaire | lire `Asufor/K/compteurs` | autorisé |
| membre de `K` | lire `Asufor/AUTRE/compteurs` | **refusé** |
| président de `K` | créer `Asufor/K/compteurs/x` | autorisé |
| trésorier de `K` | créer `Asufor/K/compteurs/x` (nouveau) | **refusé** |
| trésorier de `K` | mettre à jour `Asufor/K/compteurs/x` (paiement) | autorisé |
| trésorier de `K` | écrire `Asufor/K/backup/...` | **refusé** |
| président de `K` | écrire `Asufor/K/backup/2026-07` | autorisé |
| trésorier de `K` | écrire `Asufor/K/depenses/2026-07/d1` | autorisé |
| président de `K` | écrire `users/newUid` avec `forageKey=K, role=agent` | autorisé |
| président de `K` | écrire `users/x` avec `forageKey=AUTRE` | **refusé** |
| président de `K` | écrire `users/x` avec `role=président` | **refusé** |
| `prozizou298@gmail.com` | lire/écrire n'importe quel `Asufor/*` et `users/*` | autorisé |
| utilisateur lambda | lire `users/autreUid` | **refusé** |
| `prozizou298@gmail.com` | lire le noeud entier `users` (listing) | autorisé |
| `prozizou298@gmail.com` | lire le noeud entier `Asufor` (listing) | autorisé |
| président de `K` | lire le noeud entier `users` (listing) | **refusé** |
| président de `K` | lire `Asufor/K/team` | autorisé |
| président de `K` | écrire `Asufor/K/team/newUid` | autorisé |
| président de `K` | écrire `Asufor/AUTRE/team/newUid` | **refusé** |
| trésorier de `K` | écrire `Asufor/K/team/newUid` | **refusé** |

---

## 7. Script de migration (Phase 4) — `scripts/migrate-multi-forage.js`

Copie les 4 noeuds legacy vers `Asufor/{forageKey}/…`, **sans rien supprimer**
(la suppression des noeuds legacy reste l'étape 6, manuelle, du runbook). Suit
exactement le pattern de `scripts/migrate-arrears.js` : dry-run par défaut,
mode fichiers JSON pour tester sans risque, mode Firebase Admin SDK avec
`--apply` pour l'écriture réelle.

### Étape 1 — Simulation (aucune écriture, 100 % sûr)

Exportez les 4 noeuds legacy en JSON (console Firebase → icône ⋮ → Exporter),
puis :

```bash
cd scripts
node migrate-multi-forage.js --dry-run \
     --forage-key Asufor_diandioly \
     --agents ./db_agents.json \
     --compteurs ./asufor_db_diandioly.json \
     --backup ./asufor_backup.json \
     --depenses ./asufor_depenses.json

# ou, via le raccourci npm (scripts/package.json) :
npm run forage-dry-run -- --forage-key Asufor_diandioly
```

> `asufor_depenses` n'existe pas encore en production (confirmé sur un export
> réel) : créez un fichier vide `echo '{}' > asufor_depenses.json` pour le mode
> fichier — le mode Firebase (`--service-account`) gère l'absence tout seul.

**Clé retenue pour ce village : `Asufor_diandioly`** — déjà la valeur de
`ForageContext.DEFAULT_FORAGE_KEY` (zéro changement de code), auto-dérivée en
saisissant « Diandioly » comme siège dans `admin/admin.html` (runbook étape 3).
Le rapport du script affiche le nombre d'entrées par noeud, sans rien écrire.

### Étape 2 — Application réelle

```bash
npm install            # firebase-admin (scripts/package.json)
node migrate-multi-forage.js --apply \
     --forage-key Asufor_diandioly \
     --service-account ./serviceAccountKey.json \
     --db-url https://asufor-67a06-default-rtdb.firebaseio.com

# ou : npm run forage-apply -- --forage-key Asufor_diandioly
```

Le script refuse d'écraser un forage déjà peuplé (`Asufor/{key}/compteurs`
non vide) sauf `--force`. Si `Asufor/{key}/config` n'existe pas encore, un
branding minimal (« ASUFOR Diandioly ») est créé automatiquement.

### Étape 3 — Vérification puis bascule

1. Vérifiez dans la console Firebase que `Asufor/{forageKey}/{agents,
   compteurs,backup,depenses}` contient bien les mêmes données que les noeuds
   legacy (comptages, quelques enregistrements au hasard).
2. Testez l'application en pointant temporairement `ForageContext.LEGACY` sur
   `false` en local (jamais en committant directement sur `main` sans test).
3. Une fois confiant : commit `LEGACY = false` dans `forage-context.js`,
   déployez. Toute l'application bascule vers `Asufor/{key}/…` en un seul
   changement (§3 « Bascule LEGACY »).
4. Les noeuds/comptes legacy restent en place jusqu'à l'étape 6 du runbook —
   ne les retirez qu'après une période de validation en production.

### Validé contre un export réel

Le script a été testé (dry-run) contre un export réel de la base ASUFOR
Diandioly : **6 agents, 417 compteurs, 2 cycles d'archives (2026-05, 2026-06),
0 dépense** (le noeud `asufor_depenses` n'existe pas encore en production — le
script gère ce cas, `--depenses` peut pointer vers `{}`). Cet export a aussi
révélé deux écarts entre les données réelles et les règles Firebase, corrigés
dans cette même PR (voir §8) : `facteur` parfois stocké en string, et un champ
`"agent id"` (avec espace) sur les 6 agents existants.

---

## 8. Points d'attention

- **⚠️ Redéploiement des règles OBLIGATOIRE** : le noeud `forages` a été renommé
  `Asufor` dans `database.rules.json` (§3 phase 3d). Même si les règles avaient
  déjà été déployées avec l'ancien nom, il faut relancer `firebase deploy
  --only database` avec la version à jour — sinon `Asufor/…` sera lu/écrit
  sans aucune règle (refus par défaut, `.read`/`.write` racine à `false`).
- **⚠️ Données de test sous l'ancien noeud `forages/`** : tout forage créé
  AVANT ce changement (ex. le test « Ogo ») vit sous `forages/{ancienneClé}/…`,
  un chemin que l'application ne lit plus. Son compte président (et sa fiche
  `users/{uid}`) pointent vers cette ancienne clé, désormais orpheline.
  **Recommandé** : supprimer ce forage de test et son président, puis le
  recréer via `admin/admin.html` une fois cette PR déployée — il atterrira
  proprement sous `Asufor/Asufor_ogo/…`.
- **billing.js** : `buildPaymentUpdates({ backupPath })` reçoit déjà `P.backup`
  (adopté en Phase 2) ; en mode namespacé ce sera `Asufor/{key}/backup`.
- **Branding** : `Asufor/{key}/config.nom` remplacera les « ASUFOR Diandioly » en
  dur ; repli sur la valeur par défaut si `config` absent.
- **Comptes partagés actuels** (`president@diandioly.com`…) : conservés jusqu'à
  l'étape 6 du runbook, puis retirés.
- **Règles legacy** (`db_agents`, `asufor_backup`, `asufor_depenses`) :
  conservées pour l'instant (étape 6 du runbook restante) ; la règle de
  `asufor_db_diandioly` a été retirée de `database.rules.json` — nécessite un
  `firebase deploy --only database` pour prendre effet, **et** la suppression
  manuelle du noeud lui-même (console Firebase ou Admin SDK, aucun accès
  automatisé depuis ce dépôt).
- **`facteur` en string** : confirmé sur un export réel (281/417 compteurs).
  `.validate` accepte désormais `isNumber() || isString()`, comme `last_index`
  déjà — `billing.js` normalise dans tous les cas via `toInt()`.
- **`"agent id"` (avec espace)** : les 6 agents existants ont ce champ au lieu
  de `agent_id` (confirmé sur le même export). Ajouté explicitement à la liste
  autorisée dans `db_agents.$agentId` pour ne pas bloquer leurs écritures
  futures (`Asufor/{key}/agents` était déjà permissif — `$other:true`).
- **Comptes legacy sans fiche `users/{uid}`** (`president@diandioly.com`…) :
  tant que la phase 5 (retrait du login legacy, §3) n'est pas déployée, la
  connexion via l'onglet « Compte du forage » continue de fonctionner à
  l'identique (repli sur le rôle sélectionné + `forageKey` par défaut
  `'Asufor_diandioly'`). Une fois la phase 5 déployée, cette fiche devient
  **obligatoire** pour eux (plus de repli). Créée manuellement par le
  super-admin à l'étape 3 du runbook (nécessite leurs UID Firebase Auth, non
  disponibles côté client — console Firebase ou Admin SDK).
