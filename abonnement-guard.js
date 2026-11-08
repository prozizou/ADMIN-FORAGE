/* abonnement-guard.js — Blocage de l'application quand l'abonnement mensuel n'est pas réglé.
 *
 * Nœud Firebase : Asufor/{forageKey}/abonnement/{AAAA-MM} (booléen, géré par le super-admin).
 *
 * L'application est bloquée (écran plein, aucune navigation possible) quand :
 *   • on est après le 12 du mois et le mois courant n'est pas à true, OU
 *   • le mois précédent est explicitement à false (impayé reporté).
 * Du 1er au 12, seul le rappel de la page Statistiques s'affiche (pas de blocage).
 *
 * Le super-admin n'est jamais bloqué. La dernière décision est mémorisée sur l'appareil,
 * pour bloquer aussi hors connexion et sans clignotement au chargement.
 * Dès que le super-admin repasse le mois à true, l'écran disparaît de lui-même.
 */
(function () {
    'use strict';

    var LAST_DAY = 12;
    var SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';
    var WAVE_BASE = 'https://pay.wave.com/m/M_sn_6W-tuxFYYkZa/c/sn/?amount=';
    var PLANS = [
        { label: 'Serveur (Google)', amount: 31000 },
        { label: 'Motivation du développeur', amount: 30000 },
        { label: 'Les deux', amount: 61000 }
    ];

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
    function prevMonthKey(d) { return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)); }

    /** @param {object|null} nodes - contenu de abonnement/ ({ 'AAAA-MM': bool }) */
    function isBlocked(nodes, now) {
        nodes = nodes || {};
        if (nodes[prevMonthKey(now)] === false) return true;
        return now.getDate() > LAST_DAY && nodes[monthKey(now)] !== true;
    }

    var api = { isBlocked: isBlocked, monthKey: monthKey, prevMonthKey: prevMonthKey, LAST_DAY: LAST_DAY };
    window.AsuforAbonnementGuard = api;

    // ── Contexte : qui est connecté, sur quel forage ? ──
    var session = null;
    try { session = JSON.parse(localStorage.getItem('asufor_session') || 'null'); } catch (e) {}
    if (!session || session.isSuperadmin || !window.ForageContext) return;   // super-admin exempté
    var forageKey = session.forageKey || window.ForageContext.getForageKey();
    if (!forageKey) return;
    var CACHE_KEY = 'asufor_abo_nodes_' + forageKey;

    // ── Écran de blocage ──
    var overlay = null;
    function fmtMoney(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA'; }

    function buildOverlay() {
        var css = document.createElement('style');
        css.textContent =
            '#abo-block{position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.92);display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
            '#abo-block .abo-box{background:#fff;border-radius:20px;max-width:420px;width:100%;padding:22px 20px;box-shadow:0 20px 50px rgba(0,0,0,.35);color:#1e293b;max-height:100%;overflow:auto}' +
            '#abo-block h2{margin:0 0 6px;font-size:1.1rem;color:#b91c1c}' +
            '#abo-block p{margin:0 0 14px;font-size:.88rem;line-height:1.4;color:#334155}' +
            '#abo-block a.abo-pay{display:flex;justify-content:space-between;gap:10px;text-decoration:none;color:#1e293b;border:1px solid #cbd5e1;border-radius:12px;padding:11px 13px;margin-bottom:8px;font-weight:700;font-size:.86rem}' +
            '#abo-block a.abo-pay:last-of-type{border-color:#1dc8f2;background:rgba(29,200,242,.1)}' +
            '#abo-block .abo-foot{font-size:.74rem;color:#64748b;margin:10px 0 12px}' +
            '#abo-block button{width:100%;border:0;border-radius:12px;padding:11px;font-weight:700;background:#e2e8f0;color:#334155;cursor:pointer}' +
            'html.abo-locked,html.abo-locked body{overflow:hidden!important}';
        document.head.appendChild(css);

        overlay = document.createElement('div');
        overlay.id = 'abo-block';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML =
            '<div class="abo-box">' +
            '<h2>🔒 Accès suspendu</h2>' +
            '<p>L\'abonnement mensuel (serveur et motivation du développeur) n\'est pas réglé. ' +
            'L\'application est bloquée jusqu\'à validation du paiement.</p>' +
            PLANS.map(function (p) {
                return '<a class="abo-pay" href="' + WAVE_BASE + p.amount + '" target="_blank" rel="noopener noreferrer">' +
                    '<span>' + p.label + '</span><span>' + fmtMoney(p.amount) + '</span></a>';
            }).join('') +
            '<p class="abo-foot">Après le paiement Wave, l\'accès revient automatiquement dès que l\'administrateur l\'a validé.</p>' +
            '<button type="button" id="abo-logout">Se déconnecter</button>' +
            '</div>';
        overlay.querySelector('#abo-logout').addEventListener('click', function () {
            if (typeof window.logout === 'function') window.logout();
        });
        // Aucune interaction avec la page derrière l'écran.
        ['keydown', 'keyup', 'keypress'].forEach(function (t) {
            document.addEventListener(t, function (e) {
                if (overlay && overlay.isConnected && !overlay.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
            }, true);
        });
    }

    function apply(blocked) {
        var go = function () {
            if (blocked) {
                if (!overlay) buildOverlay();
                if (!overlay.isConnected) document.body.appendChild(overlay);
                document.documentElement.classList.add('abo-locked');
            } else if (overlay && overlay.isConnected) {
                overlay.remove();
                document.documentElement.classList.remove('abo-locked');
            }
        };
        if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
    }

    var nodes = null;
    try { nodes = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
    function evaluate() { if (nodes) apply(isBlocked(nodes, new Date())); }
    evaluate();                                   // décision mémorisée : immédiate, même hors connexion
    setInterval(evaluate, 30 * 60 * 1000);        // passage au 13 / au mois suivant, page ouverte

    // ── Lecture en direct depuis Firebase ──
    if (!window.ASUFOR_FIREBASE_CONFIG) return;
    Promise.all([
        import(SDK + 'firebase-app.js'),
        import(SDK + 'firebase-auth.js'),
        import(SDK + 'firebase-database.js')
    ]).then(function (m) {
        var appMod = m[0], authMod = m[1], dbMod = m[2];
        // Même configuration → même application que celle de la page (pas de double instance).
        var app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(window.ASUFOR_FIREBASE_CONFIG);
        var auth = authMod.getAuth(app);
        var db = dbMod.getDatabase(app);
        var stop = null;
        authMod.onAuthStateChanged(auth, function (user) {
            if (stop) { stop(); stop = null; }
            if (!user) return;
            stop = dbMod.onValue(dbMod.ref(db, 'Asufor/' + forageKey + '/abonnement'), function (snap) {
                nodes = snap.val() || {};
                try { localStorage.setItem(CACHE_KEY, JSON.stringify(nodes)); } catch (e) {}
                evaluate();
            }, function (err) {
                console.warn('[Abonnement] lecture impossible, dernière décision conservée', err);
            });
        });
    }).catch(function (e) { console.warn('[Abonnement] SDK Firebase indisponible', e); });
})();
