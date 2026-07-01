# ASUFOR Admin — Déploiement Vercel

## Corrections de cette version (v4)

1. **Désynchronisation session locale / session Firebase** (cause de l'erreur
   *« Accès Firebase refusé : Session utilisateur non valide »*) :
   - Nouvelle fonction centralisée `window.handleFirebaseSessionLoss()` dans
     `security.js`, qui affiche désormais un **message visible** à
     l'utilisateur et nettoie systématiquement `localStorage['asufor_session']`
     dès que le token Firebase est perdu. Avant : `stats.js` redirigeait
     silencieusement (rien qu'un `console.error`), ce qui donnait l'impression
     d'un bug sans cause apparente.
   - `impression.html` et `reset/zero.html` nettoient maintenant aussi
     `asufor_session` quand Firebase signale une perte de session, pour rester
     cohérents avec le reste de l'app.

2. **`firebase-config.js`** — `messagingSenderId` et `appId` toujours vides.
   ⚠️ **Action manuelle requise** : va dans *Firebase Console → Paramètres du
   projet → Tes applications* et copie ces deux valeurs.

3. ⚠️ **Action manuelle requise (Firebase Console)** : ajoute
   `admin-forage.vercel.app` dans *Authentication → Settings → Authorized
   domains*. Sans ça, Chrome affichera toujours le warning "domain not
   authorized for OAuth operations" (sans impact sur le login email/password
   actuel, mais bloquant si tu ajoutes un jour Google Sign-In).

## Corrections des versions précédentes

1. **`pwa.js`** — Enregistrement du Service Worker en chemin **absolu** `/sw.js`.
   L'ancien code cherchait un segment `admin` dans l'URL ; absent sur Vercel
   (la racine du site = le dossier `admin/`), il cherchait `sw.js` dans le
   mauvais dossier → `/reset/sw.js` → **404**. Corrigé.

2. **Toutes les pages + `manifest.json`** — Ressources racine en chemins
   **absolus** (`/firebase-config.js`, `/security.js`, `/pwa.js`,
   `/manifest.json`, icônes). Plus robuste que `../` (insensible au slash
   final et à la profondeur du dossier).

3. **`reset/zero.html`** — Clôture : `new_index = ""` (le champ est vidé pour
   préparer la relève du mois suivant ; `last_index` conserve le relevé final).

4. **`vercel.json`** — Indique à Vercel que c'est un site statique (pas de build).

5. **`sw.js`** — Version bumpée v8 → v9 pour forcer l'activation propre et
   purger l'ancien cache.

## Limites connues (non corrigées dans cette passe)

- **Verrou anti-brute-force côté client uniquement** (`sessionStorage`) :
  contournable en navigation privée ou en vidant le storage. Une vraie
  protection nécessiterait une Cloud Function ou Firebase App Check.
- **Comptes Firebase partagés par rôle** (`secretaire@diandioly.com`, etc.) :
  pas de traçabilité individuelle de qui a fait quelle action. Migrer vers
  un compte par agent + custom claims (`role`, `agent_id`) si la traçabilité
  devient importante.

## Déployer

```bash
# Option CLI
npm i -g vercel
vercel --prod

# Ou : https://vercel.com/new → drag & drop ce dossier
```

> ⚠️ La racine du déploiement Vercel doit être CE dossier (où se trouvent
> `index.html`, `firebase-config.js`, `sw.js`). Les chemins absolus en dépendent.

## Vérifier après déploiement (F12 → Console)

- ✅ `[PWA] Service Worker enregistré : https://<ton-site>/`
- ✅ `[SW] Installation v9`
- ❌ Plus aucune erreur `404` ni `Firebase: Need to provide api options`

Si un 404 persiste sur `firebase-config.js` : ouvre directement
`https://<ton-site>/firebase-config.js` — s'il renvoie 404, le fichier n'a pas
été déployé (vérifie qu'il est bien à la racine du projet poussé).

