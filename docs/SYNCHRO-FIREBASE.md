# Synchronisation Firebase RTDB — robustesse

Objectif : aucune page ne reste en chargement infini, et aucune ne demande de vider le cache ou de recharger la page pour retrouver Firebase (retour d'arrière-plan, réseau coupé puis rétabli, navigation répétée, lecture bloquée). Aucune logique métier ni structure de données modifiée.

## Composants

| Fichier | Rôle |
|---|---|
| `sync.js` (`window.AsuforSync`) | `safeGet` (délai 9 s, 2 nouvelles tentatives, délai croissant ; `PERMISSION_DENIED` jamais retenté), suivi de `/.info/connected`, badge d'état, reprises silencieuses, registre des listeners |
| `loader.js` | Chien de garde : après ~12 s, « Connexion lente » avec Réessayer et Continuer, jamais de spinner infini |
| `compta-ui.js` | Grand livre : états `loading` / `ready` / `degraded` / `error`, nouvelle tentative automatique par nœud, lecture de secours protégée, `retry()` |
| `statistiques/stats.js`, `impression/impression.html`, `counter/list.html`, `compte/releve.html` | Lectures protégées, copie locale affichée tout de suite, listeners sous clé unique |

## Comportement

- **Lecture** : chaque `get()` passe par `safeGet`. En cas d'échec avec une copie locale déjà affichée, la liste est conservée. Les listeners sont rattachés même si la première lecture échoue, donc les données arrivent au retour du réseau.
- **Statut discret** (bas gauche) : *Synchronisé · hh:mm*, *Reconnexion…*, *Hors ligne — données locales*. Toucher le badge relance une synchro.
- **Reprises silencieuses** : `pageshow`, `visibilitychange` (retour au premier plan), `online`, et retour de `/.info/connected`. Elles ne se déclenchent que si les données sont anciennes (> 60 s) ou si la connexion revient ; les déclencheurs simultanés sont fusionnés en une seule reprise. Rien n'est vidé pendant la reprise.
- **Connexion bloquée** : les pages passent `goOffline` et `goOnline` à `init`. Si Firebase reste déconnecté alors que le navigateur indique un réseau disponible et que la page est visible, la connexion est rouverte après 30 s, avec un délai croissant jusqu'à 120 s. Toucher le badge ou « Réessayer » déclenche aussi cette reprise. Le cache et les écritures en attente dans le SDK sont conservés. Une connexion active n'est pas rouverte.
- **État fiable** : un signal `navigator.onLine = false` ne prime pas sur une connexion Firebase active. Le signal navigateur est relu au retour au premier plan. Une lecture du cache pendant que Firebase est déconnecté ne met pas à jour l'heure de dernière synchronisation. Une reprise complète est limitée à 45 s pour qu'un handler bloqué ne neutralise pas les essais suivants.
- **Réponses tardives** : l'état d'une ancienne connexion ne peut plus dégrader celui d'une reconnexion déjà réussie. Les lectures restent rendues à leur appelant ; leurs anciens résultats ne pilotent plus le badge après un changement de connexion.
- **Listeners** : chaque écoute est enregistrée sous une clé (`AsuforSync.track`) ; un nouvel attachement détache d'abord l'ancien (aucun doublon, aucun listener zombie).
- **Grand livre** : si un nœud échoue, l'état passe à `degraded` ou `error` (bandeau + Réessayer dans Statistiques) au lieu de rester en attente. `ready` ne dépend plus d'un seul événement. Les écritures relisent toujours l'état frais.

## Tests

- `node scripts/sync.test.js` : délais, nouvelles tentatives, réponse tardive, détachement, état de connexion, reprises fusionnées.
- `node scripts/sync-recovery.test.js` : signal navigateur périmé, lecture du cache, reprise bloquée, réouverture automatique et manuelle, absence de réouverture d'une connexion saine.
- `CHROMIUM_PATH=/chemin/vers/chromium node scripts/smoke/recovery.test.js` : la vraie page Statistiques passe d'une copie locale ancienne aux données fraîches simulées, automatiquement, via le badge et au retour au premier plan, sans écriture.
- Test navigateur (`scripts/smoke`) : lecture bloquée avec et sans cache, chien de garde, réseau coupé puis rétabli, retour d'arrière-plan, `pageshow` et `online`, navigation répétée sans doublons de listeners, nœud du grand livre en échec, impression hors ligne.
