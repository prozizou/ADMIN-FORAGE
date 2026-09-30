/**
 * loader.js — Overlay de chargement partagé ASUFOR
 *
 * Objectif : afficher un indicateur de chargement VISIBLE sur toutes les pages
 * pendant (1) la restauration du jeton Firebase Auth et (2) la première lecture
 * des données. Évite l'écran vide qui donne l'impression « les données ne
 * s'affichent pas ».
 *
 * SDK-agnostique : pur DOM, aucune dépendance. Fonctionne aussi bien avec les
 * pages en SDK modulaire (import) qu'en SDK compat.
 *
 * API globale :
 *   AsuforLoader.show(message)      → affiche l'overlay (barre de progression animée)
 *   AsuforLoader.update(message)    → change le texte sans masquer
 *   AsuforLoader.hide()             → masque l'overlay (données prêtes)
 *   AsuforLoader.fail(message, opts)→ état d'erreur + lien « Se reconnecter »
 *
 * opts.fail :
 *   { retry: Function }  → affiche un bouton « Réessayer » qui appelle retry()
 *   { loginHref: '../index.html' } → lien de reconnexion (défaut : auto-détecté)
 *
 * Le chargement est chargé AVANT les scripts Firebase (classique, pas de defer),
 * mais crée son DOM paresseusement : safe même si appelé avant <body>.
 */
