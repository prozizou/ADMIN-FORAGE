# Multi-forage — Architecture & plan de déploiement

Ce document décrit le passage d'ASUFOR d'un déploiement **mono-forage**
(Diandioly, chemins en dur) à un système **multi-forage** hébergeant plusieurs
ASUFOR sur la même base Firebase.

---

## 1. Modèle

- **Super-admin** : `prozizou298@gmail.com`. Accès à **tous** les forages
  (lecture/écriture), gestion des présidents.
- **Forage** = un président + son équipe. Identifié par une **`forageKey`**
  unique, générée par le système et **invisible du président**.
- **Héritage de key** : chaque membre (secrétaire, trésorier, agent) hérite
  automatiquement de la `forageKey` de son président à sa création. À la
  connexion, cette key indique la « direction » / le forage de l'utilisateur.
- **Un utilisateur = un forage** (pas de multi-appartenance, hors super-admin).

### Structure de données cible

```
users/{uid}            = { role, forageKey, nom, actif }   ← identité → forage
forages/{forageKey}/
   ├── config     = { nom, siege, ... }                    ← branding par forage
   ├── compteurs  (ex-asufor_db_diandioly)
   ├── backup     (ex-asufor_backup)
   ├── agents     (ex-db_agents)
   └── depenses   (ex-asufor_depenses)
```

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

- Le **super-admin** crée un **président** → génère sa `forageKey`, écrit
  `users/{uid}` et initialise `forages/{forageKey}/config`.
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
| **3. Identité & règles & écrans admin** | Login résout la `forageKey` depuis `users/{uid}` ; règles de sécurité généralisées `forages/{forageKey}` + `users/{uid}` + super-admin ; écran super-admin (créer/lister forages & présidents) ; écran président (créer son équipe) via instance secondaire. *(Règles et identité sont couplées → traitées ensemble.)* | à venir |
| **4. Migration** | Bascule `ForageContext.LEGACY = false` ; script **dry-run** puis migration des données Diandioly vers `forages/{keyDiandioly}/…`. | à venir |

### Bascule LEGACY

`forage-context.js` expose `LEGACY = true` en phase 1–3 : les chemins renvoyés
restent les chemins historiques, donc **rien ne casse**. La phase 4 passe
`LEGACY` à `false` **après** avoir migré les données, ce qui fait basculer toute
l'application vers `forages/{key}/…` en une seule modification.

---

## 4. Connexion (Option A retenue) — identifiant + code PIN

Chaque utilisateur a un **compte individuel**. Firebase Auth reste en
**e-mail + mot de passe** sous le capot :

- L'**identifiant** saisi (ex. nom d'utilisateur, ou téléphone) est mappé vers un
  **e-mail interne synthétisé** : `{identifiant}@asufor.local`.
- Le **PIN** (6 chiffres) sert de **mot de passe**.
- Connexion : `signInWithEmailAndPassword('{identifiant}@asufor.local', pin)`.
- Après connexion : on lit `users/{auth.uid}` → `{ role, forageKey }`, qu'on écrit
  dans la session locale (`asufor_session`) pour que `ForageContext` résolve les
  chemins du bon forage.

> L'identifiant doit être **unique globalement** (tous forages confondus), puisque
> l'e-mail synthétisé l'est. Il est attribué à la création du compte.

## 5. Provisioning (rappel) — via instance Firebase secondaire

- **Super-admin** (`prozizou298@gmail.com`) crée un **président** :
  1. génère une `forageKey` (ex. `push().key`) ;
  2. crée le compte Auth du président (instance secondaire, sans perdre sa session) ;
  3. écrit `users/{uidPrésident} = { role:'président', forageKey, login, nom }` ;
  4. initialise `forages/{forageKey}/config`.
- **Président** crée son **équipe** (secrétaire, trésorier, agents) : même procédé,
  `users/{uid}` avec **sa** `forageKey` (héritage) et un rôle ≠ président/superadmin.

