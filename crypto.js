/**
 * crypto.js — Utilitaires cryptographiques ASUFOR
 * =================================================
 *
 * Fournit les fonctions de hachage SHA-256 utilisées pour :
 *   - Sécuriser les passcodes des agents (au lieu du stockage en clair)
 *   - Comparer les passcodes lors de la vérification terrain
 *
 * Utilise l'API Web Crypto du navigateur (pas de dépendance externe).
 *
 * Double usage :
 *   • Navigateur : <script src="../crypto.js"></script> → window.ASUFORCrypto
 *   • Node.js    : const ASUFORCrypto = require('./crypto.js')
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;            // Node.js
    }
    if (root) {
        root.ASUFORCrypto = api;         // Navigateur (window.ASUFORCrypto)
    }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────
    // HASH SHA-256
    // ─────────────────────────────────────────────────────────────

    /**
     * Calcule le hash SHA-256 d'une chaîne et retourne un hex-string.
     *
     * @param {string} text - Le texte à hacher (ex: passcode "123456")
     * @returns {Promise<string>} Le hash hexadécimal (64 caractères)
     *
     * Exemple :
     *   await sha256('123456')
     *   → "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
     */
    async function sha256(text) {
        var data = new TextEncoder().encode(String(text));
        var hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer))
            .map(function (b) { return b.toString(16).padStart(2, '0'); })
            .join('');
    }

    // ─────────────────────────────────────────────────────────────
    // PASSCODE AGENTS
    // ─────────────────────────────────────────────────────────────

    /**
     * Hash un passcode d'agent avec un sel par défaut.
     * Le sel est incorporé pour résister aux attaques par rainbow table.
     *
     * @param {string} passcode - Le passcode en clair (ex: "123456")
     * @returns {Promise<string>} Le passcode hashé (prêt à être stocké)
     */
    async function hashAgentPasscode(passcode) {
        var salted = 'asufor_agent_v1:' + String(passcode).trim();
        return sha256(salted);
    }

    /**
     * Vérifie qu'un passcode saisi correspond au hash stocké.
     *
     * @param {string} inputPasscode - Le passcode saisi par l'utilisateur
     * @param {string} storedHash    - Le hash stocké dans Firebase
     * @returns {Promise<boolean>}   true si le passcode correspond
     */
    async function verifyAgentPasscode(inputPasscode, storedHash) {
        var computed = await hashAgentPasscode(inputPasscode);
        return computed === storedHash;
    }

    // ─────────────────────────────────────────────────────────────
    // PASSCODE MAINTENANCE (zéro / clôture de cycle)
    // ─────────────────────────────────────────────────────────────

    /**
     * Génère un passcode de maintenance aléatoire (8 caractères alphanumériques).
     * Ce passcode remplace le format prévisible AAAAMM.
     *
     * @returns {string} Passcode aléatoire (ex: "A3k9X7mQ")
     */
    function generateMaintenancePasscode() {
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // pas de 0, O, I, 1
        var result = '';
        // ✅ CORRECTION v5 : générateur cryptographiquement sûr (CSPRNG).
        //    Math.random() est prédictible ; crypto.getRandomValues() ne l'est pas.
        //    Fonctionne dans le navigateur (Web Crypto) et Node.js ≥ 15 (globalThis.crypto).
        var cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
        if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
            // Rejection sampling pour éviter le biais modulo (256 % 32 === 0 ici,
            // donc pas de biais, mais on garde la méthode robuste si chars change).
            var array = new Uint8Array(8);
            cryptoObj.getRandomValues(array);
            for (var i = 0; i < 8; i++) {
                result += chars.charAt(array[i] % chars.length);
            }
        } else {
            // Fallback très improbable (vieux navigateurs) — mieux que rien.
            for (var j = 0; j < 8; j++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        }
        return result;
    }

    /**
     * Hash un passcode de maintenance avec un sel dédié.
     *
     * @param {string} passcode - Le passcode à hacher
     * @returns {Promise<string>} Le hash (prêt à être stocké)
     */
    async function hashMaintenancePasscode(passcode) {
        var salted = 'asufor_maintenance_v1:' + String(passcode).trim().toUpperCase();
        return sha256(salted);
    }

    /**
     * Vérifie qu'un passcode de maintenance saisi correspond au hash stocké.
     *
     * @param {string} inputPasscode - Le passcode saisi
     * @param {string} storedHash    - Le hash stocké
     * @returns {Promise<boolean>}   true si le passcode correspond
     */
    async function verifyMaintenancePasscode(inputPasscode, storedHash) {
        var computed = await hashMaintenancePasscode(inputPasscode);
        return computed === storedHash;
    }

    // ─────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────
    return {
        sha256: sha256,
        // agents
        hashAgentPasscode: hashAgentPasscode,
        verifyAgentPasscode: verifyAgentPasscode,
        // maintenance
        generateMaintenancePasscode: generateMaintenancePasscode,
        hashMaintenancePasscode: hashMaintenancePasscode,
        verifyMaintenancePasscode: verifyMaintenancePasscode
    };
});
