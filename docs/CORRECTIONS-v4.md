# Corrections de Sécurité v4 — ADMIN-FORAGE

Ce document détaille toutes les corrections appliquées suite à l'audit de sécurité du projet ADMIN-FORAGE.

## 1. Fichier `.gitignore`

**Problème** : Le dépôt ne contenait pas de `.gitignore`, risquant la publication accidentelle de secrets (clé de service Firebase, fichiers `.env`).

**Correction** : Fichier `.gitignore` créé à la racine du projet, excluant systématiquement :
- `node_modules/`
- `scripts/serviceAccountKey.json`
- `.env` et `.env.local`
- Fichiers de build et logs
- Fichiers éditeur (`.vscode/`, `.idea/`)

## 2. Hachage des passcodes agents (SHA-256)

**Problème** : Les passcodes des agents (6 chiffres) étaient stockés en texte clair dans Firebase (`agents/{uid}/passcode`). En cas de fuite de données, tous les passcodes seraient immédiatement exposés.

**Correction** : Nouveau module `crypto.js` fournissant :
- `hashAgentPasscode(passcode)` — hache le passcode avec un sel dédié avant stockage
- `verifyAgentPasscode(input, storedHash)` — compare les hashs lors de la vérification terrain
- Le champ `passcode` est remplacé par `passcode_hash` dans la base de données

**Fichiers modifiés** : `crypto.js` (nouveau), `agents/agent.html`

## 3. Numérotation atomique des compteurs

**Problème** : Le numéro de compteur était généré par `count + 1` (comptage des entrées existantes). Cette méthode est sujette aux collisions en cas d'écritures concurrentes.

**Correction** : Utilisation d'une transaction Firebase (`runTransaction`) sur le chemin `Asufor/{forageKey}/config/next_counter_number`. La transaction garantit qu'aucune collision ne peut survenir.

**Fichiers modifiés** : `counter/list.html`

## 4. Passcode de maintenance sécurisé

**Problème** : Le passcode de clôture mensuelle (`zero.html`) était prévisible (format `AAAAMM`). La vérification s'effectuait côté client, permettant un contournement facile.

**Correction** : 
- Remplacement par un passcode aléatoire de 8 caractères (sans les ambigus 0, O, 1, I)
- Stockage hashé dans Firebase (`Asufor/{key}/config/maintenance_passcode_hash`)
- Vérification par comparaison de hashs SHA-256
- Bouton de génération accessible uniquement au président
- Le passcode en clair n'est affiché qu'une seule fois lors de la génération

**Fichiers modifiés** : `crypto.js` (nouveau), `reset/zero.html`

## 5. Anti-brute-force amélioré

**Problème** : Le verrouillage anti-brute-force utilisait `sessionStorage` (vidé en mode privé/incognito) avec une durée fixe de 30 secondes.

**Correction** :
- Migration vers `localStorage` (persistant entre les sessions)
- Durée de verrouillage progressive : 30s → 2min → 10min → 1h
- Historique des tentatives conservé sur 24 heures
- Clé unique par identifiant

**Fichiers modifiés** : `index.html`

## 6. Persistance des modifications d'arriérés

**Problème** : Les modifications manuelles des arriérés (page d'impression) n'étaient pas sauvegardées dans Firebase. Seules les modifications locales étaient conservées en mémoire, créant un risque de divergence.

**Correction** :
- Sauvegarde automatique dans la base de données (`update()` Firebase)
- Historisation dans un journal d'audit multi-forage (`Asufor/{key}/audit_arrieres`)
- Traçabilité : qui a modifié, quand, ancienne valeur, nouvelle valeur

**Fichiers modifiés** : `impression/impression.html`

## 7. Tests d'intégration

**Problème** : Seule la logique de facturation (`billing.test.js`) disposait de tests.

**Correction** : Ajout de deux nouvelles suites de tests :
- `scripts/crypto.test.js` — 9 tests pour le module cryptographique
- `scripts/integration.test.js` — 11 tests pour les validations métier et la logique de transaction

**Fichiers ajoutés** : `scripts/crypto.test.js`, `scripts/integration.test.js`

## 8. Workflow CI amélioré

**Problème** : Le CI ne vérifiait que les tests unitaires de `billing.js`.

**Correction** : Le workflow CI (`ci.yml`) inclut désormais 4 jobs :
1. **Vérification des secrets** — présence du `.gitignore`, absence de clés sensibles
2. **Tests** — tous les tests unitaires et d'intégration
3. **Validation HTML** — vérification des balises ouvertes/fermées, charset
4. **Structure multi-forage** — présence des fichiers critiques et inclusion de `crypto.js`

## 9. Rétrocompatibilité

Les corrections maintiennent la rétrocompatibilité avec les données existantes :
- Les agents créés avant v4 conservent leur champ `passcode` en clair. Les nouveaux agents utilisent `passcode_hash`. La vérification terrain devra être adaptée pour gérer les deux formats (fallback sur comparaison en clair si `passcode_hash` absent).
- Le champ `next_counter_number` sera initialisé automatiquement à la prochaine création de compteur (valeur nulle/undefined → 1).
- Le passcode de maintenance doit être généré manuellement au moins une fois par le président avant la première clôture post-migration.

## Migration recommandée

1. **Générer un passcode de maintenance** : Connectez-vous en tant que président, accédez à `reset/zero.html`, et cliquez sur « Générer un nouveau passcode ». Copiez-le immédiatement.
2. **Vérifier les règles Firebase** : Assurez-vous que les règles `database.rules.json` autorisent l'écriture dans `Asufor/{forageKey}/config/next_counter_number` et `Asufor/{forageKey}/audit_arrieres`.
3. **Initialiser le compteur de numérotation** : Exécutez une transaction initiale pour positionner `next_counter_number` au nombre actuel de compteurs + 1.