## 6. Runbook de déploiement (ordre impératif)

La Phase 3 est un **basculement**, à exécuter dans cet ordre :

1. **Déployer les règles** de cette PR (`firebase deploy --only database`) — elles
   sont **additives** : la connexion actuelle (comptes partagés + noeuds legacy)
   continue de fonctionner.
2. **Créer le compte super-admin** (`prozizou298@gmail.com`) dans Firebase Auth.
3. **Provisionner** le forage Diandioly : une `forageKey`, un compte président, son
   équipe, et `forages/{key}/config`.
4. **Migrer les données** legacy → `forages/{keyDiandioly}/…` (Phase 4, script
   dry-run d'abord) puis passer `ForageContext.LEGACY = false`.
5. **Basculer la page de connexion** vers l'Option A (identifiant + PIN).
6. Une fois validé, **retirer** les noeuds/règles legacy et les comptes partagés.

> ⚠️ Les règles de sécurité **n'ont pas pu être testées dans ce dépôt** (pas
> d'accès Firebase). **Valider chaque cas ci-dessous dans le simulateur de règles**
> (Firebase Console → Realtime Database → Règles → Simulateur) avant l'étape 3.

### Cas de test à valider (simulateur de règles)

| Auth | Opération | Attendu |
|------|-----------|---------|
| non authentifié | lire `forages/K/compteurs` | **refusé** |
| `users/U.forageKey=K`, role=secrétaire | lire `forages/K/compteurs` | autorisé |
| membre de `K` | lire `forages/AUTRE/compteurs` | **refusé** |
| président de `K` | créer `forages/K/compteurs/x` | autorisé |
| trésorier de `K` | créer `forages/K/compteurs/x` (nouveau) | **refusé** |
| trésorier de `K` | mettre à jour `forages/K/compteurs/x` (paiement) | autorisé |
| trésorier de `K` | écrire `forages/K/backup/...` | **refusé** |
| président de `K` | écrire `forages/K/backup/2026-07` | autorisé |
| trésorier de `K` | écrire `forages/K/depenses/2026-07/d1` | autorisé |
| président de `K` | écrire `users/newUid` avec `forageKey=K, role=agent` | autorisé |
| président de `K` | écrire `users/x` avec `forageKey=AUTRE` | **refusé** |
| président de `K` | écrire `users/x` avec `role=président` | **refusé** |
| `prozizou298@gmail.com` | lire/écrire n'importe quel `forages/*` et `users/*` | autorisé |
| utilisateur lambda | lire `users/autreUid` | **refusé** |

---

## 7. Points d'attention

- **billing.js** : `buildPaymentUpdates({ backupPath })` reçoit déjà `P.backup`
  (adopté en Phase 2) ; en mode namespacé ce sera `forages/{key}/backup`.
- **Branding** : `forages/{key}/config.nom` remplacera les « ASUFOR Diandioly » en
  dur ; repli sur la valeur par défaut si `config` absent.
- **Comptes partagés actuels** (`president@diandioly.com`…) : conservés jusqu'à
  l'étape 6 du runbook, puis retirés.
- **Règles legacy** (`db_agents`, `asufor_db_diandioly`, `asufor_backup`,
  `asufor_depenses`) : conservées tant que `LEGACY = true` ; à retirer après la
  migration (Phase 4).

---

## 5. Points d'attention

- **billing.js** : `buildPaymentUpdates({ backupPath })` doit recevoir le chemin
  d'archives du forage courant une fois en mode namespacé (défaut rétro-compatible
  `asufor_backup`).
- **Branding** : `forages/{key}/config.nom` remplacera les « ASUFOR Diandioly » en
  dur ; repli sur la valeur par défaut si `config` absent.
- **Comptes partagés actuels** (`president@diandioly.com`…) : conservés en phase
  1–2 ; la migration vers des comptes rattachés à `users/{uid}` se fait en phase 3.
