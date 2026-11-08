/* abonnement.js — Rappel de réabonnement mensuel (serveurs Google + frais de développement).
 *
 * La carte n'apparaît que du 1er au 12 de chaque mois, tant que le mois n'est pas
 * marqué payé dans Firebase :
 *
 *     Asufor/{forageKey}/abonnement/{AAAA-MM} : false   → carte affichée
 *     Asufor/{forageKey}/abonnement/{AAAA-MM} : true    → carte masquée
 *
 * Le nœud du mois est créé automatiquement à false à la première ouverture ; l'administrateur
 * le passe à true (console Firebase) une fois le paiement Wave reçu. Les règles
 * n'autorisent les membres du forage qu'à créer ce nœud à false, jamais à le passer à true.
 *
 * Couleurs : du 1er au 5 vert clair, du 6 au 9 jaune, du 10 au 12 rouge.
 */
(function () {
    'use strict';

    var WAVE_BASE = 'https://pay.wave.com/m/M_sn_6W-tuxFYYkZa/c/sn/?amount=';
    var PLANS = [
        { label: 'Serveur (Google)', amount: 31000 },
        { label: 'Frais de développement', amount: 30000 },
        { label: 'Les deux', amount: 61000 }
    ];
    var LAST_DAY = 12;

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
    function fmtMoney(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA'; }
    function level(day) { return day <= 5 ? 'abo-ok' : (day <= 9 ? 'abo-soon' : 'abo-late'); }

    function message(day) {
        var left = LAST_DAY - day;
        if (day <= 5) return 'Pensez à renouveler l\'abonnement de ce mois avant le ' + LAST_DAY + '.';
        if (day <= 9) return 'Abonnement du mois non réglé — il reste ' + left + ' jours avant le ' + LAST_DAY + '.';
        return left > 0
            ? 'Urgent : abonnement non réglé, risque de coupure du service dans ' + left + ' jour' + (left > 1 ? 's' : '') + '.'
            : 'Urgent : abonnement non réglé, risque de coupure du service dès demain.';
    }

    function render(card, now) {
        var day = now.getDate();
        var mois = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        card.className = 'quartiers-card abonnement-card ' + level(day);
        card.innerHTML =
            '<div class="card-title-soft"><i class="fa-solid fa-rotate"></i> Réabonnement — ' + mois + '</div>' +
            '<p class="abo-intro">' + message(day) + '</p>' +
            '<div class="abo-plans">' + PLANS.map(function (p) {
                return '<a class="abo-plan" href="' + WAVE_BASE + p.amount + '" target="_blank" rel="noopener noreferrer">' +
                    '<span class="abo-plan-lbl">' + p.label + '</span>' +
                    '<span class="abo-plan-amt">' + fmtMoney(p.amount) + '<small> / mois</small></span>' +
                    '<i class="fa-solid fa-arrow-up-right-from-square"></i></a>';
            }).join('') + '</div>' +
            '<p class="abo-note">La carte disparaît dès que le paiement est validé par l\'administrateur.</p>';
        card.hidden = false;
    }

    /**
     * @param {object} deps - { db, ref, onValue, set, basePath }
     */
    function init(deps) {
        var card = document.getElementById('abonnement-card');
        if (!card || !deps || !deps.basePath) return;
        var unsubscribe = null, currentKey = null;

        function refresh() {
            var now = new Date();
            if (now.getDate() > LAST_DAY) {
                card.hidden = true;
                if (unsubscribe) { unsubscribe(); unsubscribe = null; currentKey = null; }
                return;
            }
            var key = monthKey(now);
            if (key === currentKey) { if (!card.hidden) render(card, now); return; }
            if (unsubscribe) unsubscribe();
            currentKey = key;
            var r = deps.ref(deps.db, deps.basePath + '/abonnement/' + key);
            unsubscribe = deps.onValue(r, function (snap) {
                var val = snap.val();
                if (val === true) { card.hidden = true; return; }
                if (val === null) {
                    // Premier passage du mois : on crée le nœud à false pour l'administrateur.
                    deps.set(r, false).catch(function (e) { console.warn('[Abonnement] création du nœud impossible', e); });
                }
                render(card, new Date());
            }, function (err) {
                // Lecture impossible : par prudence, on garde le rappel visible.
                console.warn('[Abonnement] lecture impossible', err);
                render(card, new Date());
            });
        }

        refresh();
        setInterval(refresh, 60 * 60 * 1000);   // passage au jour / mois suivant si la page reste ouverte
    }

    window.AsuforAbonnement = { init: init, _level: level, _monthKey: monthKey };
})();
