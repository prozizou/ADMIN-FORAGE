/**
 * compta-ui.js — Liaison Firebase + fenêtres comptables (encaissement, migration)
 * ================================================================================
 * AUCUNE règle métier ici : tous les calculs et toutes les écritures viennent de compta.js
 * (window.Compta). Ce module :
 *   • charge / écoute le grand livre du forage (factures, paiements, affectations, ajustements, soldes),
 *   • relit l'état FRAIS juste avant chaque écriture, puis applique l'objet multi-chemins en UNE fois,
 *   • affiche la fenêtre d'encaissement (montant, mode, référence, reçu, aperçu FIFO, reste après),
 *   • pilote la migration comptable (aperçu, sauvegarde téléchargée, exécution unique).
 *
 * Usage (depuis un module ES qui importe le SDK Firebase) :
 *   ComptaUI.init({ db, ref, get, update, push, onValue, P, session, getUid, basePath })
 */
(function (root) {
    'use strict';
    var C = root.Compta;
    var fb = null;               // { db, ref, get, update, push, onValue }
    var paths = null;
    var ctx = { session: {}, getUid: function () { return null; } };
    var state = null;            // état comptable normalisé (dernier chargé)
    var migration = null;        // migration_comptable/v1 (ou null)
    var listeners = [];
    var ready = false;           // grand livre entièrement chargé

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]; });
    }
    function fcfa(n) { return (Math.round(Number(n) || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' F'; }
    function cycleLabel(c) {
        if (!c) return '—';
        var p = String(c).split('-');
        var d = new Date(+p[0], +p[1] - 1, 1);
        var l = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        return l.charAt(0).toUpperCase() + l.slice(1);
    }

    function user() {
        var s = ctx.session || {};
        return { uid: ctx.getUid() || 'inconnu', nom: s.nom || s.email || s.role || null, role: s.role || 'inconnu' };
    }
    function newId() { return fb.push(fb.ref(fb.db, paths.audit)).key; }
    function isDenied(err) { return !!err && (err.code === 'PERMISSION_DENIED' || /permission/i.test(String(err.message || err))); }

    function init(o) {
        fb = { db: o.db, ref: o.ref, get: o.get, update: o.update, push: o.push, onValue: o.onValue };
        ctx.session = o.session || {};
        ctx.getUid = o.getUid || ctx.getUid;
        paths = C.pathsFor(o.basePath || String(o.P.compteurs).replace(/\/compteurs$/, ''));
        ensureStyle();
        return paths;
    }

    var Sync = function () { return root.AsuforSync || null; };
    /** get() protégé (délai maximal + nouvelles tentatives) quand sync.js est chargé. */
    function sget(r) { var y = Sync(); return y ? y.safeGet(fb.get, r) : fb.get(r); }

    /** Relit l'état comptable complet (et la migration) depuis Firebase. */
    function reload() {
        var names = ['factures', 'paiements', 'affectations', 'ajustements', 'soldes'];
        return Promise.all(names.map(function (n) { return sget(fb.ref(fb.db, paths[n])); }).concat([sget(fb.ref(fb.db, paths.migration + '/v1'))]))
            .then(function (snaps) {
                var S = {};
                names.forEach(function (n, i) { S[n] = snaps[i].exists() ? snaps[i].val() : {}; });
                state = C.normState(S);
                migration = snaps[names.length].exists() ? snaps[names.length].val() : null;
                return state;
            });
    }

    // ── Écoute continue du grand livre : états loading / ready / degraded / error, avec reprise automatique ──
    var NODES = ['factures', 'paiements', 'affectations', 'ajustements', 'soldes', 'migration'];
    var live = { S: null, got: {}, failed: {}, attempts: {}, timers: {}, unsubs: {}, hydrate: null, on: false };
    var lastInfo = { status: 'loading', failed: [] };

    function nodePath(n) { return n === 'migration' ? paths.migration + '/v1' : paths[n]; }
    function computeInfo() {
        var failed = NODES.filter(function (n) { return live.failed[n]; });
        var st = ready ? (failed.length ? 'degraded' : 'ready') : (failed.length ? 'error' : 'loading');
        return { status: st, failed: failed };
    }
    function fire() {
        state = C.normState(live.S);
        // ready reste vrai une fois le grand livre reçu en entier : une panne ultérieure d'un nœud donne « degraded »
        // (les données affichées restent valables ; toute écriture relit l'état frais).
        if (NODES.every(function (n) { return live.got[n]; })) ready = true;
        lastInfo = computeInfo();
        listeners.forEach(function (f) { try { f(state, migration, ready, lastInfo); } catch (e) { console.error(e); } });
    }
    function setNode(n, snap) {
        if (n === 'migration') migration = snap.exists() ? snap.val() : null;
        else live.S[n] = snap.val() || {};
        live.got[n] = true; live.failed[n] = false; live.attempts[n] = 0;
    }
    function scheduleRetry(n) {
        clearTimeout(live.timers[n]);
        var k = live.attempts[n] = (live.attempts[n] || 0) + 1;
        var wait = Math.min(30000, 1500 * Math.pow(2, k - 1)) * (root.__ASUFOR_SYNC && root.__ASUFOR_SYNC.fast ? 0.02 : 1);
        live.timers[n] = setTimeout(function () { attach(n); }, wait);
    }
    function attach(n) {
        clearTimeout(live.timers[n]);
        var un;
        var onErr = function (err) {
            console.error('[Compta] lecture ' + n + ' :', err && err.code);
            live.failed[n] = true; fire(); scheduleRetry(n);
        };
        try {
            un = fb.onValue(fb.ref(fb.db, nodePath(n)), function (snap) { setNode(n, snap); fire(); }, onErr);
        } catch (e) { onErr(e); return; }
        var y = Sync();
        if (y) y.track('compta:' + n, un); else { if (live.unsubs[n]) { try { live.unsubs[n](); } catch (_) {} } live.unsubs[n] = un; }
    }
    /** Filet de sécurité : si un nœud n'a rien reçu au bout de quelques secondes, lecture directe protégée. */
    function hydrateMissing() {
        NODES.filter(function (n) { return !live.got[n]; }).forEach(function (n) {
            sget(fb.ref(fb.db, nodePath(n))).then(function (snap) {
                if (live.got[n]) return;
                setNode(n, snap); fire();
            }, function () { live.failed[n] = true; fire(); });
        });
    }
    function subscribe(cb) {
        if (cb) {
            listeners.push(cb);
            if (live.on) { try { cb(state || C.emptyState(), migration, ready, lastInfo); } catch (e) { console.error(e); } }
        }
        if (live.on) return;
        live.on = true;
        live.S = C.emptyState();
        NODES.forEach(attach);
        var y = Sync();
        if (y) y.onResync(function (why) { return restart(why === 'reconnect' || why === 'pageshow-bfcache' || why === 'visible' || why === 'loader-retry' || why === 'badge'); });
        var ms = (root.__ASUFOR_SYNC && root.__ASUFOR_SYNC.hydrate) || 6000;
        live.hydrate = setTimeout(function () { if (!ready) hydrateMissing(); }, ms);
    }
    /**
     * Relance l'écoute : nœuds en échec ou jamais reçus toujours ; tous les nœuds si `force` (retour d'arrière-plan,
     * reconnexion) pour éviter les listeners zombies. L'état affiché n'est jamais vidé.
     */
    function restart(force) {
        if (!live.on) return Promise.resolve();
        NODES.forEach(function (n) { if (force || live.failed[n] || !live.got[n]) attach(n); });
        if (!ready) hydrateMissing();
        return Promise.resolve();
    }
    function retry() { return restart(true); }
    function getStatus() { return lastInfo; }

    function getState() { return state || C.emptyState(); }
    function isReady() { return ready; }
    function getMigration() { return migration; }
    function isMigrated() { return !!(migration && migration.statut === 'terminee'); }
    function canCollect() { var r = (ctx.session || {}).role; return r === 'président' || r === 'trésorier'; }
    function isPresident() { return (ctx.session || {}).role === 'président'; }

    /**
     * Exécute une opération comptable : relit l'état frais, construit les écritures avec compta.js,
     * les applique en une fois. build(S) doit renvoyer { updates, ... }.
     */
    function run(build) {
        return reload().then(function (S) {
            var r = build(S, { paths: paths, user: user(), now: new Date().toISOString(), newId: newId });
            if (!r || !r.updates || !Object.keys(r.updates).length) return r;
            return fb.update(fb.ref(fb.db), r.updates).then(function () { return reload().then(function () { return r; }); });
        }).catch(function (err) {
            if (isDenied(err)) {
                var e = new Error("Opération refusée : droits insuffisants, ou les données de ce client viennent d'être modifiées par un autre utilisateur. Rechargez puis réessayez.");
                e.cause = err; throw e;
            }
            throw err;
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Styles & fenêtre modale générique
    // ─────────────────────────────────────────────────────────────
    function ensureStyle() {
        if (typeof document === 'undefined' || document.getElementById('compta-ui-style')) return;
        var st = document.createElement('style');
        st.id = 'compta-ui-style';
        st.textContent = [
            '.cui-ov{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;padding:12px;font-family:inherit}',
            '@media(min-width:600px){.cui-ov{align-items:center}}',
            '.cui-box{background:var(--surface,#fff);color:var(--text-main,#0f172a);width:100%;max-width:460px;max-height:92vh;overflow:auto;border-radius:18px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.3)}',
            '.cui-box h3{margin:0 0 4px;font-size:1.1rem}',
            '.cui-sub{color:var(--text-sub,#64748b);font-size:.85rem;margin:0 0 14px}',
            '.cui-box label{display:block;font-size:.8rem;font-weight:600;color:var(--text-sub,#475569);margin:10px 0 4px}',
            '.cui-box input,.cui-box select,.cui-box textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--border,#cbd5e1);border-radius:10px;font-size:1rem;background:var(--surface,#fff);color:inherit}',
            '.cui-row{display:flex;gap:10px}.cui-row>div{flex:1}',
            '.cui-due{display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:.88rem;background:var(--bg,#f1f5f9);border-radius:12px;padding:10px 12px;margin-bottom:6px}',
            '.cui-due b{text-align:right}',
            '.cui-prev{margin-top:12px;border:1px dashed var(--border,#cbd5e1);border-radius:12px;padding:10px 12px;font-size:.86rem}',
            '.cui-prev ul{margin:6px 0;padding-left:18px}',
            '.cui-prev .ok{color:#15803d;font-weight:600}.cui-prev .warn{color:#b45309;font-weight:600}',
            '.cui-err{color:#b91c1c;font-size:.86rem;min-height:1.2em;margin-top:8px}',
            '.cui-act{display:flex;gap:10px;margin-top:14px}',
            '.cui-act button{flex:1;padding:13px;border-radius:12px;border:0;font-size:.98rem;font-weight:600;cursor:pointer}',
            '.cui-primary{background:#0439a0;color:#fff}.cui-primary:disabled{opacity:.55;cursor:wait}',
            '.cui-ghost{background:var(--bg,#e2e8f0);color:inherit}',
            '.cui-banner{display:flex;gap:10px;align-items:center;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;border-radius:12px;padding:10px 12px;margin:10px 0;font-size:.88rem}',
            '.cui-banner button{margin-left:auto;background:#c2410c;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}'
        ].join('\n');
        document.head.appendChild(st);
    }

    function modal(html) {
        var ov = document.createElement('div');
        ov.className = 'cui-ov';
        ov.setAttribute('role', 'dialog');
        ov.setAttribute('aria-modal', 'true');
        ov.innerHTML = '<div class="cui-box">' + html + '</div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
        return { el: ov, close: close, q: function (s) { return ov.querySelector(s); } };
    }

    function defaultRecu() {
        var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
        return 'R' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // ─────────────────────────────────────────────────────────────
    // Fenêtre d'encaissement
    // ─────────────────────────────────────────────────────────────
    /**
     * @param {object} o - { compteurId, releve (relevé courant ou null), client, numero, recuUrl(pid), onDone(result) }
     */
    function openPaymentDialog(o) {
        if (!canCollect()) { alert("Seuls le président et le trésorier peuvent encaisser."); return; }
        if (!isMigrated()) { alert("La migration comptable doit d'abord être effectuée par le président."); return; }
        var S0 = getState();
        var du = C.amountDueNow(S0, o.compteurId, o.releve);
        var modes = C.MODES.map(function (m) { return '<option value="' + m + '">' + esc(C.MODES_LABEL[m]) + '</option>'; }).join('');
        var m = modal(
            '<h3>Encaisser</h3>' +
            '<p class="cui-sub">' + esc(o.client || '') + (o.numero ? ' — compteur n°' + esc(o.numero) : '') + '</p>' +
            '<div class="cui-due">' +
            '<span>Arriérés (factures échues)</span><b>' + fcfa(du.arrieres) + '</b>' +
            (du.facture_provisoire ? '<span>Relevé du mois (facturé à la clôture)</span><b>' + fcfa(du.facture_provisoire) + '</b>' : '') +
            (du.avance ? '<span>Avance disponible</span><b>− ' + fcfa(du.avance) + '</b>' : '') +
            '<span><strong>Total dû</strong></span><b>' + fcfa(du.total_du) + '</b>' +
            '</div>' +
            '<div class="cui-row"><div><label for="cui-montant">Montant encaissé (F)</label><input id="cui-montant" type="number" inputmode="numeric" min="1" step="1" value="' + (du.total_du || '') + '"></div>' +
            '<div><label for="cui-mode">Mode</label><select id="cui-mode">' + modes + '</select></div></div>' +
            '<div class="cui-row"><div><label for="cui-recu">N° de reçu</label><input id="cui-recu" type="text" maxlength="40" value="' + esc(defaultRecu()) + '"></div>' +
            '<div><label for="cui-ref">Référence (facultatif)</label><input id="cui-ref" type="text" maxlength="60" placeholder="ex. ID transaction"></div></div>' +
            '<div class="cui-prev" id="cui-prev"></div>' +
            '<div class="cui-err" id="cui-err" role="alert"></div>' +
            '<div class="cui-act"><button type="button" class="cui-ghost" id="cui-cancel">Annuler</button><button type="button" class="cui-primary" id="cui-ok">Valider l\'encaissement</button></div>'
        );
        function inputs() {
            return {
                montant: Number(m.q('#cui-montant').value), mode: m.q('#cui-mode').value,
                numero_recu: m.q('#cui-recu').value, reference: m.q('#cui-ref').value
            };
        }
        function preview() {
            var v = inputs(), box = m.q('#cui-prev');
            m.q('#cui-err').textContent = '';
            if (!(v.montant > 0)) { box.innerHTML = '<span class="warn">Saisissez un montant.</span>'; return; }
            try {
                var r = C.buildPaymentOps(getState(), Object.assign({}, v, {
                    paths: paths, compteurId: o.compteurId, releve: o.releve, user: user(), now: new Date().toISOString(),
                    newId: function () { return 'apercu'; }, numero_recu: v.numero_recu || 'apercu'
                }));
                var restant = Math.max(0, r.apres.arrieres + du.facture_provisoire - r.apres.avance);
                var lines = r.affectations.map(function (a) {
                    return '<li>' + esc(cycleLabel(a.cycle)) + ' : <b>' + fcfa(a.montant) + '</b>' + (a.reste_apres > 0 ? ' <span class="warn">(reste ' + fcfa(a.reste_apres) + ')</span>' : ' <span class="ok">soldée</span>') + '</li>';
                }).join('');
                box.innerHTML = '<strong>Aperçu</strong>' +
                    (lines ? '<ul>' + lines + '</ul>' : '<div>Aucune facture échue à régler.</div>') +
                    (r.avance > 0 ? '<div class="ok">Avance créée : ' + fcfa(r.avance) + (du.facture_provisoire ? ' (réglera le relevé du mois à la clôture)' : '') + '</div>' : '') +
                    '<div style="margin-top:6px">Reste dû après paiement : <b>' + fcfa(restant) + '</b></div>';
            } catch (e) {
                box.innerHTML = '';
                m.q('#cui-err').textContent = e.message;
            }
        }
        ['#cui-montant', '#cui-mode', '#cui-recu'].forEach(function (s) { m.q(s).addEventListener('input', preview); });
        m.q('#cui-cancel').addEventListener('click', m.close);
        m.q('#cui-ok').addEventListener('click', function () {
            var btn = m.q('#cui-ok'), v = inputs();
            if (v.montant > du.total_du * 3 && du.total_du > 0 && !confirm('Le montant saisi (' + fcfa(v.montant) + ') est très supérieur au total dû (' + fcfa(du.total_du) + '). Confirmer ?')) return;
            btn.disabled = true; m.q('#cui-err').textContent = '';
            run(function (S, base) {
                return C.buildPaymentOps(S, Object.assign({}, base, v, { compteurId: o.compteurId, releve: o.releve, client: o.client }));
            }).then(function (r) {
                var box = m.el.querySelector('.cui-box');
                box.innerHTML = '<h3>✅ Encaissement enregistré</h3>' +
                    '<p class="cui-sub">' + fcfa(v.montant) + ' — reçu n°' + esc(v.numero_recu) + '</p>' +
                    (r.avance > 0 ? '<p>Avance : <b>' + fcfa(r.avance) + '</b></p>' : '') +
                    '<p>Arriérés restants : <b>' + fcfa(r.apres.arrieres) + '</b></p>' +
                    '<div class="cui-act"><button type="button" class="cui-ghost" id="cui-close">Fermer</button>' +
                    (o.recuUrl ? '<button type="button" class="cui-primary" id="cui-print">Imprimer le reçu</button>' : '') + '</div>';
                box.querySelector('#cui-close').addEventListener('click', m.close);
                var pb = box.querySelector('#cui-print');
                if (pb) pb.addEventListener('click', function () { window.open(o.recuUrl(r.paiementId), '_blank'); });
                if (o.onDone) o.onDone(r);
            }, function (err) {
                btn.disabled = false;
                m.q('#cui-err').textContent = err.message || String(err);
            });
        });
        preview();
        setTimeout(function () { var i = m.q('#cui-montant'); if (i) { i.focus(); i.select(); } }, 60);
    }

    // ─────────────────────────────────────────────────────────────
    // Migration comptable (président)
    // ─────────────────────────────────────────────────────────────
    function downloadJson(obj, name) {
        var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function openMigrationDialog(o) {
        if (!isPresident()) { alert('Seul le président peut lancer la migration comptable.'); return; }
        var base = paths.compteurs.replace(/\/compteurs$/, '');
        var m = modal('<h3>Migration comptable</h3><p class="cui-sub">Chargement de l\'aperçu…</p>');
        Promise.all([reload(), fb.get(fb.ref(fb.db, paths.backup)), fb.get(fb.ref(fb.db, paths.compteurs))]).then(function (res) {
            if (isMigrated()) { m.el.querySelector('.cui-box').innerHTML = '<h3>Migration déjà effectuée</h3><div class="cui-act"><button class="cui-ghost" id="x">Fermer</button></div>'; m.q('#x').onclick = m.close; return; }
            var backup = res[1].exists() ? res[1].val() : {};
            var compteurs = res[2].exists() ? res[2].val() : {};
            var pre = C.buildMigrationOps(res[0], { paths: paths, backup: backup, compteurs: compteurs, now: new Date().toISOString(), user: user(), newId: function () { return 'apercu'; } }).resume;
            var cyc = Object.keys(pre.par_cycle || {}).sort().map(function (c) { return '<li>' + esc(cycleLabel(c)) + ' : <b>' + fcfa(pre.par_cycle[c]) + '</b></li>'; }).join('');
            var saved = false;
            m.el.querySelector('.cui-box').innerHTML =
                '<h3>Migration comptable</h3>' +
                '<p class="cui-sub">Les dettes réellement impayées des archives deviennent des factures (« migration_backup »). Aucun paiement n\'est inventé ; les archives ne sont pas modifiées.</p>' +
                '<div class="cui-due"><span>Arriérés retrouvés</span><b>' + fcfa(pre.total_arrieres) + '</b>' +
                '<span>Factures créées</span><b>' + pre.nb_factures_migrees + '</b><span>Compteurs concernés</span><b>' + pre.nb_compteurs + '</b>' +
                '<span>Relevés en anomalie exclus</span><b>' + pre.anomalies_exclues + '</b></div>' +
                (cyc ? '<div class="cui-prev"><strong>Par mois</strong><ul>' + cyc + '</ul></div>' : '') +
                (pre.releves_marques_payes ? '<div class="cui-prev"><span class="warn">⚠️ ' + pre.releves_marques_payes + ' relevé(s) du mois en cours sont marqués « payé » sans paiement enregistré. Aucun paiement ne sera inventé : ils seront facturés à la clôture ; saisissez leurs encaissements (avec reçu) après la migration.</span></div>' : '') +
                '<div class="cui-err" id="cui-err" role="alert"></div>' +
                '<div class="cui-act"><button class="cui-ghost" id="cui-save">1. Télécharger la sauvegarde</button><button class="cui-primary" id="cui-run" disabled>2. Lancer la migration</button></div>' +
                '<div class="cui-act"><button class="cui-ghost" id="cui-cancel">Annuler</button></div>';
            m.q('#cui-cancel').onclick = m.close;
            m.q('#cui-save').onclick = function () {
                fb.get(fb.ref(fb.db, base)).then(function (snap) {
                    downloadJson({ meta: { type: 'sauvegarde_avant_migration_comptable', date: new Date().toISOString(), forage: base }, donnees: snap.val() }, 'sauvegarde-avant-migration-' + base.replace(/\//g, '_') + '-' + new Date().toISOString().slice(0, 10) + '.json');
                    saved = true; m.q('#cui-run').disabled = false; m.q('#cui-save').textContent = '✓ Sauvegarde téléchargée';
                }, function (e) { m.q('#cui-err').textContent = 'Sauvegarde impossible : ' + (e.code || e.message); });
            };
            m.q('#cui-run').onclick = function () {
                if (!saved) return;
                if (!confirm('Lancer la migration comptable ? Elle ne peut être exécutée qu\'une seule fois.')) return;
                m.q('#cui-run').disabled = true;
                fb.get(fb.ref(fb.db, paths.backup)).then(function (bs) {
                    return fb.get(fb.ref(fb.db, paths.compteurs)).then(function (cs) {
                        return run(function (S, b) { return C.buildMigrationOps(S, Object.assign({}, b, { backup: bs.exists() ? bs.val() : {}, compteurs: cs.exists() ? cs.val() : {} })); });
                    });
                }).then(function (r) {
                    m.el.querySelector('.cui-box').innerHTML = '<h3>✅ Migration effectuée</h3><p>' + r.resume.nb_factures_migrees + ' facture(s), ' + fcfa(r.resume.total_arrieres) + ' d\'arriérés.</p><div class="cui-act"><button class="cui-primary" id="x">Fermer</button></div>';
                    m.q('#x').onclick = m.close;
                    if (o && o.onDone) o.onDone(r);
                }, function (e) { m.q('#cui-err').textContent = e.message; m.q('#cui-run').disabled = false; });
            };
        }, function (e) { m.el.querySelector('.cui-box').innerHTML = '<h3>Erreur</h3><p>' + esc(e.message) + '</p>'; });
    }

    /** Bandeau « migration requise » (président : bouton ; autres : information). */
    function migrationBanner(container, onDone) {
        if (!container) return;
        container.innerHTML = '';
        if (isMigrated()) { container.style.display = 'none'; return; }
        container.style.display = '';
        var d = document.createElement('div');
        d.className = 'cui-banner';
        d.innerHTML = isPresident()
            ? '<span>⚠️ Comptabilité à initialiser : les arriérés historiques doivent être migrés avant tout encaissement.</span><button type="button">Migrer</button>'
            : '<span>⚠️ Comptabilité en attente d\'initialisation par le président : les encaissements sont momentanément bloqués.</span>';
        container.appendChild(d);
        var b = d.querySelector('button');
        if (b) b.addEventListener('click', function () { openMigrationDialog({ onDone: onDone }); });
    }

    root.ComptaUI = {
        init: init, reload: reload, subscribe: subscribe, run: run, retry: retry, restart: restart, getStatus: getStatus,
        getState: getState, isReady: isReady, getMigration: getMigration, isMigrated: isMigrated,
        canCollect: canCollect, isPresident: isPresident, user: user, newId: newId,
        openPaymentDialog: openPaymentDialog, openMigrationDialog: openMigrationDialog, migrationBanner: migrationBanner,
        modal: modal, fcfa: fcfa, esc: esc, cycleLabel: cycleLabel, paths: function () { return paths; }
    };
})(typeof window !== 'undefined' ? window : this);
