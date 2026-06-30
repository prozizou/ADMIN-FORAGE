# ASUFOR Admin — Déploiement Vercel

## Corrections de cette version

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
