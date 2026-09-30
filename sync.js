/**
 * sync.js — Synchronisation Firebase RTDB robuste (ASUFOR)
 * ========================================================
 * Objectif : aucune page ne doit rester en chargement infini ni exiger de vider le cache ou de
 * recharger à la main pour retrouver Firebase (retour d'arrière-plan, réseau coupé puis rétabli,
 * navigation répétée, lecture bloquée).
 *
 * Aucune dépendance : les fonctions Firebase sont passées par la page (SDK modulaire ou compat).
 * Aucune logique métier ici, aucune écriture.
 *
 * API (window.AsuforSync) :
 *   safeGet(getFn, ref, opts)   get() avec délai maximal + nouvelles tentatives à délai croissant.
 *                               Rejette (code 'TIMEOUT' ou celui de Firebase) après la dernière tentative ;
 *                               PERMISSION_DENIED n'est jamais retenté.
 *   init({ db, ref, onValue })  suit /.info/connected, affiche le badge d'état, branche les reprises
 *                               (pageshow, visibilitychange, online).
 *   onResync(fn)                enregistre un rafraîchissement SILENCIEUX (fn(reason) → Promise) ; renvoie
 *                               la fonction de désinscription.
 *   resync(reason, {force})     relance les rafraîchissements (dédoublonné) ; sans force, seulement si les
 *                               données sont anciennes ou si la connexion vient de revenir.
 *   track(key, unsub)           enregistre un listener ; l'ancien du même nom est d'abord détaché
 *                               (jamais de doublon ni de listener zombie).
 *   untrack(key) / untrackPrefix(p) / trackedCount()
 *   markSynced() / status() / lastSync()
 *   onState(fn)                 fn({status, lastSync, connected}) à chaque changement.
 *
 * Réglages (tests) : window.__ASUFOR_SYNC = { timeout, retries, backoff:[…], staleMs, offlineAfter, debounce }
 */
