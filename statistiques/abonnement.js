/* abonnement.js — Rappel de réabonnement mensuel (serveurs Google + frais de développement).
 *
 * Wave ne propose pas de prélèvement automatique : cette carte sert de rappel.
 * Elle affiche la prochaine échéance de chaque abonnement, passe à l'orange
 * quelques jours avant puis au rouge une fois la date dépassée, et ouvre le
 * lien de paiement Wave correspondant. Après le paiement, « J'ai payé »
 * enregistre la date et décale l'échéance d'un mois.
 *
 * Les dates sont gardées sur l'appareil (localStorage), par forage.
 */
(function () {
    'use strict';

    var WAVE_BASE = 'https://pay.wave.com/m/M_sn_6W-tuxFYYkZa/c/sn/?amount=';
    var PLANS = {
        serveur: { label: 'Serveur (Google)', amount: 31000, covers: ['serveur'] },
        dev:     { label: 'Frais de développement', amount: 30000, covers: ['dev'] },
        both:    { label: 'Les deux', amount: 61000, covers: ['serveur', 'dev'] }
    };
    var ITEMS = { serveur: 'Serveur (Google)', dev: 'Développement' };
    var SOON_DAYS = 5;

    function storageKey() {
        var fk = 'default';
        try { if (window.ForageContext) fk = window.ForageContext.getForageKey() || fk; } catch (e) {}
        return 'asufor_abonnement_' + fk;
    }
    function load() {
        try { return JSON.parse(localStorage.getItem(storageKey())) || {}; } catch (e) { return {}; }
    }
    function save(state) {
        try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (e) {}
    }
    function fmtMoney(n) { return n.toLocaleString('fr-FR').replace(/ | /g, ' ') + ' FCFA'; }
    function fmtDate(d) { return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
    function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
    function addMonth(d) {
        var x = new Date(d), day = x.getDate();
        x.setDate(1); x.setMonth(x.getMonth() + 1);
        var last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
        x.setDate(Math.min(day, last));
        return x;
    }
    function daysUntil(d) { return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000); }

    function statusOf(item, state) {
        var paid = state[item];
        if (!paid) return { cls: 'abo-late', text: 'Aucun paiement enregistré', due: null };
        var due = addMonth(new Date(paid));
        var n = daysUntil(due);
        if (n < 0) return { cls: 'abo-late', text: 'En retard depuis ' + (-n) + ' j (échéance ' + fmtDate(due) + ')', due: due };
        if (n === 0) return { cls: 'abo-soon', text: "À renouveler aujourd'hui", due: due };
        if (n <= SOON_DAYS) return { cls: 'abo-soon', text: 'À renouveler dans ' + n + ' j (' + fmtDate(due) + ')', due: due };
        return { cls: 'abo-ok', text: 'Payé — prochaine échéance le ' + fmtDate(due), due: due };
    }

    var selected = null;

    function render() {
        var card = document.getElementById('abonnement-card');
        if (!card) return;
        var state = load();
        var worst = 'abo-ok';
        var rows = Object.keys(ITEMS).map(function (item) {
            var s = statusOf(item, state);
            if (s.cls === 'abo-late' || (s.cls === 'abo-soon' && worst === 'abo-ok')) worst = s.cls;
            return '<div class="abo-row ' + s.cls + '"><span class="abo-dot"></span>' +
                '<span class="abo-name">' + ITEMS[item] + '</span>' +
                '<span class="abo-state">' + s.text + '</span></div>';
        }).join('');

        var plans = Object.keys(PLANS).map(function (id) {
            var p = PLANS[id];
            return '<a class="abo-plan" data-plan="' + id + '" href="' + WAVE_BASE + p.amount + '" target="_blank" rel="noopener noreferrer">' +
                '<span class="abo-plan-lbl">' + p.label + '</span>' +
                '<span class="abo-plan-amt">' + fmtMoney(p.amount) + '<small> / mois</small></span>' +
                '<i class="fa-solid fa-arrow-up-right-from-square"></i></a>';
        }).join('');

        var confirm = selected
            ? '<div class="abo-confirm"><span>Paiement « ' + PLANS[selected].label + ' » effectué sur Wave ?</span>' +
              '<button type="button" class="abo-btn-yes" data-abo="confirm">J\'ai payé</button>' +
              '<button type="button" class="abo-btn-no" data-abo="cancel">Pas encore</button></div>'
            : '';

        card.className = 'quartiers-card abonnement-card ' + worst;
        card.innerHTML =
            '<div class="card-title-soft"><i class="fa-solid fa-rotate"></i> Réabonnement mensuel</div>' +
            '<p class="abo-intro">Pour éviter toute coupure du service, renouvelez chaque mois via Wave.</p>' +
            '<div class="abo-status">' + rows + '</div>' +
            '<div class="abo-plans">' + plans + '</div>' + confirm;
    }

    function onClick(e) {
        var plan = e.target.closest('.abo-plan');
        if (plan) { selected = plan.getAttribute('data-plan'); setTimeout(render, 0); return; }
        var btn = e.target.closest('[data-abo]');
        if (!btn) return;
        if (btn.getAttribute('data-abo') === 'confirm' && selected) {
            var state = load();
            PLANS[selected].covers.forEach(function (item) {
                // Payé en avance : le nouveau mois démarre à l'échéance en cours, pas aujourd'hui
                // (sinon des jours déjà payés seraient perdus).
                var s = statusOf(item, state);
                var start = (s.due && daysUntil(s.due) > 0) ? s.due : new Date();
                state[item] = start.toISOString();
            });
            save(state);
            if (typeof window.showToast === 'function') window.showToast('Réabonnement enregistré');
        }
        selected = null;
        render();
    }

    function init() {
        var card = document.getElementById('abonnement-card');
        if (!card) return;
        card.addEventListener('click', onClick);
        render();
        // Mise à jour quotidienne si la page reste ouverte.
        setInterval(render, 60 * 60 * 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