(function () {
    'use strict';

    var STYLE_ID = 'asufor-loader-style';
    var ROOT_ID = 'asufor-loader-root';
    var pendingShow = null; // si show() est appelé avant que le DOM soit prêt
    var watchdog = null;    // ✅ chien de garde : jamais de spinner infini
    function watchdogMs() { return window.__ASUFOR_WATCHDOG_MS || 12000; }
    function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

    var CSS = [
        '#' + ROOT_ID + '{position:fixed;inset:0;z-index:99999;display:flex;',
        'align-items:center;justify-content:center;',
        'background:rgba(10,15,28,0.72);backdrop-filter:blur(6px);',
        '-webkit-backdrop-filter:blur(6px);opacity:0;pointer-events:none;',
        'transition:opacity .22s ease;font-family:Inter,system-ui,-apple-system,sans-serif;}',
        '#' + ROOT_ID + '.on{opacity:1;pointer-events:auto;}',
        '#' + ROOT_ID + ' .al-card{width:88%;max-width:320px;padding:28px 26px;',
        'border-radius:20px;background:rgba(30,41,59,0.9);',
        'border:1px solid rgba(255,255,255,0.1);',
        'box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);text-align:center;color:#f8fafc;}',
        '#' + ROOT_ID + ' .al-spin{width:44px;height:44px;margin:0 auto 18px;',
        'border:3px solid rgba(255,255,255,0.15);border-top-color:#38bdf8;',
        'border-radius:50%;animation:alspin .8s linear infinite;}',
        '@keyframes alspin{to{transform:rotate(360deg);}}',
        '#' + ROOT_ID + ' .al-msg{font-size:14px;font-weight:600;line-height:1.45;',
        'margin-bottom:16px;min-height:20px;}',
        '#' + ROOT_ID + ' .al-bar{height:4px;width:100%;border-radius:4px;overflow:hidden;',
        'background:rgba(255,255,255,0.08);}',
        '#' + ROOT_ID + ' .al-bar > i{display:block;height:100%;width:40%;border-radius:4px;',
        'background:linear-gradient(90deg,#0ea5e9,#38bdf8);animation:albar 1.1s ease-in-out infinite;}',
        '@keyframes albar{0%{margin-left:-40%;}50%{margin-left:60%;}100%{margin-left:100%;}}',
        '#' + ROOT_ID + '.slow .al-spin{display:none;}',
        '#' + ROOT_ID + '.slow .al-bar{display:none;}',
        '#' + ROOT_ID + '.slow .al-icon{font-size:34px;margin-bottom:12px;display:block;}',
        '#' + ROOT_ID + '.error .al-spin{display:none;}',
        '#' + ROOT_ID + '.error .al-bar{display:none;}',
        '#' + ROOT_ID + '.error .al-icon{font-size:34px;margin-bottom:12px;display:block;}',
        '#' + ROOT_ID + ' .al-icon{display:none;}',
        '#' + ROOT_ID + ' .al-actions{margin-top:16px;display:flex;gap:10px;',
        'justify-content:center;flex-wrap:wrap;}',
        '#' + ROOT_ID + ' .al-btn{padding:10px 18px;border-radius:10px;border:none;cursor:pointer;',
        'font-size:13px;font-weight:700;background:#38bdf8;color:#04121f;text-decoration:none;',
        'display:inline-block;transition:opacity .2s;}',
        '#' + ROOT_ID + ' .al-btn:hover{opacity:.9;}',
        '#' + ROOT_ID + ' .al-btn.ghost{background:transparent;color:#93c5fd;',
        'border:1px solid rgba(147,197,253,0.4);}'
    ].join('');

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    function buildRoot() {
        var root = document.getElementById(ROOT_ID);
        if (root) return root;
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');
        root.innerHTML =
            '<div class="al-card">' +
            '  <span class="al-icon">⚠️</span>' +
            '  <div class="al-spin"></div>' +
            '  <div class="al-msg"></div>' +
            '  <div class="al-bar"><i></i></div>' +
            '  <div class="al-actions"></div>' +
            '</div>';
        document.body.appendChild(root);
        return root;
    }

    function ready(fn) {
        if (document.body) { fn(); return; }
        document.addEventListener('DOMContentLoaded', fn, { once: true });
    }

    function autoLoginHref() {
        // ✅ index.html est à la RACINE du site. On compte la profondeur réelle
        //    en dossiers (on ignore le fichier .html courant), indépendamment de
        //    tout segment « admin » (cf. correctif getIndexPath dans security.js).
        var path = window.location.pathname;
        var endsWithSlash = /\/$/.test(path);
        var segs = path.split('/').filter(Boolean);
        var dirDepth = endsWithSlash ? segs.length : Math.max(0, segs.length - 1);
        return dirDepth > 0 ? new Array(dirDepth + 1).join('../') + 'index.html' : 'index.html';
    }

    // Après ~12 s sans réponse : message « Connexion lente », boutons Réessayer / Continuer (données locales).
    function armWatchdog(root) {
        clearWatchdog();
        watchdog = setTimeout(function () {
            watchdog = null;
            if (!root.classList.contains('on') || root.classList.contains('error')) return;
            root.classList.add('slow');
            root.querySelector('.al-msg').textContent = 'Connexion lente… Les données locales restent disponibles.';
            var actions = root.querySelector('.al-actions');
            actions.innerHTML = '';
            var retry = document.createElement('button');
            retry.className = 'al-btn';
            retry.textContent = 'Réessayer';
            retry.addEventListener('click', function () {
                root.classList.remove('slow');
                root.querySelector('.al-msg').textContent = 'Nouvelle tentative…';
                actions.innerHTML = '';
                armWatchdog(root);
                API.retry();
            });
            var cont = document.createElement('button');
            cont.className = 'al-btn ghost';
            cont.textContent = 'Continuer';
            cont.addEventListener('click', function () { API.hide(); });
            actions.appendChild(retry);
            actions.appendChild(cont);
        }, watchdogMs());
    }

    var API = {
        // Relance la synchronisation : reprise silencieuse (sync.js) si disponible, sinon rechargement de la page.
        retry: function () {
            if (window.AsuforSync && typeof window.AsuforSync.resync === 'function') window.AsuforSync.resync('loader-retry', { force: true });
            else window.location.reload();
        },
        show: function (message) {
            injectStyle();
            ready(function () {
                var root = buildRoot();
                root.classList.remove('error', 'slow');
                root.querySelector('.al-actions').innerHTML = '';
                root.querySelector('.al-msg').textContent = message || 'Chargement…';
                // reflow pour rejouer la transition
                void root.offsetWidth;
                root.classList.add('on');
                armWatchdog(root);
            });
            return API;
        },
        update: function (message) {
            ready(function () {
                var root = document.getElementById(ROOT_ID);
                if (root) root.querySelector('.al-msg').textContent = message || '';
            });
            return API;
        },
        hide: function () {
            clearWatchdog();
            ready(function () {
                var root = document.getElementById(ROOT_ID);
                if (root) root.classList.remove('on', 'slow');
            });
            return API;
        },
        fail: function (message, opts) {
            opts = opts || {};
            clearWatchdog();
            injectStyle();
            ready(function () {
                var root = buildRoot();
                root.classList.remove('slow');
                root.classList.add('on', 'error');
                root.querySelector('.al-msg').textContent =
                    message || 'Session expirée. Reconnexion nécessaire.';
                var actions = root.querySelector('.al-actions');
                actions.innerHTML = '';
                if (typeof opts.retry === 'function') {
                    var b = document.createElement('button');
                    b.className = 'al-btn ghost';
                    b.textContent = 'Réessayer';
                    b.addEventListener('click', function () {
                        root.classList.remove('error');
                        armWatchdog(root);
                        opts.retry();
                    });
                    actions.appendChild(b);
                }
                var a = document.createElement('a');
                a.className = 'al-btn';
                a.textContent = 'Se reconnecter';
                a.href = opts.loginHref || autoLoginHref();
                actions.appendChild(a);
            });
            return API;
        }
    };

    window.AsuforLoader = API;
})();
