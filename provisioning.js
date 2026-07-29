/**
 * provisioning.js — Création de comptes ASUFOR (Phase 3)
 * ========================================================
 *
 * Permet à un super-admin ou un président de créer un compte (président,
 * secrétaire, trésorier) SANS perdre sa propre session Firebase : la création
 * du compte Auth passe par une instance Firebase secondaire jetable
 * (voir docs/MULTI-FORAGE.md §2), tandis que l'écriture users/{uid} passe par
 * la base PRIMAIRE (authentifiée en tant que créateur — c'est elle que les
 * règles de sécurité évaluent).
 *
 * Connexion (Option A, voir docs/MULTI-FORAGE.md §4) : l'identifiant est le
 * **numéro de téléphone sans indicatif** (7-15 chiffres) de la personne —
 * président, secrétaire ou trésorier —, mappé vers un e-mail interne
 * `{identifiant}@asufor.local`. Le PIN à 6 chiffres sert de mot de passe
 * Firebase Auth. (Le super-admin, créé à part via la console Firebase, garde
 * son adresse e-mail réelle — voir resolveLoginEmail() et index.html.)
 *
 * SDK modulaire uniquement (cohérent avec agents/agent.html, counter/list.html,
 * reset/zero.html, impression/impression.html, statistiques/stats.js).
 */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const SYNTHETIC_DOMAIN = '@asufor.local';

/**
 * Résout l'identifiant saisi vers l'e-mail Firebase Auth interne.
 * Un identifiant contenant déjà « @ » (ex. l'adresse réelle du super-admin)
 * est utilisé tel quel.
 */
export function resolveLoginEmail(identifiant) {
    const id = String(identifiant || '').trim();
    return id.includes('@') ? id : id + SYNTHETIC_DOMAIN;
}

/**
 * Crée un compte Firebase Auth (identifiant + PIN) via une instance
 * secondaire jetable, puis écrit `users/{uid}` via la base primaire.
 *
 * @param {object} params
 * @param {object} params.firebaseConfig - window.ASUFOR_FIREBASE_CONFIG
 * @param {import('firebase/database').Database} params.db - base PRIMAIRE (session du créateur)
 * @param {string} params.identifiant - numéro de téléphone SANS indicatif (7-15 chiffres) ;
 *        sert d'identifiant unique (sans @asufor.local)
 * @param {string} params.pin - mot de passe / PIN à 6 chiffres
 * @param {'président'|'secrétaire'|'trésorier'} params.role
 * @param {string} params.forageKey
 * @param {string} params.nom - nom complet affiché
 * @param {string} params.createdByUid - uid du créateur (traçabilité)
 * @returns {Promise<string>} l'uid du compte créé
 */
export async function createAccount({ firebaseConfig, db, identifiant, pin, role, forageKey, nom, createdByUid }) {
    // Identifiant = numéro de téléphone sans indicatif (même regex que agent_tel
    // ailleurs dans l'app : agents/agent.html, database.rules.json).
    const login = String(identifiant || '').trim().replace(/[\s\-.]/g, '');
    if (!/^\d{7,15}$/.test(login)) throw new Error("L'identifiant doit être un numéro de téléphone valide (7 à 15 chiffres, sans indicatif).");
    if (!/^\d{6}$/.test(String(pin || ''))) throw new Error('Le PIN doit contenir exactement 6 chiffres.');
    if (!forageKey) throw new Error('forageKey manquant.');

    const email = resolveLoginEmail(login);

    // Instance secondaire nommée uniquement pour cette création : évite tout
    // conflit si plusieurs créations sont lancées à la suite sur la même page.
    const secondaryApp = initializeApp(firebaseConfig, 'provisioning-' + Date.now());
    const secondaryAuth = getAuth(secondaryApp);

    let uid;
    try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pin);
        uid = cred.user.uid;
        await signOut(secondaryAuth).catch(() => {});
    } finally {
        // Nettoyage systématique : ne laisse jamais l'app secondaire en mémoire.
        await deleteApp(secondaryApp).catch(() => {});
    }

    await set(ref(db, 'users/' + uid), {
        role: role,
        forageKey: forageKey,
        login: login,
        nom: nom || '',
        created_by: createdByUid || '',
        created_at: new Date().toISOString()
    });

    // Miroir léger dans Asufor/{forageKey}/team : seul moyen pour un président
    // (non super-admin) de lister son équipe, les règles ne permettant pas de
    // lister le noeud "users" entier hors super-admin (cf. database.rules.json).
    await set(ref(db, 'Asufor/' + forageKey + '/team/' + uid), {
        role: role,
        nom: nom || '',
        login: login
    });

    return uid;
}
