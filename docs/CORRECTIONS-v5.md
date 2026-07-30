# Corrections de Sécurité v5 — ADMIN-FORAGE

Ce document décrit les corrections apportées suite au **rapport d'audit v2** (post-corrections v4). Elles traitent les 12 faiblesses résiduelles identifiées, classées par priorité.

---

## 1. Corrections HAUTE priorité

### 1.1 Renforcement du mot de passe Firebase Auth (PIN 6 chiffres)

**Problème.** Le PIN à 6 chiffres était utilisé tel quel comme mot de passe Firebase Auth. L'espace de clés de 10^6 combinaisons rendait possible une attaque par force brute directe sur l'API REST Firebase, en contournant totalement l'anti-brute-force côté client.

**Solution.** Le mot de passe réellement envoyé à Firebase est désormais **dérivé** : `SHA-256('asufor_auth_v5:' + login + ':' + pin)`, soit 64 caractères hexadécimaux. L'utilisateur continue de saisir son PIN à 6 chiffres — aucun changement d'expérience utilisateur.

| Fichier | Modification |
|---------|--------------|
| `provisioning.js` | Nouvelle fonction exportée `derivePassword(login, pin)` ; `createAccount()` utilise le mot de passe dérivé |
| `index.html` | `signInSmart()` : essaie le mot de passe dérivé, puis le PIN brut en fallback (comptes pré-v5) |
| `scripts/migrate-auth-passwords.js` | Script de migration des comptes existants (nécessite un fichier `pins.json` local, jamais commité) |

**Migration des comptes existants :**

```bash
# 1. Créer scripts/pins.json : { "771234567": "123456", ... }
# 2. Prévisualiser
cd scripts && npm run migrate-auth
# 3. Appliquer
npm run migrate-auth-apply
# 4. SUPPRIMER pins.json immédiatement
rm pins.json
```

### 1.2 Content Security Policy et en-têtes de sécurité

**Problème.** Aucun en-tête de sécurité HTTP n'était servi (pas de `vercel.json`).

**Solution.** Création de `vercel.json` avec : CSP (limite les scripts aux origines gstatic/cdnjs/jsdelivr, connexions aux domaines Firebase), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS.

### 1.3 Verrou anti-double-clôture (`reset/zero.html`)

**Problème.** Deux exécutions de `runMaintenance()` pour le même cycle (double clic, second onglet, deuxième président) écrasaient le backup existant puis réinitialisaient une seconde fois les compteurs — perte de données irréversible.

**Solution.** Avant toute écriture, la clôture vérifie si `backup/{cycleKey}/info` existe déjà. Si oui, l'opération est **refusée** avec un message explicite indiquant la date de l'archivage existant.

### 1.4 Export automatique des archives (sauvegarde externe)

**Problème.** Firebase était le seul dépositaire de l'historique.

**Solution.** À chaque clôture réussie, un fichier `asufor_archive_{village}_{cycle}.json` est automatiquement téléchargé sur l'appareil (métadonnées + données complètes du cycle). L'échec de l'export ne bloque jamais la clôture elle-même.

---

## 2. Corrections MOYENNE priorité

### 2.1 Générateur aléatoire cryptographique (`crypto.js`)

`generateMaintenancePasscode()` utilise désormais `crypto.getRandomValues()` (CSPRNG, navigateur et Node ≥ 15) au lieu de `Math.random()` (prédictible). Fallback conservé pour les très vieux navigateurs.

### 2.2 Centralisation de l'identité super-admin

**Problème.** L'email super-admin était codé en dur dans de nombreux fichiers.

**Solution.** Nouveau module `admin-config.js` (UMD : navigateur + Node) :

```js
window.ASUFOR_ADMIN.SUPERADMIN_EMAIL     // source unique de vérité
window.ASUFOR_ADMIN.isSuperAdmin(email)  // comparaison insensible à la casse
```

`forage-context.js` résout désormais `SUPERADMIN_EMAIL` depuis ce module (avec fallback). Le script est inclus dans les 10 pages HTML avant `forage-context.js` et pré-caché par le Service Worker.

> **Note.** Les règles Firebase (`database.rules.json`) doivent rester synchronisées manuellement — elles ne peuvent pas importer de module. La cible à terme reste les **Custom Claims** Firebase.

### 2.3 Règles Firebase : `passcode_hash` accepté sur le nœud legacy

Le nœud `db_agents` (legacy) acceptait uniquement `passcode` en clair. La règle `.validate` accepte désormais `passcode` **ou** `passcode_hash` (SHA-256, 64 hex), alignée sur le nœud multi-forage.

### 2.4 Migration des passcodes agents legacy

Nouveau script `scripts/migrate-passcodes.js` : convertit les champs `passcode` (clair) en `passcode_hash` sur `db_agents` et `Asufor/{forageKey}/agents`, puis supprime le champ en clair.

```bash
cd scripts && npm run migrate-passcodes        # dry-run
npm run migrate-passcodes-apply                # application
```

---

## 3. Corrections BASSE priorité

| Correction | Détail |
|-----------|--------|
| `crypto.js` dans le cache SW | Ajouté à `APP_SHELL` (avec `admin-config.js`) ; cache bumpé `v24 → v25` |
| Échappement XSS `impression.html` | Noms d'agents échappés (`window.escHtml`) dans le `<select>` des agents ; construction du HTML en une seule affectation |
| Échappement XSS `reset/zero.html` | `e.message` échappé via `esc()` dans le panneau d'erreur |
| `.gitignore` renforcé | `pins.json`, `serviceAccountKey.json` (racine) ajoutés |

---

## 4. Tests

Nouveau fichier `scripts/v5.test.js` — **21 tests** couvrant : dérivation de mot de passe (déterminisme, unicité, format), CSPRNG, `admin-config`, présence de la CSP, verrou anti-double-clôture, export d'archive, protection `.gitignore`, règles Firebase, scripts de migration.

```bash
cd scripts && npm test    # 63 tests au total (22 billing + 9 crypto + 11 intégration + 21 v5)
```

Le workflow CI (`.github/workflows/ci.yml`) exécute désormais `v5.test.js`.

---

## 5. Actions requises après déploiement

1. **Déployer les règles Firebase** : `firebase deploy --only database`
2. **Migrer les passcodes agents** : `npm run migrate-passcodes` puis `-apply`
3. **Migrer les mots de passe Auth** : créer `pins.json`, `npm run migrate-auth-apply`, supprimer `pins.json`
4. **Vérifier la CSP en production** : ouvrir la console navigateur sur chaque page et corriger toute violation CSP éventuelle (ressource externe non listée)
5. **Informer les présidents** : à la prochaine clôture, un fichier JSON d'archive sera téléchargé automatiquement — le conserver en lieu sûr (clé USB, Drive)

## 6. Faiblesses résiduelles connues (hors périmètre v5)

- **Custom Claims Firebase** : la reconnaissance du super-admin par email reste dupliquée dans les règles ; une Cloud Function posant `auth.token.superadmin` serait plus robuste.
- **Mode hors-ligne de saisie** : la saisie des relevés nécessite toujours une connexion active ; une file d'attente locale (IndexedDB) reste à concevoir.
- **`alert()`/`confirm()`** : les dialogues natifs bloquants restent utilisés ; un système de toasts/modales améliorerait l'UX sans impact sécurité.
- **Comptes pré-v5** : tant que la migration auth n'est pas faite, le fallback PIN brut reste actif dans `index.html` (à retirer après migration complète).
