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
 *
 * ⚠️  ACTION REQUISE (v4) : messagingSenderId et appId sont vides ci-dessous.
 *     Va dans Firebase Console → Paramètres du projet → Tes applications,
 *     copie les valeurs exactes et remplace-les ici. L'authentification
 *     email/password fonctionne sans ces champs, mais les laisser vides
 *     peut casser certaines fonctionnalités futures (Analytics, Messaging,
 *     App Check). Vérifie aussi que "admin-forage.vercel.app" est bien
 *     listé dans Authentication → Settings → Authorized domains.
 */
window.ASUFOR_FIREBASE_CONFIG = {
    apiKey:            "AIzaSyAKC7lrKSCFwfuoXASvX-yYIGneLXInvDk",
    authDomain:        "asufor-67a06.firebaseapp.com",
    databaseURL:       "https://asufor-67a06-default-rtdb.firebaseio.com",
    projectId:         "asufor-67a06",
    storageBucket:     "asufor-67a06.appspot.com",
    messagingSenderId: "",                             // ⚠️ À COMPLÉTER depuis la console Firebase
    appId:             ""                              // ⚠️ À COMPLÉTER depuis la console Firebase
};
