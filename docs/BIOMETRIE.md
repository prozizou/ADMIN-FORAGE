# Verrouillage biométrique

## Pourquoi
La session Firebase reste ouverte tant qu'on ne se déconnecte pas : sans verrou, quiconque prend le
téléphone entre directement dans l'application. Le verrou demande l'empreinte digitale, le visage ou le
verrouillage d'écran de l'appareil (WebAuthn, authentificateur « plateforme »).

## Utilisation
- **Activation** : proposée à la première ouverture de l'accueil (« Activer / Plus tard / Ne plus demander »)
  ou depuis **Accueil → Verrouillage biométrique**. Une vérification de contrôle est exigée avant de garder l'activation.
- **Verrouillage** : à l'ouverture de l'application et au retour après plus de **60 s** d'absence. L'invite
  biométrique s'affiche seule ; sinon bouton **Déverrouiller**. **Se déconnecter** (puis PIN) reste la solution de secours.
- **Désactivation** : même ligne de l'accueil, après une vérification biométrique réussie.
- Se connecter par PIN ne redemande pas la biométrie tout de suite ; naviguer entre les pages non plus.

## Fonctionnement (`biometric.js`)
- L'appareil crée un identifiant WebAuthn (`userVerification: required`) ; seule la **clé publique** est gardée
  (`localStorage: asufor_bio_v1`). Aucun secret, rien n'est envoyé à un serveur.
- Chaque déverrouillage signe un challenge aléatoire ; la signature est **vérifiée localement** : challenge, origine,
  rpId, drapeaux présence + utilisateur vérifié, signature (ES256 / RS256).
- Les pages protégées appellent le verrou via `checkAccess()` (`security.js`) : la page reste masquée et inerte derrière l'écran de verrouillage.
- L'enregistrement est lié au compte (e-mail de session) : un autre compte sur le même appareil l'efface ; « Réinitialiser l'application » aussi.

## Prérequis / limites
- HTTPS, Chrome 70+ (ou l'APK, qui s'appuie sur Chrome) et un **verrouillage d'écran / biométrie configuré** sur l'appareil.
  Sinon la ligne de réglage et la proposition n'apparaissent pas (Android 5-6 : généralement non disponible).
- C'est un verrou d'application côté appareil contre un accès ordinaire au téléphone. Il ne remplace pas l'authentification
  Firebase (PIN) et ne protège pas contre quelqu'un qui contrôle le navigateur (débogage à distance).
- Le verrou ne change pas les droits : rôles et règles Firebase restent inchangés.

## Tests
- `node scripts/biometric.test.js` — vérification d'assertion (16 tests : chaque falsification est refusée).
- `scripts/smoke` — Chromium + authentificateur virtuel WebAuthn : activation, verrouillage, refus, falsification de clé,
  désactivation, autre compte, appareil sans biométrie, page Statistiques verrouillée.
