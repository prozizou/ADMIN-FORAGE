/**
 * biometric.js — Verrouillage biométrique de l'application (WebAuthn)
 * ====================================================================
 *
 * Objectif : la session Firebase reste ouverte tant qu'on ne se déconnecte pas.
 * Sans verrou, quiconque prend le téléphone entre directement dans l'application.
 * Ce module ajoute un VERROU : empreinte digitale, visage ou verrouillage de
 * l'écran de l'appareil, demandés à l'ouverture et au retour après 60 s d'absence.
 *
 * Fonctionnement (aucun secret n'est stocké, rien n'est envoyé à un serveur) :
 *   1. Activation : on crée un identifiant WebAuthn « plateforme » avec
 *      userVerification = required (le capteur biométrique de l'appareil) ; on
 *      mémorise localement sa clé PUBLIQUE (localStorage `asufor_bio_v1`).
 *   2. Déverrouillage : on demande une signature (challenge aléatoire) et on la
 *      VÉRIFIE nous-mêmes avec la clé publique (challenge, origine, rpId, drapeaux
 *      « présence » + « vérification utilisateur », signature) — on ne se contente
 *      pas de « la promesse a réussi ».
 *   3. Le verrou s'applique à toutes les pages protégées via checkAccess()
 *      (security.js → AsuforBio.guard). Se déconnecter (PIN) reste la solution de
 *      secours ; l'identifiant enregistré est propre à un compte (e-mail de session).
 *
 * ⚠️ Limites assumées : c'est un verrou d'application côté appareil, contre un
 *    accès ordinaire au téléphone déverrouillé. Il ne remplace pas l'authentification
 *    Firebase (PIN) et ne protège pas contre quelqu'un qui contrôle le navigateur
 *    (débogage à distance…). Requiert HTTPS, un navigateur récent (Chrome 70+) et un
 *    verrouillage d'écran/biométrie configuré sur l'appareil.
 *
 * Double usage :
 *   • Navigateur : <script src="../biometric.js"></script> → window.AsuforBio
 *   • Node.js    : require('./biometric.js') → fonctions pures (tests) : verifyAssertion,
 *                  derToRaw, b64uEncode/b64uDecode.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;   // Node (tests)
    if (root) root.AsuforBio = api;                                           // Navigateur
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function (root) {
    'use strict';

    var STORE_KEY = 'asufor_bio_v1';          // localStorage : enregistrement de l'identifiant
    var ACTIVITY_KEY = 'asufor_bio_active';   // sessionStorage : dernière activité (déverrouillé)
    var DECLINED_KEY = 'asufor_bio_declined'; // localStorage : « ne plus proposer »
    var RELOCK_AFTER_MS = 60 * 1000;          // absence tolérée avant de reverrouiller
    var TOUCH_EVERY_MS = 15 * 1000;           // rafraîchissement de l'activité pendant l'usage
    var PROMPT_TIMEOUT_MS = 60 * 1000;

    // ─────────────────────────────────────────────────────────────
    // Utilitaires binaires / base64url
    // ─────────────────────────────────────────────────────────────
    function toBytes(x) {
        if (x instanceof Uint8Array) return x;
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        throw new Error('octets attendus');
    }

    function b64uEncode(buf) {
        var b = toBytes(buf), s = '';
        for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function b64uDecode(str) {
        var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function concat(a, b) {
        var out = new Uint8Array(a.length + b.length);
        out.set(a, 0); out.set(b, a.length);
        return out;
    }

    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        var d = 0;
        for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
        return d === 0;
    }

    function getSubtle(p) {
        var c = (p && p.subtle) ? { subtle: p.subtle } : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
        return c && c.subtle ? c.subtle : null;
    }

    function sha256(subtle, bytes) {
        return subtle.digest('SHA-256', bytes).then(function (h) { return new Uint8Array(h); });
    }

    function randomBytes(n) {
        var out = new Uint8Array(n);
        (typeof globalThis !== 'undefined' ? globalThis.crypto : root.crypto).getRandomValues(out);
        return out;
    }

    /** Signature ECDSA DER (ASN.1) → format brut r‖s attendu par WebCrypto. */
    function derToRaw(der, size) {
        var b = toBytes(der), i = 0;
        if (b[i++] !== 0x30) throw new Error('signature DER invalide');
        var len = b[i++];
        if (len & 0x80) i += (len & 0x7f);                 // longueur en forme longue
        function readInt() {
            if (b[i++] !== 0x02) throw new Error('entier DER attendu');
            var l = b[i++];
            var v = b.slice(i, i + l);
            i += l;
            while (v.length > size && v[0] === 0) v = v.slice(1);
            if (v.length > size) throw new Error('entier DER trop grand');
            var out = new Uint8Array(size);
            out.set(v, size - v.length);
            return out;
        }
        var r = readInt(), s = readInt();
        return concat(r, s);
    }

    // ─────────────────────────────────────────────────────────────
    // Vérification d'une assertion WebAuthn (pure, testée sous Node)
    // ─────────────────────────────────────────────────────────────
    /**
     * @param {object} p
     * @param {ArrayBuffer|Uint8Array} p.authenticatorData
     * @param {ArrayBuffer|Uint8Array} p.clientDataJSON
     * @param {ArrayBuffer|Uint8Array} p.signature
     * @param {ArrayBuffer|Uint8Array} p.publicKey      - clé publique SPKI enregistrée
     * @param {number} p.alg                            - -7 (ES256) ou -257 (RS256)
     * @param {string} p.expectedChallenge              - challenge (base64url) émis pour CE déverrouillage
     * @param {string} p.expectedOrigin                 - ex. "https://admin-forage.vercel.app"
     * @param {string} p.rpId                           - ex. "admin-forage.vercel.app"
     * @returns {Promise<boolean>}
     */
    function verifyAssertion(p) {
        return Promise.resolve().then(function () {
            var subtle = getSubtle(p);
            if (!subtle) return false;
            var authData = toBytes(p.authenticatorData);
            var cdj = toBytes(p.clientDataJSON);
            var client = JSON.parse(new TextDecoder().decode(cdj));

            if (client.type !== 'webauthn.get') return false;
            if (client.challenge !== p.expectedChallenge) return false;
            if (client.origin !== p.expectedOrigin) return false;
            if (authData.length < 37) return false;

            return sha256(subtle, new TextEncoder().encode(p.rpId)).then(function (rpHash) {
                if (!equalBytes(rpHash, authData.slice(0, 32))) return false;
                var flags = authData[32];
                if (!(flags & 0x01)) return false;          // UP : présence de l'utilisateur
                if (!(flags & 0x04)) return false;          // UV : utilisateur vérifié (biométrie / code de l'appareil)

                return sha256(subtle, cdj).then(function (cdjHash) {
                    var signed = concat(authData, cdjHash);
                    var sig = toBytes(p.signature), keyAlgo, verifyAlgo;
                    if (p.alg === -7) {
                        keyAlgo = { name: 'ECDSA', namedCurve: 'P-256' };
                        verifyAlgo = { name: 'ECDSA', hash: 'SHA-256' };
                        sig = derToRaw(sig, 32);
                    } else if (p.alg === -257) {
                        keyAlgo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
                        verifyAlgo = { name: 'RSASSA-PKCS1-v1_5' };
                    } else {
                        return false;
                    }
                    return subtle.importKey('spki', toBytes(p.publicKey), keyAlgo, false, ['verify'])
                        .then(function (key) { return subtle.verify(verifyAlgo, key, sig, signed); });
                });
            });
        }).catch(function () { return false; });
    }

    // ─────────────────────────────────────────────────────────────
    // Partie navigateur
    // ─────────────────────────────────────────────────────────────
    var hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

    function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignoré */ } }
    function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
    function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* ignoré */ } }
    function ssDel(k) { try { window.sessionStorage.removeItem(k); } catch (e) { /* ignoré */ } }

    function readRecord() {
        var raw = lsGet(STORE_KEY);
        if (!raw) return null;
        try {
            var r = JSON.parse(raw);
            if (r && r.v === 1 && typeof r.credId === 'string' && typeof r.publicKey === 'string' &&
                (r.alg === -7 || r.alg === -257) && typeof r.rpId === 'string') return r;
        } catch (e) { /* enregistrement corrompu */ }
        lsDel(STORE_KEY);
        return null;
    }

    function isEnrolled() { return !!readRecord(); }

    /** Vrai si l'appareil sait vérifier l'utilisateur (biométrie / verrouillage d'écran) via WebAuthn. */
    function isSupported() {
        if (!hasDom || !window.isSecureContext || !window.PublicKeyCredential ||
            typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function' ||
            !navigator.credentials) return Promise.resolve(false);
        return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
            .then(function (ok) { return !!ok; }, function () { return false; });
    }

    /** Erreur dont le message (français) est destiné à l'utilisateur tel quel. */
    function ownError(msg) { var e = new Error(msg); e.own = true; return e; }

    function friendlyError(err) {
        var n = err && err.name;
        if (n === 'NotAllowedError' || n === 'AbortError') return "Vérification annulée ou expirée.";
        if (n === 'SecurityError') return "Cet appareil ne permet pas la biométrie ici (connexion non sécurisée).";
        if (n === 'NotSupportedError' || n === 'InvalidStateError') return "La biométrie n'est pas disponible sur cet appareil.";
        return (err && err.message) ? err.message : "La vérification a échoué.";
    }

    /**
     * Active le verrouillage biométrique pour la session donnée.
     * Crée l'identifiant, l'enregistre, puis exige UNE vérification réussie avant de le garder
     * (sinon on ne verrouillerait l'utilisateur dehors qu'à la prochaine ouverture).
     * @param {{email?:string, nom?:string}} session
     * @returns {Promise<void>}
     */
    function enroll(session) {
        session = session || {};
        var subtle = getSubtle();
        return isSupported().then(function (ok) {
            if (!ok) throw ownError("La biométrie n'est pas disponible sur cet appareil (verrouillage d'écran requis).");
            return sha256(subtle, new TextEncoder().encode(String(session.email || 'utilisateur')));
        }).then(function (userId) {
            return navigator.credentials.create({
                publicKey: {
                    rp: { name: 'Satigué Eau', id: window.location.hostname },
                    user: { id: userId, name: String(session.email || 'utilisateur'), displayName: String(session.nom || session.email || 'Utilisateur') },
                    challenge: randomBytes(32),
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged', requireResidentKey: false },
                    attestation: 'none',
                    timeout: PROMPT_TIMEOUT_MS
                }
            });
        }).then(function (cred) {
            var resp = cred && cred.response;
            if (!resp || typeof resp.getPublicKey !== 'function' || !resp.getPublicKey()) {
                throw ownError("Ce navigateur ne fournit pas la clé publique nécessaire (mettez Chrome à jour).");
            }
            var alg = resp.getPublicKeyAlgorithm();
            if (alg !== -7 && alg !== -257) throw ownError("Algorithme de signature non pris en charge.");
            var rec = {
                v: 1,
                email: session.email || null,
                credId: b64uEncode(cred.rawId),
                publicKey: b64uEncode(resp.getPublicKey()),
                alg: alg,
                rpId: window.location.hostname,
                createdAt: new Date().toISOString()
            };
            if (!lsSet(STORE_KEY, JSON.stringify(rec))) throw ownError("Impossible d'enregistrer la configuration sur cet appareil.");
            return verify();
        }).then(function (ok) {
            if (!ok) {
                lsDel(STORE_KEY);
                throw ownError("La vérification de contrôle a échoué : le verrouillage n'a pas été activé.");
            }
            // Verrou actif dès maintenant : surveiller aussi les retours d'arrière-plan de CETTE page
            // (sinon il faudrait attendre le prochain chargement pour reverrouiller après une absence).
            installListeners();
            touch(true);
        }).catch(function (err) {
            if (!err || !err.own) err = ownError(friendlyError(err));
            throw err;
        });
    }

    /**
     * Demande une vérification biométrique et contrôle la signature obtenue.
     * @returns {Promise<boolean>} vrai seulement si la signature est valable.
     */
    function verify() {
        var rec = readRecord();
        if (!rec) return Promise.resolve(false);
        var challenge = randomBytes(32);
        var challengeB64 = b64uEncode(challenge);
        return navigator.credentials.get({
            publicKey: {
                challenge: challenge,
                rpId: rec.rpId,
                allowCredentials: [{ type: 'public-key', id: b64uDecode(rec.credId), transports: ['internal'] }],
                userVerification: 'required',
                timeout: PROMPT_TIMEOUT_MS
            }
        }).then(function (assertion) {
            if (!assertion || !assertion.response) return false;
            if (b64uEncode(assertion.rawId) !== rec.credId) return false;
            return verifyAssertion({
                authenticatorData: assertion.response.authenticatorData,
                clientDataJSON: assertion.response.clientDataJSON,
                signature: assertion.response.signature,
                publicKey: b64uDecode(rec.publicKey),
                alg: rec.alg,
                expectedChallenge: challengeB64,
                expectedOrigin: window.location.origin,
                rpId: rec.rpId
            });
        });
    }

    /** Désactive le verrouillage sur cet appareil (l'appelant doit avoir vérifié l'utilisateur avant). */
    function disable() {
        lsDel(STORE_KEY);
        ssDel(ACTIVITY_KEY);
        unlockUi();
    }

    // ── Activité / verrou ──
    var locked = false;
    var lastTouch = 0;

    function touch(force) {
        if (locked) return;
        var now = Date.now();
        if (!force && now - lastTouch < TOUCH_EVERY_MS) return;
        lastTouch = now;
        ssSet(ACTIVITY_KEY, String(now));
    }

    /** Vrai si l'application a été utilisée il y a moins de RELOCK_AFTER_MS. */
    function isFresh() {
        var t = parseInt(ssGet(ACTIVITY_KEY) || '0', 10);
        return t > 0 && (Date.now() - t) <= RELOCK_AFTER_MS;
    }

    /** À appeler juste après une connexion par PIN : l'utilisateur vient de s'authentifier. */
    function markUnlocked() { touch(true); }

    var STYLE_ID = 'asufor-lock-style';
    var OVERLAY_ID = 'asufor-lock';

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent =
            'html.asufor-locked body{visibility:hidden!important}' +
            '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:2147483647;background:#f8fafc;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;visibility:visible}' +
            '#' + OVERLAY_ID + ' .box{max-width:340px;width:100%;text-align:center;color:#0f172a}' +
            '#' + OVERLAY_ID + ' .ico{width:72px;height:72px;margin:0 auto 16px;border-radius:50%;background:#e0e9fb;display:flex;align-items:center;justify-content:center}' +
            '#' + OVERLAY_ID + ' h2{margin:0 0 8px;font-size:1.25rem}' +
            '#' + OVERLAY_ID + ' p{margin:0 0 20px;color:#475569;font-size:.95rem;line-height:1.4}' +
            '#' + OVERLAY_ID + ' .msg{min-height:1.2em;color:#b91c1c;font-size:.9rem;margin:-8px 0 12px}' +
            '#' + OVERLAY_ID + ' button{display:block;width:100%;padding:14px;border-radius:12px;border:0;font-size:1rem;font-weight:600;cursor:pointer}' +
            '#' + OVERLAY_ID + ' .primary{background:#0439a0;color:#fff;margin-bottom:10px}' +
            '#' + OVERLAY_ID + ' .link{background:transparent;color:#475569;text-decoration:underline;font-weight:500}' +
            '#' + OVERLAY_ID + ' button:disabled{opacity:.6;cursor:wait}';
        (document.head || document.documentElement).appendChild(st);
    }

    var FP_SVG = '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#0439a0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 11c0 3.5-.5 6-2 8"/><path d="M8 20c1.5-2 2-4.5 2-9a2 2 0 0 1 4 0c0 2.5-.3 4.5-1 6.5"/><path d="M5 17c.7-2 1-4 1-6a6 6 0 0 1 12 0c0 1.5-.1 2.8-.4 4"/><path d="M3.5 13.5A9 9 0 0 1 3 11a9 9 0 0 1 18 0"/><path d="M17 20c.6-1.5.9-3 1-4.5"/></svg>';

    function whenReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }

    function unlockUi() {
        locked = false;
        if (!hasDom) return;
        document.documentElement.classList.remove('asufor-locked');
        var o = document.getElementById(OVERLAY_ID);
        if (o && o.parentNode) o.parentNode.removeChild(o);
        if (document.body) document.body.inert = false;
    }

    function tryUnlock(btn, msg) {
        if (btn) btn.disabled = true;
        if (msg) msg.textContent = '';
        return verify().then(function (ok) {
            if (ok) { unlockUi(); touch(true); return true; }
            if (msg) msg.textContent = "Vérification refusée. Réessayez.";
            if (btn) btn.disabled = false;
            return false;
        }, function (err) {
            if (msg) msg.textContent = friendlyError(err);
            if (btn) btn.disabled = false;
            return false;
        });
    }

    function buildOverlay() {
        if (!locked || document.getElementById(OVERLAY_ID)) return;
        ensureStyle();
        var o = document.createElement('div');
        o.id = OVERLAY_ID;
        o.setAttribute('role', 'dialog');
        o.setAttribute('aria-modal', 'true');
        o.setAttribute('aria-label', 'Application verrouillée');
        o.innerHTML =
            '<div class="box">' +
            '<div class="ico">' + FP_SVG + '</div>' +
            '<h2>Application verrouillée</h2>' +
            '<p>Utilisez votre empreinte digitale, votre visage ou le verrouillage de l\'écran pour continuer.</p>' +
            '<div class="msg" role="alert"></div>' +
            '<button type="button" class="primary">Déverrouiller</button>' +
            '<button type="button" class="link">Se déconnecter</button>' +
            '</div>';
        document.documentElement.appendChild(o);
        if (document.body) document.body.inert = true;
        var btn = o.querySelector('.primary'), msg = o.querySelector('.msg');
        btn.addEventListener('click', function () { tryUnlock(btn, msg); });
        o.querySelector('.link').addEventListener('click', function () {
            if (typeof window.logout === 'function') window.logout();
            else window.location.replace('index.html');
        });
        // Invite automatique à l'ouverture (si le navigateur la refuse, le bouton reste disponible).
        setTimeout(function () { if (locked) tryUnlock(btn, msg); }, 250);
    }

    function lock() {
        if (!hasDom || locked) return;
        locked = true;
        ensureStyle();
        document.documentElement.classList.add('asufor-locked');
        whenReady(buildOverlay);
    }

    var listenersInstalled = false;
    function installListeners() {
        if (listenersInstalled || !hasDom) return;
        listenersInstalled = true;
        document.addEventListener('visibilitychange', function () {
            if (!readRecord()) return;
            if (document.visibilityState === 'hidden') touch(true);
            else if (!locked && !isFresh()) lock();
        });
        window.addEventListener('pagehide', function () { if (readRecord()) touch(true); });
        ['click', 'touchstart', 'keydown'].forEach(function (evt) {
            document.addEventListener(evt, function () { touch(false); }, { passive: true, capture: true });
        });
    }

    /**
     * Point d'entrée appelé par checkAccess() (security.js) sur chaque page protégée.
     * @param {{email?:string}} session
     */
    function guard(session) {
        if (!hasDom) return;
        var rec = readRecord();
        if (!rec) return;
        // Identifiant enregistré pour un AUTRE compte : obsolète, on l'efface (pas de verrou étranger).
        if (rec.email && session && session.email && rec.email !== session.email) {
            lsDel(STORE_KEY);
            return;
        }
        installListeners();
        if (!isFresh()) lock();
        else touch(true);
    }

    // ── Proposition d'activation (fenêtre) ──
    /**
     * Propose d'activer le verrouillage (une seule fois : « Plus tard » réaffiche à la prochaine
     * ouverture, « Ne plus demander » mémorise le refus). Ne fait rien si non pris en charge,
     * déjà activé ou refusé.
     * @returns {Promise<void>}
     */
    function offerEnrollment(session, opts) {
        opts = opts || {};
        if (!hasDom || isEnrolled() || lsGet(DECLINED_KEY) === '1') return Promise.resolve();
        return isSupported().then(function (ok) {
            if (!ok) return;
            return new Promise(function (resolve) {
                ensureStyle();
                var o = document.createElement('div');
                o.id = 'asufor-bio-offer';
                o.setAttribute('role', 'dialog');
                o.setAttribute('aria-modal', 'true');
                o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
                o.innerHTML =
                    '<div style="background:#fff;border-radius:16px;max-width:340px;width:100%;padding:24px;text-align:center;color:#0f172a;box-shadow:0 20px 50px rgba(0,0,0,.3)">' +
                    '<div style="width:64px;height:64px;margin:0 auto 12px;border-radius:50%;background:#e0e9fb;display:flex;align-items:center;justify-content:center">' + FP_SVG + '</div>' +
                    '<h3 style="margin:0 0 8px;font-size:1.15rem">Protéger l\'application ?</h3>' +
                    '<p style="margin:0 0 16px;color:#475569;font-size:.92rem;line-height:1.4">Activez le verrouillage par empreinte digitale ou visage : l\'application ne s\'ouvrira plus sans vous, même si quelqu\'un prend votre téléphone.</p>' +
                    '<div class="bo-msg" role="alert" style="min-height:1.2em;color:#b91c1c;font-size:.88rem;margin-bottom:8px"></div>' +
                    '<button type="button" class="bo-yes" style="display:block;width:100%;padding:13px;border:0;border-radius:12px;background:#0439a0;color:#fff;font-size:1rem;font-weight:600;margin-bottom:8px;cursor:pointer">Activer</button>' +
                    '<button type="button" class="bo-later" style="display:block;width:100%;padding:11px;border:0;background:transparent;color:#475569;font-size:.95rem;cursor:pointer">Plus tard</button>' +
                    '<button type="button" class="bo-never" style="display:block;width:100%;padding:8px;border:0;background:transparent;color:#94a3b8;font-size:.82rem;cursor:pointer">Ne plus demander</button>' +
                    '</div>';
                document.body.appendChild(o);
                var msg = o.querySelector('.bo-msg'), yes = o.querySelector('.bo-yes');
                function close() { if (o.parentNode) o.parentNode.removeChild(o); resolve(); }
                yes.addEventListener('click', function () {
                    yes.disabled = true; msg.textContent = '';
                    enroll(session).then(function () {
                        if (typeof opts.onEnabled === 'function') opts.onEnabled();
                        close();
                    }, function (err) {
                        msg.textContent = err.message || friendlyError(err);
                        yes.disabled = false;
                    });
                });
                o.querySelector('.bo-later').addEventListener('click', close);
                o.querySelector('.bo-never').addEventListener('click', function () { lsSet(DECLINED_KEY, '1'); close(); });
            });
        });
    }

    return {
        // pur (tests)
        verifyAssertion: verifyAssertion,
        derToRaw: derToRaw,
        b64uEncode: b64uEncode,
        b64uDecode: b64uDecode,
        // application
        isSupported: isSupported,
        isEnrolled: isEnrolled,
        enroll: enroll,
        verify: verify,
        disable: disable,
        guard: guard,
        markUnlocked: markUnlocked,
        offerEnrollment: offerEnrollment,
        RELOCK_AFTER_MS: RELOCK_AFTER_MS,
        STORE_KEY: STORE_KEY,
        DECLINED_KEY: DECLINED_KEY
    };
});
