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
| **1. Fondations** | `forage-context.js` (résolution key + construction des chemins, mode LEGACY) ; `billing.js` déparamétré (`backupPath`) ; tests ; ce document. **Aucun changement de comportement.** | ✅ cette PR |
| **2. Adoption + règles** | Les pages consomment `ForageContext.paths()` (toujours en LEGACY) ; règles de sécurité généralisées `forages/{forageKey}` + `users/{uid}` + super-admin. | à venir |
| **3. Identité & écrans admin** | Login résout la `forageKey` depuis `users/{uid}` ; écran super-admin (créer/lister forages & présidents) ; écran président (créer son équipe) via instance secondaire. | à venir |
| **4. Migration** | Bascule `ForageContext.LEGACY = false` ; script **dry-run** puis migration des données Diandioly vers `forages/{keyDiandioly}/…`. | à venir |

### Bascule LEGACY

`forage-context.js` expose `LEGACY = true` en phase 1–3 : les chemins renvoyés
restent les chemins historiques, donc **rien ne casse**. La phase 4 passe
`LEGACY` à `false` **après** avoir migré les données, ce qui fait basculer toute
l'application vers `forages/{key}/…` en une seule modification.

---

## 4. Décision en attente

**Mécanique de connexion** (à trancher en phase 3) : conserver l'esprit **code
PIN mais par utilisateur** (identifiant + code), ou passer à **e-mail + mot de
passe** classique. Le modèle de données ci-dessus est compatible avec les deux.

---

## 5. Points d'attention

- **billing.js** : `buildPaymentUpdates({ backupPath })` doit recevoir le chemin
  d'archives du forage courant une fois en mode namespacé (défaut rétro-compatible
  `asufor_backup`).
- **Branding** : `forages/{key}/config.nom` remplacera les « ASUFOR Diandioly » en
  dur ; repli sur la valeur par défaut si `config` absent.
- **Comptes partagés actuels** (`president@diandioly.com`…) : conservés en phase
  1–2 ; la migration vers des comptes rattachés à `users/{uid}` se fait en phase 3.
