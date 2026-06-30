/**
 * firebase-config.js — Configuration Firebase centralisée ASUFOR
 *
 * Ce fichier expose la config Firebase comme variable globale.
 * Il doit être chargé AVANT tout script Firebase (compat ou module).
 *
 * ⚠️  Ce fichier est public (côté client). La sécurité des données
 *     repose exclusivement sur les Firebase Security Rules (côté serveur).
 *
 * 🔒 SÉCURITÉ : Ne jamais committer ce fichier avec de vraies clés dans un dépôt public.
 *     Utiliser des variables d'environnement ou un système de secrets en production.
 *     La clé API Firebase est restreinte par domaine dans la console Firebase.
 */
window.ASUFOR_FIREBASE_CONFIG = {
    apiKey:            "AIzaSyAKC7lrKSCFwfuoXASvX-yYIGneLXInvDk",
    authDomain:        "asufor-67a06.firebaseapp.com",
    databaseURL:       "https://asufor-67a06-default-rtdb.firebaseio.com",
    projectId:         "asufor-67a06",
    storageBucket:     "asufor-67a06.appspot.com",   // ✅ CORRECTION : champ manquant
    messagingSenderId: "",                             // ✅ CORRECTION : champ manquant (à renseigner depuis la console Firebase)
    appId:             ""                              // ✅ CORRECTION : champ manquant (à renseigner depuis la console Firebase)
};