(function (root) {
    'use strict';

    var DEFAULTS = { timeout: 9000, retries: 2, backoff: [700, 1800, 4000], staleMs: 60000, offlineAfter: 8000, debounce: 800, minResume: 1500 };
    function cfg(k) {
        var o = (root && root.__ASUFOR_SYNC) || {};
        return o[k] != null ? o[k] : DEFAULTS[k];
    }

    var state = { connected: null, online: true, failing: false, lastSync: 0, connectedFalseAt: 0, lastResume: 0 };
    var stateListeners = [];
    var resyncHandlers = [];
    var tracked = {};
    var inited = false;
    var resyncTimer = null, resyncRunning = null, pendingReason = null, pendingForce = false;
    var offlineTimer = null;
    var api = {};

    function now() { return Date.now(); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // ── Lecture sûre ────────────────────────────────────────────────────────────────────────────
    function withTimeout(p, ms) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var t = setTimeout(function () {
                if (done) return; done = true;
                var e = new Error('Lecture Firebase trop lente (' + ms + ' ms)'); e.code = 'TIMEOUT'; reject(e);
            }, ms);
            Promise.resolve(p).then(function (v) { if (done) return; done = true; clearTimeout(t); resolve(v); },
                function (e) { if (done) return; done = true; clearTimeout(t); reject(e); });
        });
    }
    function isDenied(e) { return !!e && (e.code === 'PERMISSION_DENIED' || /permission_denied/i.test(String(e.message || ''))); }

    function safeGet(getFn, refObj, opts) {
        opts = opts || {};
        var timeout = opts.timeout != null ? opts.timeout : cfg('timeout');
        var retries = opts.retries != null ? opts.retries : cfg('retries');
        var backoff = opts.backoff || cfg('backoff');
        var attempt = 0;
        function once() {
            var p;
            try { p = getFn(refObj); } catch (e) { p = Promise.reject(e); }
            return withTimeout(p, timeout).then(function (snap) {
                markSynced();
                return snap;
            }, function (err) {
                if (isDenied(err) || attempt >= retries) {
                    if (!isDenied(err)) setFailing(true);
                    throw err;
                }
                setFailing(true);
                var wait = backoff[Math.min(attempt, backoff.length - 1)] || 1000;
                attempt++;
                return sleep(wait + Math.floor(Math.random() * 150)).then(once);
            });
        }
        return once();
    }

    // ── État de connexion ──────────────────────────────────────────────────────────────────────
    function status() {
        var offNav = state.online === false;
        if (offNav) return 'offline';
        if (state.connected === false) {
            return (now() - state.connectedFalseAt) >= cfg('offlineAfter') ? 'offline' : 'reconnecting';
        }
        if (state.failing) return 'reconnecting';
        return 'synced';
    }
    var lastEmitted = '';
    function emit() {
        var s = status();
        var key = s + '|' + state.lastSync + '|' + state.connected;
        if (key === lastEmitted) return;
        lastEmitted = key;
        var snapshot = { status: s, lastSync: state.lastSync, connected: state.connected };
        renderBadge(snapshot);
        stateListeners.slice().forEach(function (f) { try { f(snapshot); } catch (e) { console.error(e); } });
    }
    function setFailing(v) { if (state.failing !== v) { state.failing = v; emit(); } }
    function markSynced() {
        state.lastSync = now();
        state.failing = false;
        emit();
    }
    function setConnected(v) {
        var was = state.connected;
        state.connected = v;
        if (v === false) {
            if (was !== false) state.connectedFalseAt = now();
            clearTimeout(offlineTimer);
            offlineTimer = setTimeout(emit, cfg('offlineAfter') + 50);   // bascule « Reconnexion » → « Hors ligne »
        } else if (v === true) {
            clearTimeout(offlineTimer);
            state.failing = false;
            if (was === false) resync('reconnect', { force: true });    // retour du réseau : rafraîchissement automatique
        }
        emit();
    }
    function onState(fn) { stateListeners.push(fn); return function () { stateListeners = stateListeners.filter(function (f) { return f !== fn; }); }; }

    // ── Listeners (anti-doublons / zombies) ───────────────────────────────────────────────────
    function track(key, unsub) {
        untrack(key);
        tracked[key] = unsub;
        return function () { untrack(key); };
    }
    function untrack(key) {
        var u = tracked[key];
        if (u) { delete tracked[key]; try { u(); } catch (e) { /* listener déjà détaché */ } }
    }
    function untrackPrefix(p) { Object.keys(tracked).forEach(function (k) { if (k.indexOf(p) === 0) untrack(k); }); }
    function trackedCount() { return Object.keys(tracked).length; }

    // ── Reprises silencieuses ─────────────────────────────────────────────────────────────────
    function onResync(fn) { resyncHandlers.push(fn); return function () { resyncHandlers = resyncHandlers.filter(function (f) { return f !== fn; }); }; }
    function isStale() { return !state.lastSync || (now() - state.lastSync) > cfg('staleMs'); }

    var pendingPromise = null;
    function resync(reason, o) {
        o = o || {};
        if (!o.force && !isStale() && status() === 'synced') return Promise.resolve(false);
        pendingReason = reason || pendingReason || 'manual';
        pendingForce = pendingForce || !!o.force;
        if (pendingPromise) return pendingPromise;          // une reprise est déjà planifiée : on la partage
        pendingPromise = new Promise(function (resolve) {
            resyncTimer = setTimeout(function () {
                var why = pendingReason; pendingReason = null; pendingForce = false;
                var run = function () {
                    return Promise.all(resyncHandlers.slice().map(function (h) {
                        try { return Promise.resolve(h(why)).then(function () { return true; }, function (e) { console.warn('[sync] reprise :', e && (e.code || e.message)); return false; }); }
                        catch (e) { return Promise.resolve(false); }
                    }));
                };
                // si une reprise tourne encore (rare), on attend sa fin puis on relance avec les données les plus récentes
                Promise.resolve(resyncRunning).then(run).then(function (rs) {
                    if (rs.length && rs.every(Boolean)) markSynced();
                    resolve(true);
                }, function () { resolve(false); }).then(function () { pendingPromise = null; resyncRunning = null; });
                resyncRunning = pendingPromise;
            }, cfg('debounce'));
        });
        return pendingPromise;
    }

    function onResume(reason) {
        var t = now();
        if (t - state.lastResume < cfg('minResume')) return;
        state.lastResume = t;
        resync(reason);
    }

    // ── Badge d'état discret ───────────────────────────────────────────────────────────────────
    var BADGE_ID = 'asufor-sync-badge';
    function hhmm(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    function ensureBadgeStyle() {
        if (typeof document === 'undefined' || document.getElementById(BADGE_ID + '-style')) return;
        var st = document.createElement('style');
        st.id = BADGE_ID + '-style';
        st.textContent = '#' + BADGE_ID + '{position:fixed;left:8px;bottom:8px;z-index:9000;max-width:calc(100vw - 16px);display:inline-flex;align-items:center;gap:6px;' +
            'padding:4px 10px;border-radius:999px;font:600 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;background:rgba(15,23,42,.82);color:#e2e8f0;' +
            'box-shadow:0 1px 6px rgba(0,0,0,.3);pointer-events:auto;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '#' + BADGE_ID + ' i{width:7px;height:7px;border-radius:50%;flex:none;background:#22c55e}' +
            '#' + BADGE_ID + '[data-status="reconnecting"] i{background:#f59e0b;animation:asyncpulse 1s infinite}' +
            '#' + BADGE_ID + '[data-status="offline"] i{background:#ef4444}' +
            '@keyframes asyncpulse{50%{opacity:.3}}@media print{#' + BADGE_ID + '{display:none}}';
        (document.head || document.documentElement).appendChild(st);
    }
    function renderBadge(s) {
        if (typeof document === 'undefined' || !document.body || !inited) return;
        ensureBadgeStyle();
        var el = document.getElementById(BADGE_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = BADGE_ID;
            el.setAttribute('role', 'status');
            el.addEventListener('click', function () { if (status() !== 'synced') resync('badge', { force: true }); });
            document.body.appendChild(el);
        }
        var h = hhmm(s.lastSync);
        var txt = s.status === 'synced' ? 'Synchronisé' + (h ? ' · ' + h : '')
            : s.status === 'reconnecting' ? 'Reconnexion…' + (h ? ' · dernière synchro ' + h : '')
            : 'Hors ligne — données locales' + (h ? ' · ' + h : '');
        el.setAttribute('data-status', s.status);
        el.innerHTML = '<i></i><span></span>';
        el.lastChild.textContent = txt;
    }

    function init(o) {
        if (inited) return api;
        inited = true;
        state.online = (typeof navigator !== 'undefined' && navigator.onLine === false) ? false : true;
        if (typeof window !== 'undefined') {
            window.addEventListener('online', function () { state.online = true; emit(); resync('online', { force: true }); });
            window.addEventListener('offline', function () { state.online = false; emit(); });
            window.addEventListener('pageshow', function (e) { onResume(e && e.persisted ? 'pageshow-bfcache' : 'pageshow'); });
            document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') onResume('visible'); });
        }
        if (o && o.db && o.ref && o.onValue) {
            try {
                track('sync:connected', o.onValue(o.ref(o.db, '.info/connected'), function (snap) { setConnected(snap.val() === true); }, function () { /* .info est toujours lisible */ }));
            } catch (e) { console.warn('[sync] /.info/connected indisponible', e); }
        }
        if (typeof document !== 'undefined') {
            if (document.body) renderBadge({ status: status(), lastSync: state.lastSync }); else document.addEventListener('DOMContentLoaded', function () { renderBadge({ status: status(), lastSync: state.lastSync }); });
        }
        return api;
    }

    api = {
        safeGet: safeGet, init: init, onResync: onResync, resync: resync, track: track, untrack: untrack, untrackPrefix: untrackPrefix,
        trackedCount: trackedCount, markSynced: markSynced, status: status, lastSync: function () { return state.lastSync; }, onState: onState,
        isStale: isStale, _state: state, _setConnected: setConnected
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AsuforSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
