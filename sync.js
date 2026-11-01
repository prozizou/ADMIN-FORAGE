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
 *   init({ db, ref, onValue, goOffline, goOnline }) suit /.info/connected, affiche le badge d'état, branche les reprises
 *                               (pageshow, visibilitychange, online).
 *   onResync(fn)                enregistre un rafraîchissement SILENCIEUX (fn(reason) → Promise) ; renvoie
 *                               la fonction de désinscription.
 *   resync(reason, {force})     relance les rafraîchissements (dédoublonné) ; sans force, seulement si les
 *                               données sont anciennes ou si la connexion vient de revenir.
 *   track(key, unsub)           enregistre un listener ; l'ancien du même nom est d'abord détaché
 *                               (jamais de doublon ni de listener zombie).
 *   untrack(key) / untrackPrefix(p) / trackedCount()
 *   markSynced() / status() / lastSync()
 *   retry(reason)              rouvre une connexion bloquée puis relit les données (sans vider le cache).
 *   onState(fn)                 fn({status, lastSync, connected}) à chaque changement.
 *
 * Réglages (tests) : window.__ASUFOR_SYNC = { timeout, retries, backoff:[…], staleMs, offlineAfter, debounce, recoveryDelay, recoveryMax, resyncTimeout }
 */
(function (root) {
    'use strict';

    var DEFAULTS = { timeout: 9000, retries: 2, backoff: [700, 1800, 4000], staleMs: 60000, offlineAfter: 8000, debounce: 800, minResume: 1500, recoveryDelay: 30000, recoveryMax: 120000, resyncTimeout: 45000 };
    function cfg(k) {
        var o = (root && root.__ASUFOR_SYNC) || {};
        return o[k] != null ? o[k] : DEFAULTS[k];
    }

    var state = { connected: null, online: true, failing: false, lastSync: 0, connectedFalseAt: 0, lastResume: 0 };
    var stateListeners = [];
    var resyncHandlers = [];
    var tracked = {};
    var inited = false;
    var resyncTimer = null, pendingReason = null;
    var offlineTimer = null;
    var connection = null, recoveryTimer = null, recoveryAttempts = 0, lastRecovery = 0;
    var connectionEpoch = 0;
    var readSources = {};
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
            var epoch = connectionEpoch;
            var p;
            try { p = getFn(refObj); } catch (e) { p = Promise.reject(e); }
            return withTimeout(p, timeout).then(function (snap) {
                // get() peut rendre le cache du SDK hors ligne : ce n'est pas une synchro serveur.
                if (epoch === connectionEpoch && state.connected !== false) markSynced();
                return snap;
            }, function (err) {
                if (isDenied(err) || attempt >= retries) {
                    if (!isDenied(err) && epoch === connectionEpoch) setFailing(true);
                    throw err;
                }
                if (epoch === connectionEpoch) setFailing(true);
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
        // Une connexion Firebase active est une preuve plus forte que navigator.onLine.
        if (offNav && state.connected !== true) return 'offline';
        if (state.connected === false) {
            return (now() - state.connectedFalseAt) >= cfg('offlineAfter') ? 'offline' : 'reconnecting';
        }
        if (state.failing || hasPendingSources()) return 'reconnecting';
        if (inited && state.connected === null) return 'reconnecting';
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
    function setFailing(v) {
        if (state.failing !== v) { state.failing = v; emit(); }
        if (v) scheduleRecovery();
    }
    function markSynced() {
        if (state.connected === false) return; // aucune lecture locale ne prouve un retour en ligne
        state.lastSync = now();
        state.failing = false;
        if (state.connected === true && !hasPendingSources()) { clearTimeout(recoveryTimer); recoveryTimer = null; recoveryAttempts = 0; }
        emit();
        if (hasPendingSources()) scheduleRecovery();
    }
    function hasPendingSources() { return Object.keys(readSources).some(function (key) { return readSources[key] !== 'ready'; }); }
    function reportSource(key, value) {
        if (value == null) delete readSources[key];
        else if (['pending', 'slow', 'error', 'ready'].indexOf(value) >= 0) readSources[key] = value;
        emit();
        if (hasPendingSources()) scheduleRecovery();
    }
    function setConnected(v) {
        var was = state.connected;
        state.connected = v;
        if (v === false) {
            if (was !== false) state.connectedFalseAt = now();
            clearTimeout(offlineTimer);
            offlineTimer = setTimeout(emit, cfg('offlineAfter') + 50);   // bascule « Reconnexion » → « Hors ligne »
        } else if (v === true) {
            if (was !== true) connectionEpoch++;
            clearTimeout(offlineTimer);
            clearTimeout(recoveryTimer); recoveryTimer = null; recoveryAttempts = 0;
            state.failing = false;
            if (was === false) resync('reconnect', { force: true });    // retour du réseau : rafraîchissement automatique
        }
        emit();
        if (v === false || hasPendingSources()) scheduleRecovery();
    }

    function refreshOnline() {
        if (typeof navigator !== 'undefined') state.online = navigator.onLine !== false;
    }
    function canRecover() {
        return state.online !== false && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    }
    function scheduleRecovery() {
        if (!inited || !connection || recoveryTimer || (state.connected === true && !state.failing && !hasPendingSources())) return;
        var delay = Math.min(cfg('recoveryMax'), cfg('recoveryDelay') * Math.pow(2, Math.min(recoveryAttempts, 4)));
        recoveryTimer = setTimeout(function () {
            recoveryTimer = null;
            refreshOnline();
            if (canRecover()) retryConnection('recovery');
            scheduleRecovery();
        }, delay);
        if (recoveryTimer && recoveryTimer.unref) recoveryTimer.unref();
    }
    function retryConnection(reason) {
        refreshOnline();
        var manual = reason === 'badge' || reason === 'loader-retry';
        if (!manual && !canRecover()) { emit(); scheduleRecovery(); return Promise.resolve(false); }
        if (state.connected !== true && connection && connection.goOffline && connection.goOnline &&
            (!lastRecovery || now() - lastRecovery >= cfg('recoveryDelay'))) {
            lastRecovery = now(); recoveryAttempts++;
            try {
                // Le SDK conserve ses écritures en attente pendant cette réouverture.
                connection.goOffline(connection.db);
                connection.goOnline(connection.db);
            } catch (err) { console.warn('[sync] réouverture :', err && (err.code || err.message)); }
        }
        emit();
        return resync(reason || 'retry', { force: true });
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
        if (pendingPromise) return pendingPromise;          // une reprise est déjà planifiée : on la partage
        pendingPromise = new Promise(function (resolve) {
            resyncTimer = setTimeout(function () {
                var why = pendingReason; pendingReason = null;
                var epoch = connectionEpoch;
                var run = function () {
                    return Promise.all(resyncHandlers.slice().map(function (h) {
                        try { return Promise.resolve(h(why)).then(function (result) { return result !== false; }, function (e) { console.warn('[sync] reprise :', e && (e.code || e.message)); return false; }); }
                        catch (e) { return Promise.resolve(false); }
                    }));
                };
                // Un handler bloqué ne doit pas neutraliser toutes les reprises suivantes.
                withTimeout(Promise.resolve().then(run), cfg('resyncTimeout')).then(function (rs) {
                    var ok = rs.length > 0 && rs.every(Boolean);
                    if (epoch === connectionEpoch) {
                        if (ok) markSynced(); else if (rs.length) setFailing(true);
                    }
                    return ok;
                }, function (err) {
                    console.warn('[sync] reprise interrompue :', err && err.code);
                    if (epoch === connectionEpoch) setFailing(true);
                    return false;
                }).then(function (ok) { pendingPromise = null; resolve(ok); });
            }, cfg('debounce'));
        });
        return pendingPromise;
    }

    function onResume(reason) {
        refreshOnline(); emit();
        var t = now();
        if (t - state.lastResume < cfg('minResume')) return;
        state.lastResume = t;
        if (state.connected === false) retryConnection(reason);
        else resync(reason);
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
            el.addEventListener('click', function () { if (status() !== 'synced') retryConnection('badge'); });
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
        connection = o || null;
        state.online = (typeof navigator !== 'undefined' && navigator.onLine === false) ? false : true;
        if (typeof window !== 'undefined') {
            window.addEventListener('online', function () { state.online = true; emit(); retryConnection('online'); });
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
        scheduleRecovery();
        return api;
    }

    api = {
        safeGet: safeGet, init: init, onResync: onResync, resync: resync, retry: retryConnection, reportSource: reportSource, track: track, untrack: untrack, untrackPrefix: untrackPrefix,
        trackedCount: trackedCount, markSynced: markSynced, status: status, lastSync: function () { return state.lastSync; }, onState: onState,
        isStale: isStale, _state: state, _setConnected: setConnected
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AsuforSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
