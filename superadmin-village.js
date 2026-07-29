/**
 * superadmin-village.js — Sélecteur de village pour la vue à 360° du super-admin.
 * =================================================================================
 *
 * Insère une barre en haut de page permettant au super-admin de choisir le
 * village (forage) à consulter/gérer sur les pages opérationnelles existantes
 * (Agent, Compteur, Statistiques, Rapports, Impression), exactement comme s'il
 * était président de ce village. Ne fait rien pour les autres rôles.
 *
 * Le changement de village persiste le choix (forage-context.js,
 * setSuperadminForageKey) puis recharge la page pour que toutes les lectures
 * Firebase déjà résolues via window.ForageContext.paths() pointent vers le
 * nouveau village.
 *
 * Usage, depuis le <script type="module"> de chaque page (après avoir obtenu
 * `session`, `db`, et les fonctions Firebase `get`/`ref`) :
 *
 *   if (window.SuperadminVillage) {
 *       window.SuperadminVillage.init({ db, get, ref, session });
 *   }
 */
(function (root, factory) {
    var api = factory();
    if (root) root.SuperadminVillage = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    function injectStyles() {
        if (document.getElementById('sv-style')) return;
        var style = document.createElement('style');
        style.id = 'sv-style';
        style.textContent =
            '.sv-bar{position:sticky;top:0;z-index:9999;display:flex;align-items:center;' +
            'flex-wrap:wrap;gap:10px;padding:10px 16px;background:rgba(168,85,247,0.14);' +
            'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
            'border-bottom:1px solid rgba(168,85,247,0.35);' +
            'font-family:"Segoe UI",system-ui,sans-serif;font-size:0.8rem;color:#f8fafc;}' +
            '.sv-bar .sv-label{font-weight:700;color:#c084fc;white-space:nowrap;}' +
            '.sv-bar select{flex:1;min-width:160px;max-width:280px;padding:8px 10px;' +
            'border-radius:8px;background:#1e293b;color:#fff;' +
            'border:1px solid rgba(168,85,247,0.4);font-size:0.82rem;}';
        document.head.appendChild(style);
    }

    function buildBar() {
        var bar = document.createElement('div');
        bar.className = 'sv-bar';
        bar.id = 'sv-bar';
        bar.innerHTML =
            '<span class="sv-label">🏘️ Super-admin — Village consulté :</span>' +
            '<select id="sv-select" aria-label="Choisir le village à consulter">' +
            '<option value="">Chargement…</option></select>';
        return bar;
    }

    function init(opts) {
        var db      = opts && opts.db;
        var get     = opts && opts.get;
        var ref     = opts && opts.ref;
        var session = opts && opts.session;
        if (!session || !session.isSuperadmin || !db || !get || !ref) return;
        if (document.getElementById('sv-bar')) return; // déjà initialisé

        injectStyles();
        var bar = buildBar();
        document.body.insertBefore(bar, document.body.firstChild);
        var select = document.getElementById('sv-select');

        get(ref(db, 'Asufor')).then(function (snap) {
            var forages = snap.exists() ? snap.val() : {};
            var keys = Object.keys(forages);
            if (keys.length === 0) {
                select.innerHTML = '<option value="">Aucun village créé</option>';
                return;
            }
            var current = window.ForageContext.getForageKey();
            select.innerHTML = keys.map(function (key) {
                var cfg = forages[key] && forages[key].config;
                var nom = (cfg && cfg.nom) || key;
                return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' +
                    window.escHtml(nom) + '</option>';
            }).join('');
            select.addEventListener('change', function () {
                window.ForageContext.setSuperadminForageKey(select.value);
                location.reload();
            });
        }).catch(function (e) {
            console.error('[ASUFOR] SuperadminVillage : chargement des villages échoué', e);
            select.innerHTML = '<option value="">Erreur de chargement</option>';
        });
    }

    return { init: init };
});
