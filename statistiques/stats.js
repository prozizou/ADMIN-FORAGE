import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, goOffline, goOnline, ref, onValue, update, get, push, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ✅ CORRECTION : utiliser la config Firebase centralisée (firebase-config.js chargé dans stats.html)
const firebaseConfig = window.ASUFOR_FIREBASE_CONFIG;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
// ✅ Chemins Firebase du forage courant, résolus dynamiquement (namespacé Asufor/{forageKey}/…)
const P = window.ForageContext.paths();
// ✅ Lecture protégée (délai maximal + nouvelles tentatives, voir sync.js) : plus de chargement infini.
const sget = (r) => window.AsuforSync ? window.AsuforSync.safeGet(get, r) : get(r);
const Sync = window.AsuforSync || null;
const STATS_BUILD = 'v87';
const liveSources = {};
console.info('[ASUFOR] Statistiques ' + STATS_BUILD);

// Chaque source d'affichage est écoutée immédiatement, sans attendre un get() ni multiplier les essais.
function watchStatsSource(key, path, onSnapshot, force, target) {
    const previous = liveSources[key];
    if (previous && !previous.stopped && previous.path === path && previous.status !== 'error' && !force) return previous;
    if (Sync) Sync.untrack('stats:' + key);
    else if (previous) previous.stop();
    const source = liveSources[key] = { path, status: 'pending', receivedAt: null, connectedAtReceive: null, errorCode: null, stopped: false };
    let unsubscribe = () => {};
    const report = () => { if (Sync && Sync.reportSource) Sync.reportSource('stats:' + key, requiredStatsSources().includes(key) ? source.status : null); scheduleStatisticsRender(); };
    const delay = (window.__ASUFOR_SYNC && window.__ASUFOR_SYNC.sourceWatchdog) || 12000;
    const timer = setTimeout(() => {
        if (!source.stopped && source.status === 'pending') { source.status = 'slow'; report(); }
    }, delay);
    source.stop = () => {
        source.stopped = true;
        clearTimeout(timer);
        unsubscribe();
        if (key !== 'config' && Sync && Sync.reportSource) Sync.reportSource('stats:' + key, null);
    };
    const fail = error => {
        if (source.stopped || liveSources[key] !== source) return;
        source.status = 'error'; source.errorCode = String(error.code || 'READ_ERROR');
        clearTimeout(timer);
        console.error('[Statistiques] ' + key + ' : ' + source.errorCode);
        report();
    };
    report();
    try {
        unsubscribe = onValue(target || ref(db, path), snapshot => {
            if (source.stopped || liveSources[key] !== source) return;
            try {
                source.status = 'ready'; source.errorCode = null;
                source.receivedAt = Date.now();
                source.connectedAtReceive = !Sync || Sync._state.connected === true;
                clearTimeout(timer);
                onSnapshot(snapshot);
                report();
                if (Sync && Sync._state.connected === true && statisticsReady()) Sync.markSynced();
            } catch (error) { fail(error); }
        }, fail);
        if (Sync) Sync.track('stats:' + key, source.stop);
    } catch (error) { fail(error); }
    return source;
}

// ✅ Vue à 360° super-admin : sélecteur de village (aucun effet pour les autres rôles)
if (window.SuperadminVillage) {
    try {
        const sessionForSelector = JSON.parse(localStorage.getItem('asufor_session') || '{}');
        window.SuperadminVillage.init({ db, get, ref, session: sessionForSelector });
    } catch (_) { /* pas de session lisible : le sélecteur ne s'affiche simplement pas */ }
}

// ✅ Overlay visible dès le départ, pendant la restauration du jeton Firebase.
if (window.AsuforLoader) AsuforLoader.show('Connexion sécurisée…');

let storeReleves = {};
let storeAgents = {};

let currentTab = 'all';
// ✅ v2 : Relevés/Non relevés quittent la ligne d'onglets pour un filtre
// secondaire indépendant (voir setReleveFilter) — la ligne d'onglets se
// limite désormais à Tous / Payés / Impayés / Anomalies.
let releveFilter = 'all';
// ✅ v2 : vrai en consultant une période archivée — verrouille les actions
// de modification (statut, édition) dans renderList() et les handlers.
let isArchiveView = false;
// Cycle ("YYYY-MM") de l'archive consultée, ou "actuel".
let currentSelection = 'actuel';
let displayLimit = 100;
let currentFilteredData = [];
let currentActivePath = "";

// Cache de l'arbre complet asufor_backup (pour billing.js : arriérés + cascade paiement)
let allBackupsCache = {};
let backupIndex = null;
let backupWindows = null;

function invalidateBackupCalculations() { backupIndex = null; backupWindows = null; }
function getBackupIndex() { return backupIndex || (backupIndex = window.Billing.indexBackups(allBackupsCache)); }
function getBackupWindows() { return backupWindows || (backupWindows = Compta.cycleWindows(allBackupsCache)); }
// Les archives ne sont demandées que depuis le sélecteur de périodes.
let backupsLoaded = false;
let archivesRequested = false;
let openLatestArchive = false;
// ✅ v7 : grand livre (factures / paiements / affectations / ajustements) entièrement chargé.
let ledgerReady = false;
let relevesReady = false;
let statisticsRenderQueued = false;
const Compta = window.Compta;
const ComptaUI = window.ComptaUI;

let currentUser = 'Trésorier/Admin';

// ✅ Branding par forage : nom affiché (en-tête, titre, PDF impayés) résolu
// depuis Asufor/{forageKey}/config.nom, jamais "Diandioly" en dur — chaque
// village doit voir son propre nom.
let forageBranding = 'Satigué Eau';
function loadForageBranding() {
    watchStatsSource('config', P.config, snap => {
        const cfg = snap.exists() ? snap.val() : {};
        if (cfg.nom) {
            forageBranding = cfg.nom;
            document.title = cfg.nom + ' – Statistiques';
            const titleEl = document.getElementById('forage-title');
            if (titleEl) titleEl.textContent = cfg.nom;
        }
    });
}

// ✅ Échappement HTML partagé (security.js), avec un repli local UNIQUE
//   (évite la double définition qui traînait dans startSync et renderList).
const escHtml = window.escHtml || (s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));

const sessionRaw = localStorage.getItem('asufor_session');

if (sessionRaw) {
    try {
        const sessionData = JSON.parse(sessionRaw);
        if (sessionData && sessionData.role) {
            currentUser = sessionData.role;
        }
    } catch (e) {
        console.error("Erreur de lecture de la session:", e);
    }
}

// --- FONCTIONS UTILITAIRES ---
function isPresident() {
    return currentUser.toLowerCase() === 'président';
}

function showToast(msg, isError = false) {
    const toast = document.getElementById("toast");
    toast.innerText = msg;
    toast.style.backgroundColor = isError ? "var(--danger)" : "var(--success)";
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

window.setTab = function(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    displayLimit = 100;
    window.applyFilter();
};

// ✅ v2 : filtre secondaire Relevés / Non relevés (déplacé hors des onglets)
window.setReleveFilter = function(value) {
    releveFilter = value;
    displayLimit = 100;
    const progressCard = document.getElementById('releves-progress-card');
    if (progressCard) progressCard.style.display = (value === 'releves' || value === 'non-releves') ? 'block' : 'none';
    window.applyFilter();
};

// Puces de filtre (Tous / À relever / Relevés) : mêmes valeurs que l'ancien sélecteur, aucune logique changée.
window.setReleveChip = function(value) {
    ['all', 'non-releves', 'releves'].forEach(v => {
        const el = document.getElementById('chip-' + v);
        if (el) el.classList.toggle('active', v === value);
    });
    window.setReleveFilter(value);
};

window.toggleSort = function() {
    const sel = document.getElementById('sort-spinner');
    const btn = document.getElementById('chip-sort');
    const open = sel.style.display === 'none';
    sel.style.display = open ? 'block' : 'none';
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
};

window.loadMore = function() {
    displayLimit += 100;
    renderList();
};

window.scrollToTop = function() {
    const listSection = document.getElementById('scrollable-list');
    if (listSection) listSection.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Relevé RÉELLEMENT en cours d'un compteur (pas celui affiché à l'écran si une archive est consultée) :
// utilisé pour la facture provisoire du mois actuel et le statut payé/impayé du compteur. En vue
// « Données actuelles », c'est déjà storeReleves[key] ; en archive, on va le relire (données déjà en
// cache local via AsuforCache la plupart du temps, donc quasi instantané).
async function currentReleveFor(key) {
    if (!isArchiveView) return storeReleves[key] || {};
    try {
        const snap = await sget(ref(db, `${P.compteurs}/${key}`));
        return snap.exists() ? snap.val() : {};
    } catch (e) {
        console.error('Relevé courant introuvable :', e.code, e.message);
        return {};
    }
}

// --- ENCAISSEMENT (v7) ---
// L'encaissement ne solde plus « tout » : il ouvre la fenêtre de paiement (montant libre,
// mode, n° de reçu, aperçu FIFO). Toute la logique et l'écriture atomique sont dans compta.js.
// ✅ v8 : l'encaissement fonctionne aussi depuis une archive (mois passé) — le paiement est simplement
// daté d'aujourd'hui et réglé en FIFO sur les factures les plus anciennes ouvertes, celle de l'archive
// consultée y compris. Le « relevé en cours » utilisé pour la facture provisoire du mois ACTUEL et pour
// le statut payé/impayé du compteur doit toujours être le relevé réellement en cours (pas celui de
// l'archive affichée à l'écran) : on va le relire quand une archive est consultée.
window.encaisser = async function(key) {
    if (!ledgerReady || (isArchiveView && !backupsLoaded)) { showToast("⏳ Comptabilité en cours de chargement : patientez un instant.", true); return; }
    if (!ComptaUI.isMigrated()) { showToast("⚠️ Migration comptable requise (président) avant tout encaissement.", true); return; }
    const item = await currentReleveFor(key);
    ComptaUI.openPaymentDialog({
        compteurId: key,
        releve: item,
        client: item.name || '',
        numero: item.numero_compteur || '',
        recuUrl: (pid) => `../compte/recu.html?p=${encodeURIComponent(pid)}`,
        onDone: () => { showToast("✅ Encaissement enregistré."); window.applyFilter(); }
    });
};

window.annulerEncaissement = async function(key) {
    if (!ledgerReady || (isArchiveView && !backupsLoaded)) { showToast("⏳ Comptabilité en cours de chargement : patientez un instant.", true); return; }
    const item = await currentReleveFor(key);
    ComptaUI.openPaymentCancelDialog({
        compteurId: key,
        releve: item,
        client: item.name || '',
        numero: item.numero_compteur || '',
        onDone: () => { showToast("✅ Paiement annulé : arriérés et statistiques mis à jour."); window.applyFilter(); }
    });
};

// Remet un mois ARCHIVÉ « Payé » en « Non payé » (président). Deux cas :
//  • le mois est marqué payé dans l'archive mais n'a aucun encaissement enregistré : le statut de l'archive
//    repasse à « impaye » ET la facture correspondante est créée dans le grand livre (Compta.buildArchiveCorrectionOps,
//    source « correction_releve », audit FACTURE_CREEE), dans UNE écriture atomique ;
//  • la facture a été réglée par un vrai encaissement : on ne peut pas la « dé-payer » isolément, on ouvre
//    « Annuler encaissement » (contre-écriture tracée du paiement concerné).
window.marquerNonPaye = function(key) {
    if (!isArchiveView || !ComptaUI.isPresident()) return;
    if (!ledgerReady || (isArchiveView && !backupsLoaded)) { showToast("⏳ Comptabilité en cours de chargement : patientez un instant.", true); return; }
    if (!ComptaUI.isMigrated()) { showToast("⚠️ Migration comptable requise (président).", true); return; }
    const cycle = currentSelection;
    const row = storeReleves[key] || {};
    const St = ComptaUI.getState();
    const f = St.factures[Compta.factureId(cycle, key)];
    if (f) {
        const fs = Compta.factureState(St, f);
        if (fs.annulee) { showToast("Cette facture est annulée : rien à remettre en non payé.", true); return; }
        if (fs.montant_paye > 0) {
            showToast("Ce mois a été réglé par un encaissement enregistré : utilisez « Annuler encaissement ».", true);
            window.annulerEncaissement(key);
            return;
        }
    }
    const m = ComptaUI.modal(`<h3>Remettre en « non payé »</h3>
        <p class="cui-sub">${escHtml(row.name || '')} — ${monthLabelFR(cycle)}. Le mois sera marqué impayé et la facture correspondante sera créée dans la comptabilité (dette due, tracée).</p>
        <label for="cui-np-motif">Motif (obligatoire)</label>
        <textarea id="cui-np-motif" rows="2" maxlength="300" placeholder="ex. paiement jamais reçu"></textarea>
        <div class="cui-err" id="cui-np-err" role="alert"></div>
        <div class="cui-act"><button type="button" class="cui-ghost" id="cui-np-no">Retour</button><button type="button" class="cui-primary" id="cui-np-yes">Marquer non payé</button></div>`);
    m.q('#cui-np-no').addEventListener('click', m.close);
    m.q('#cui-np-yes').addEventListener('click', () => {
        const motif = m.q('#cui-np-motif').value.trim();
        if (motif.length < 3) { m.q('#cui-np-err').textContent = 'Le motif est obligatoire (3 caractères minimum).'; return; }
        const btn = m.q('#cui-np-yes'); btn.disabled = true; m.q('#cui-np-err').textContent = '';
        const rowPath = `${P.backup}/${cycle}/donnees/${key}`;
        const newRecord = { ...row, status: 'impaye', statut: false, date_paiement: null };
        ComptaUI.run((S2, base) => {
            const c = Compta.buildArchiveCorrectionOps(S2, { ...base, cycle, compteurId: key, newRecord, motif });
            const upd = {
                [`${rowPath}/status`]: 'impaye', [`${rowPath}/statut`]: false, [`${rowPath}/date_paiement`]: null,
                [`${rowPath}/last_modified_by`]: currentUser, [`${rowPath}/last_modified_at`]: base.now,
                [`${rowPath}/correction_motif`]: motif
            };
            return { updates: Object.assign({}, upd, c.updates), correction: c };
        }).then((r) => {
            patchBackupCache(cycle, key, { status: 'impaye', statut: false, date_paiement: null });
            // affichage immédiat (les écoutes Firebase confirment ensuite : opération idempotente)
            if (storeReleves[key]) { storeReleves[key] = { ...storeReleves[key], status: 'impaye', statut: false }; delete storeReleves[key].date_paiement; }
            const c = r && r.correction;
            m.close();
            showToast('✅ Mois remis en non payé' + (c && c.action === 'facture' ? ` — dette de ${c.ecart.toLocaleString()} F créée.` : '.'));
            window.applyFilter();
        }, (err) => { btn.disabled = false; m.q('#cui-np-err').textContent = err.message || String(err); });
    });
};

// La page des statistiques reste active pendant la consultation du client.
let customerFrame = null;
let customerFocus = null;
function customerLocation() {
    const params = new URLSearchParams(location.search);
    const key = params.get('client');
    const view = params.get('vue');
    return key && ['paiements', 'factures'].includes(view) ? { key, view } : null;
}
function closeCustomerView() {
    if (!customerFrame) return;
    customerFrame.remove(); customerFrame = null;
    document.querySelector('.main-layout').inert = false;
    document.body.classList.remove('customer-view-open');
    if (customerFocus && customerFocus.isConnected) customerFocus.focus({preventScroll:true});
    customerFocus = null;
}
function showCustomerView(key, view, push = true) {
    if (push) {
        const url = new URL(location.href);
        url.searchParams.set('client', key); url.searchParams.set('vue', view);
        history.pushState({ ...history.state, asuforCustomer: true }, '', url);
    }
    if (customerFrame && customerFrame.dataset.client === key && customerFrame.dataset.view === view) return;
    closeCustomerView();
    customerFocus = document.activeElement;
    const layer = document.createElement('div');
    layer.className = 'customer-view'; layer.dataset.client = key; layer.dataset.view = view;
    layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', view === 'factures' ? 'Factures du client' : 'Paiements du client');
    const frame = document.createElement('iframe');
    frame.id = 'customer-frame'; frame.title = layer.getAttribute('aria-label');
    const url = new URL('../compte/releve.html', location.href);
    url.searchParams.set('c', key); url.searchParams.set('embedded', '1');
    if (view === 'factures') url.searchParams.set('vue', 'factures');
    frame.src = url.href;
    frame.setAttribute('allow', "public-key-credentials-get 'self'");
    frame.addEventListener('load', () => frame.focus());
    layer.appendChild(frame); customerFrame = layer;
    document.body.appendChild(layer);
    document.querySelector('.main-layout').inert = true;
    document.body.classList.add('customer-view-open');
}
function returnFromCustomer() {
    if (history.state && history.state.asuforCustomer) history.back();
    else {
        const url = new URL(location.href); url.searchParams.delete('client'); url.searchParams.delete('vue');
        history.replaceState(history.state, '', url); closeCustomerView();
    }
}
window.addEventListener('popstate', () => { const target = customerLocation(); if (target) showCustomerView(target.key, target.view, false); else closeCustomerView(); });
window.addEventListener('message', event => {
    if (event.origin !== location.origin || !customerFrame || event.source !== customerFrame.querySelector('iframe').contentWindow) return;
    if (event.data && event.data.type === 'asufor:return-statistics') returnFromCustomer();
});
window.openDetails = key => showCustomerView(key, 'factures');
window.openReleve = key => showCustomerView(key, 'paiements');
const initialCustomer = customerLocation();
if (initialCustomer) showCustomerView(initialCustomer.key, initialCustomer.view, false);

// --- EXPORT CSV ---
window.exportCSV = function() {
    if (!statisticsReady()) { showToast('Les montants sont encore en cours de vérification.', true); return; }
    if (currentFilteredData.length === 0) {
        showToast("La liste est vide, rien à exporter.", true);
        return;
    }
    let csvContent = "\uFEFF"; 
    csvContent += "Client;N° Compteur;Zone;Ancien Index;Nouvel Index;Conso (m3);Facteur;Montant Mois (CFA);Arriérés (CFA);Versement non affecté (CFA);Total dû (CFA);Statut;Dernière Modif;Par\n";

    currentFilteredData.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const conso = Math.max(0, nIdx - lIdx);
        const facteur = parseFloat(item.facteur || 0);
        // ✅ Valeurs issues de billing.js (calculées dans applyFilter), pas d'un recalcul divergent
        const calculatedAmount = item.calculatedAmount || 0;
        const arriere = item.arriere || 0;
        const totalDu = (item.totalDu != null) ? item.totalDu : calculatedAmount;

        const isPaid = item.estSolde ? 'Paye' : 'Impaye';
        const avance = item.avance || 0;
        const zoneName = zoneOf(item);
        const clientName = (item.name || "Client Inconnu").replace(/;/g, ' ');
        const numCompteur = (item.numero_compteur || "").replace(/;/g, ' ');
        const lastModif = item.last_modified_at ? new Date(item.last_modified_at).toLocaleString() : 'N/A';
        const par = item.last_modified_by || 'N/A';

        csvContent += `${clientName};${numCompteur};${zoneName};${lIdx};${nIdx};${conso};${facteur};${calculatedAmount};${arriere};${avance};${totalDu};${isPaid};${lastModif};${par}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `SatigueEau_Export_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    showToast("✅ Fichier Excel téléchargé !");
};

// ✅ v2 : libellé humain ("Août 2026 — Archive") au lieu du format technique
// "Archive : 2026-08" — plus clair pour un responsable non technicien.
function monthLabelFR(cycle) {
    if (!cycle || cycle === 'actuel') return 'Données actuelles';
    const [y, m] = cycle.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
    const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
}

// Le mois courant n'ouvre aucun chemin de backup, y compris lors d'une reprise.
window.initMonthFilter = function() {
    const monthSelect = document.getElementById('month-filter');
    monthSelect.innerHTML = '<option value="actuel">Mois courant</option><option value="__archives__">Voir les archives…</option>';
    monthSelect.value = 'actuel';
    loadDataForMonth('actuel');
};

function archiveStatus() {
    const el = document.getElementById('archives-status');
    if (!el) return;
    const source = liveSources.archives;
    el.hidden = !archivesRequested || !source || source.status === 'ready';
    const message = source && source.status === 'error'
        ? 'Archives indisponibles. Le mois courant reste accessible.'
        : 'Chargement des archives… Le mois courant reste accessible.';
    el.querySelector('span').textContent = message;
}

function loadBackups(monthSelect, force) {
    if (!archivesRequested) return;
    return watchStatsSource('archives', P.backup, snapshot => {
        allBackupsCache = snapshot.exists() ? snapshot.val() : {};
        invalidateBackupCalculations();
        const months = Object.keys(allBackupsCache).sort().reverse();
        let optionsHtml = '<option value="actuel">Mois courant</option><option value="__archives__">Voir les archives…</option>';
        months.forEach(month => {
            optionsHtml += `<option value="${escHtml(month)}">${escHtml(monthLabelFR(month))} — Archive</option>`;
        });
        const activeValue = openLatestArchive ? (months[0] || 'actuel') : currentSelection;
        openLatestArchive = false;
        monthSelect.innerHTML = optionsHtml;
        monthSelect.value = activeValue === 'actuel' || Object.prototype.hasOwnProperty.call(allBackupsCache, activeValue) ? activeValue : 'actuel';
        backupsLoaded = true;
        if (monthSelect.value !== currentSelection) window.changeMonth();
        else if (!months.length) { showToast('Aucune archive disponible.'); stopArchives(); }
        archiveStatus();
    }, !!force);
}

function stopArchives() {
    archivesRequested = false;
    openLatestArchive = false;
    if (Sync) Sync.untrack('stats:archives');
    else if (liveSources.archives) liveSources.archives.stop();
    archiveStatus();
}

window.cancelArchives = function() {
    document.getElementById('month-filter').value = 'actuel';
    window.changeMonth();
};
window.retryArchives = function() { if (archivesRequested) loadBackups(document.getElementById('month-filter'), true); };
window.changeMonth = function() {
    const select = document.getElementById('month-filter');
    const selectedValue = select.value;
    if (selectedValue === '__archives__') {
        select.value = currentSelection;
        archivesRequested = true;
        openLatestArchive = true;
        loadBackups(select, true);
        archiveStatus();
        return;
    }
    if (selectedValue === 'actuel') stopArchives();
    else { archivesRequested = true; loadBackups(select, false); }
    loadDataForMonth(selectedValue);
    refreshSourceRequirements();
};

// Le mois civil de l'application (Sénégal, UTC) ne dépend pas de la date de clôture.
function receiptMonthWindow(now = Date.now()) {
    const date = new Date(now);
    return {
        start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: now, startInclusive: true,
        label: date.toLocaleDateString('fr-FR', {month:'long', year:'numeric', timeZone:'Africa/Dakar'})
    };
}
let receiptMonthTimer;
function scheduleReceiptMonth() {
    clearTimeout(receiptMonthTimer);
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    receiptMonthTimer = setTimeout(() => { scheduleStatisticsRender(); scheduleReceiptMonth(); }, Math.min(next - now.getTime() + 50, 86400000));
}
scheduleReceiptMonth();
let receiptDetails = null;
let receiptModal = null;
function closeReceiptDetails() {
    if (receiptModal) receiptModal.close();
    receiptModal = null;
    document.getElementById('show-receipts').focus({preventScroll:true});
}
function renderReceiptDetails() {
    if (!receiptModal || !receiptModal.el.isConnected) { receiptModal = null; return; }
    if (!receiptDetails) { closeReceiptDetails(); return; }
    const {payments, encaisse, periodLabel} = receiptDetails;
    const money = amount => Math.round(Number(amount) || 0).toLocaleString('fr-FR') + ' F';
    const rows = [...payments].sort((a,b) => Date.parse(b.date_paiement) - Date.parse(a.date_paiement)).map(payment => {
        const record = storeReleves[payment.compteur_id] || {};
        const client = payment.client || record.name || 'Client non renseigné';
        const accountPayment = Compta.computeAccount(ComptaUI.getState(), payment.compteur_id).paiements.find(p => p.paiement_id === payment.paiement_id);
        const unallocated = accountPayment ? accountPayment.disponible : 0;
        const date = new Date(payment.date_paiement).toLocaleString('fr-FR', {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Africa/Dakar'});
        return `<li><div><strong>${escHtml(client)}</strong><span>${escHtml(date)}</span>${unallocated > 0 ? `<span class="receipt-warning">À vérifier : ${money(unallocated)} non affectés aux factures.</span>` : ''}</div><b>${money(payment.montant)}</b></li>`;
    }).join('');
    const html = `<h3 id="receipt-title">Versements encaissés</h3><p class="cui-sub">${escHtml(periodLabel)}</p><p class="receipt-total">${payments.length} versement${payments.length === 1 ? '' : 's'} · <strong>${money(encaisse)}</strong></p><p class="cui-sub">Les versements règlent les arriérés et la consommation déjà relevée, en une fois ou par tranches. Les anciennes sommes non affectées sont signalées pour vérification.</p><ul class="receipt-list">${rows || '<li>Aucun versement pour cette période.</li>'}</ul><div class="cui-act"><button type="button" class="cui-primary" id="close-receipts">Fermer</button></div>`;
    if (receiptModal.markup === html) return;
    const box = receiptModal.q('.cui-box'), scroll = box.scrollTop, focused = document.activeElement && document.activeElement.id === 'close-receipts';
    box.innerHTML = html; receiptModal.markup = html; box.scrollTop = scroll;
    if (focused) receiptModal.q('#close-receipts').focus({preventScroll:true});
}
function updateReceiptDetails(fig) {
    receiptDetails = fig && Array.isArray(fig.payments) && fig.encaisse !== null ? fig : null;
    const button = document.getElementById('show-receipts');
    button.hidden = !receiptDetails;
    button.disabled = !receiptDetails;
    if (receiptDetails) button.textContent = `Voir les versements (${receiptDetails.payments.length})`;
    renderReceiptDetails();
}
document.getElementById('show-receipts').addEventListener('click', () => {
    if (!receiptDetails || receiptModal && receiptModal.el.isConnected) return;
    receiptModal = ComptaUI.modal('');
    receiptModal.el.setAttribute('aria-labelledby','receipt-title');
    receiptModal.el.addEventListener('click', event => { if (event.target.closest('#close-receipts')) closeReceiptDetails(); });
    receiptModal.el.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeReceiptDetails(); }
        else if (event.key === 'Tab') { event.preventDefault(); receiptModal.q('#close-receipts').focus(); }
    });
    renderReceiptDetails(); receiptModal.q('#close-receipts').focus();
});

function cacheKeyFor(dbPath) {
    return 'releves:' + dbPath;
}

function loadDataForMonth(selection, opts) {
    // silent = resynchronisation en arrière-plan : on ne vide RIEN (ni données, ni liste, ni écran de chargement).
    const silent = !!(opts && opts.silent);
    if (!silent) { storeReleves = {}; relevesReady = false; }

    const dbPath = (selection === "actuel") ? P.compteurs : `${P.backup}/${selection}/donnees`;
    currentActivePath = dbPath;

    // ✅ v2 : une archive est un état historique figé — on verrouille les
    // actions de modification (statut, édition) et on l'indique clairement
    // (bandeau + libellé du bilan), au lieu d'un simple sélecteur technique.
    isArchiveView = (selection !== "actuel");
    currentSelection = selection;
    if (!silent) renderPendingStatistics();
    const banner = document.getElementById('archive-banner');
    if (banner) banner.classList.toggle('visible', isArchiveView);
    // ✅ Le président peut corriger les relevés (index, facteur…) d'une
    // archive ; les statuts de paiement, eux, restent figés.
    const bannerText = document.getElementById('archive-banner-text');
    if (bannerText) {
        bannerText.textContent = isPresident()
            ? 'Archive — vous pouvez corriger les relevés (index, facteur…), encaisser une dette ancienne ou annuler un paiement erroné : chaque correction reste tracée (ajustement, audit).'
            : (ComptaUI.canCollect()
                ? 'Archive — les relevés sont figés ; vous pouvez encaisser une dette ancienne depuis cette page.'
                : 'Archive — données clôturées, lecture seule.');
    }
    const recapTitle = document.getElementById('recap-title');
    if (recapTitle) recapTitle.textContent = isArchiveView ? `Bilan — ${monthLabelFR(selection)}` : 'Bilan du mois';

    // ✅ Chargement INSTANTANÉ : copie locale affichée tout de suite, sans attendre le réseau.
    const cacheKey = cacheKeyFor(dbPath);
    const cached = window.AsuforCache ? window.AsuforCache.read(cacheKey) : null;
    if (!silent) {
        if (cached && typeof cached === 'object') {
            storeReleves = cached;
            document.getElementById('skeleton-loader').style.display = "none";
            document.getElementById('releves-list').innerHTML = "";
            if (window.AsuforLoader) AsuforLoader.hide();
            scheduleStatisticsRender();
        } else {
            document.getElementById('skeleton-loader').style.display = "flex";
            document.getElementById('releves-list').innerHTML = "";
        }
    }
    scheduleStatisticsRender();
    const thisPath = dbPath;
    const previous = liveSources.releves;
    const unverifiedCache = !relevesReady && previous && previous.status === 'ready' && previous.connectedAtReceive === false;
    return watchStatsSource('releves', dbPath, snap => {
        if (currentActivePath !== thisPath) return;
        storeReleves = snap.val() || {};
        relevesReady = !Sync || Sync._state.connected === true;
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeReleves);
        document.getElementById('skeleton-loader').style.display = 'none';
        if (window.AsuforLoader) AsuforLoader.hide();
    }, !silent || !!(opts && opts.force) || !!unverifiedCache);
}

// --- SYNCHRONISATION INITIALE ---
function renderAgentSpinner() {
    const spinner = document.getElementById('agent-spinner');
    const active = spinner.value || "all";
    let html = '<option value="all">🟢 Tous les agents (Global)</option>';
    // ✅ FIX XSS : échapper nom/zone d'agent injectés dans les <option>
    const esc2 = escHtml;
    Object.entries(storeAgents).forEach(([key, a]) => {
        let name = (a.agent || "Inconnu").trim();
        let zone = a.zone ? ` [${esc2(a.zone)}]` : "";
        html += `<option value="${esc2(key)}">👤 ${esc2(name.toUpperCase())}${zone}</option>`;
    });
    spinner.innerHTML = html;
    spinner.value = active;
}

function syncAgents(force) {
    const cacheKey = 'agents:' + P.agents;
    const cachedAgents = window.AsuforCache ? window.AsuforCache.read(cacheKey) : null;
    if (Object.keys(storeAgents).length === 0 && cachedAgents && typeof cachedAgents === 'object') {
        storeAgents = cachedAgents;
        renderAgentSpinner();
    }
    return watchStatsSource('agents', P.agents, snap => {
        storeAgents = snap.val() || {};
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeAgents);
        renderAgentSpinner();
    }, !!force);
}

// La reprise demande les écoutes immédiatement, sans attendre les trois get() qui expiraient.
let syncStarted = false;
function resyncAll(reason) {
    const force = ['manual', 'badge', 'loader-retry'].includes(reason) || ((!Sync || Sync._state.connected !== true) && ['visible', 'pageshow-bfcache', 'online'].includes(reason));
    loadDataForMonth(currentSelection, { silent: true, force });
    syncAgents(force);
    if (archivesRequested) loadBackups(document.getElementById('month-filter'), force);
    return requiredStatsSources().every(key => liveSources[key] && liveSources[key].status !== 'error');
}

// Comptabilité : jamais « en attente » sans explication — message + bouton Réessayer si un nœud du grand livre échoue.
function renderLedgerStatus(info) {
    const el = document.getElementById('compta-status');
    if (!el) return;
    if (!info || info.status === 'ready' || info.status === 'loading') { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = (info.status === 'degraded'
        ? '<span>⚠️ Comptabilité : mise à jour partielle, nouvelle tentative en cours.</span>'
        : '<span>⚠️ Comptabilité indisponible pour le moment (connexion ?). Nouvelle tentative en cours.</span>')
        + '<button type="button" onclick="ComptaUI.retry()">Réessayer</button>';
}

window.startSync = function() {
    if (syncStarted) return;      // onAuthStateChanged peut se redéclencher : une seule mise en place
    syncStarted = true;
    if (Sync) {
        Sync.init({ db, ref, onValue, goOffline, goOnline });
        Sync.onResync(resyncAll);
        Sync.onState(() => { if (!statisticsReady()) scheduleStatisticsRender(); });
    }
    // ✅ v7 : grand livre comptable (lecture continue ; écritures via compta.js).
    ComptaUI.init({ db, ref, get, update, push, onValue, P, keepSubscriptionsOnResume: true, session: JSON.parse(localStorage.getItem('asufor_session') || '{}'), getUid: () => auth.currentUser && auth.currentUser.uid });
    ComptaUI.subscribe((st, mig, ready, info) => {
        ledgerReady = ready && (!info || info.status === 'ready');
        renderLedgerStatus(info);
        if (Sync && Sync._state.connected === true && statisticsReady()) Sync.markSynced();
        scheduleStatisticsRender();
    });
    // ✅ Les agents et les relevés se chargent en PARALLÈLE (l'un n'attend
    // pas l'autre) : chacun affiche sa propre copie en cache instantanément
    // pendant que sa version fraîche arrive en tâche de fond.
    syncAgents();
    window.initMonthFilter();
}

// --- RECHERCHE VOCALE ET TEXTUELLE ---
function normalizeText(text) { return text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['"_-]/g, " ").toLowerCase().trim() : ""; }
function getEditDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
            else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
        }
    }
    return matrix[b.length][a.length];
}
function isFuzzyMatch(query, target) {
    if (!query) return true;
    if (!target) return false;
    const q = normalizeText(query); const t = normalizeText(target);
    if (t.includes(q)) return true;
    const queryWords = q.split(/\s+/); const targetWords = t.split(/\s+/);
    return queryWords.every(qWord => targetWords.some(tWord => tWord.includes(qWord) || getEditDistance(qWord, tWord) <= (qWord.length <= 4 ? 1 : 2)));
}

window.startVoiceSearch = function() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { showToast("⚠️ Non supporté.", true); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'fr-FR'; recognition.interimResults = false; recognition.maxAlternatives = 1;
    const micBtn = document.getElementById('btn-mic');
    const searchInput = document.getElementById('search-client');

    recognition.onstart = function() { micBtn.classList.add('mic-active'); searchInput.placeholder = "Écoute en cours..."; };
    recognition.onresult = function(event) {
        let transcript = event.results[0][0].transcript.toLowerCase();
        transcript = transcript.replace(/\b(le|la|les|un|une|des|cherche|trouve|numero|numéro|compteur|client|pour)\b/g, ' ').replace(/\s+/g, ' ').trim();
        searchInput.value = transcript;
        window.applyFilter();
    };
    recognition.onerror = function() { showToast("Erreur vocale", true); };
    recognition.onend = function() { micBtn.classList.remove('mic-active'); searchInput.placeholder = "🔍 Rechercher..."; };
    recognition.start();
};

// ✅ CORRECTION : résolution de zone alignée sur rapports.js (zoneOf) — le champ
//   `item.zone` stocké sur le relevé prime sur celui de l'agent actuellement lié,
//   qui peut avoir été supprimé/réassigné depuis (sinon le relevé retombe dans un
//   fourre-tout générique et le graphique "Volume par Zone" perd des quartiers).
function zoneOf(item) {
    const own = item && item.zone && String(item.zone).trim();
    if (own) return own;
    const viaAgent = storeAgents[item && item.agent_id]?.zone;
    return (viaAgent && String(viaAgent).trim()) || "Sans zone";
}

// --- MOTEUR DE FILTRAGE ET TENDANCES ---
function requiredStatsSources() { return isArchiveView ? ['releves', 'agents', 'archives'] : ['releves', 'agents']; }
function refreshSourceRequirements() {
    if (Sync && Sync.reportSource) Object.entries(liveSources).forEach(([key, source]) => {
        Sync.reportSource('stats:' + key, requiredStatsSources().includes(key) && !source.stopped ? source.status : null);
    });
}
function statisticsReady() {
    return relevesReady && ledgerReady && (!isArchiveView || backupsLoaded) && requiredStatsSources().every(key => liveSources[key] && liveSources[key].status === 'ready');
}

function scheduleStatisticsRender() {
    if (statisticsRenderQueued) return;
    statisticsRenderQueued = true;
    requestAnimationFrame(() => {
        statisticsRenderQueued = false;
        archiveStatus();
        window.applyFilter();
    });
}

window.retryStatistics = function () {
    if (Sync) Sync.retry('badge');
};

window.asuforDiagnostics = function () {
    const sources = {};
    for (const [key, source] of Object.entries(liveSources)) {
        sources[key] = { status: source.status, receivedAt: source.receivedAt, connectedAtReceive: source.connectedAtReceive, errorCode: source.errorCode };
    }
    return { build: STATS_BUILD, page: 'statistiques', navigatorOnline: navigator.onLine, visibility: document.visibilityState,
        firebaseConnected: Sync ? Sync._state.connected : null, calculationsReady: statisticsReady(), readingsVerified: relevesReady,
        archivesReceived: backupsLoaded, archivesRequested, migrated: ComptaUI.isMigrated(), receiptsPeriod: receiptMonthWindow().label, sources, ledger: ComptaUI.getStatus() };
};
window.showStatsDiagnostic = () => { console.info('[ASUFOR diagnostic]', JSON.stringify(window.asuforDiagnostics())); showToast('Diagnostic affiché dans la console F12.'); };

function setStatisticsAvailability(ready) {
    document.getElementById('stats-summary').setAttribute('aria-busy', String(!ready));
    document.getElementById('releves-list').setAttribute('aria-busy', String(!ready));
    document.getElementById('stats-loading').hidden = ready;
    document.querySelectorAll('[data-requires-statistics]').forEach(button => { button.disabled = !ready; });
}

function renderPendingList() {
    const selectedId = document.getElementById('agent-spinner').value || 'all';
    const search = document.getElementById('search-client').value.trim();
    const rows = Object.entries(storeReleves).map(([key, item]) => ({ key, ...item })).reverse().filter(item =>
        (selectedId === 'all' || item.agent_id === selectedId) &&
        (isFuzzyMatch(search, item.name || '') || (search && String(item.numero_compteur || '').includes(search))));
    const list = document.getElementById('releves-list');
    list.innerHTML = rows.slice(0, displayLimit).map(item => `<div class="item bg-non-releve citem-pending">
        <div class="citem-main"><span class="citem-name">${escHtml(item.name || 'Inconnu')}</span></div>
        <div class="citem-sub"><span>Compteur n°${escHtml(item.numero_compteur || 'N/A')}</span></div>
        <p class="stats-pending-note">Montants en cours de vérification…</p>
    </div>`).join('');
    document.getElementById('item-count').textContent = rows.length ? `${rows.length} client(s) — calcul en cours` : 'Chargement des relevés…';
    document.getElementById('btn-load-more').style.display = rows.length > displayLimit ? 'block' : 'none';
}

function renderPendingStatistics() {
    setStatisticsAvailability(false);
    currentFilteredData = [];
    updateReceiptDetails(null);
    for (const id of ['total-money', 'total-debt', 'recap-pct', 'releves-ratio', 'releves-progress-pct']) {
        document.getElementById(id).textContent = '—';
    }
    document.getElementById('rc-source').textContent = '';
    document.getElementById('recap-story').textContent = 'Les montants seront affichés après vérification des données.';
    document.getElementById('recap-bar-fill').style.width = '0%';
    document.getElementById('releves-bar-fill').style.width = '0%';
    document.getElementById('trend-money').textContent = '';
    document.getElementById('trend-debt').textContent = '';
    document.getElementById('top-quartiers').innerHTML = '<p class="muted-note">Chargement des statistiques…</p>';
    const critical = requiredStatsSources();
    const errors = critical.filter(key => liveSources[key] && liveSources[key].status === 'error');
    const slow = critical.filter(key => liveSources[key] && liveSources[key].status === 'slow');
    const labels = { releves: 'relevés', agents: 'agents', archives: 'archives' };
    document.getElementById('stats-diagnostic').hidden = !(errors.length || slow.length || (Sync && Sync.status() === 'offline') || ComptaUI.getStatus().status === 'error');
    document.getElementById('stats-loading-message').textContent = errors.length
        ? `Chargement impossible : ${errors.map(key => labels[key]).join(', ')}. Réessayez.`
        : slow.length ? `Chargement plus long que prévu : ${slow.map(key => labels[key]).join(', ')}. Les données sont toujours attendues.`
        : Sync && Sync.status() === 'offline'
        ? 'Données locales affichées. Reconnectez-vous pour vérifier les montants.'
        : 'Vérification des montants en cours…';
    renderPendingList();
}

window.applyFilter = function() {
    if (!statisticsReady()) { renderPendingStatistics(); return; }
    setStatisticsAvailability(true);
    if (!ComptaUI.isMigrated() && !backupsLoaded) document.querySelectorAll('[data-requires-statistics]').forEach(button => { button.disabled = true; });
    const selectedId = document.getElementById('agent-spinner').value || 'all';
    const searchQuery = document.getElementById('search-client').value.trim();
    const sortOption = document.getElementById('sort-spinner').value;
    
    let entries = Object.entries(storeReleves).map(([key, item]) => ({ key, ...item })).reverse();
    
    const monthSel = (document.getElementById('month-filter') || {}).value || 'actuel';
    const beforeCycle = (monthSel === 'actuel') ? '9999-99' : monthSel;
    const indexedBackups = getBackupIndex();
    const currentKeys = {};
    Object.keys(storeReleves).forEach(k => { currentKeys[k] = true; });

    // ✅ v7 : quelle source pour cette période ?
    //   • grand livre (factures/paiements) : « Données actuelles » et archives clôturées APRÈS la migration ;
    //   • historique (archives) : avant la migration comptable, ou tant qu'elle n'a pas été faite.
    const S = ComptaUI.getState();
    const mig = ComptaUI.getMigration();
    const migrated = ComptaUI.isMigrated();
    const cutoff = migrated ? (mig.dernier_cycle || '') : null;
    const ledgerMode = migrated && (monthSel === 'actuel' || monthSel > cutoff);

    let filteredBase = entries.filter(item => {
        if (selectedId !== "all" && item.agent_id !== selectedId) return false;
        const rawName = item.name || "";
        const rawCompteur = String(item.numero_compteur || "");
        const queryDigits = searchQuery.replace(/\D/g, '');
        const compteurDigits = rawCompteur.replace(/\D/g, '');
        let isCompteurMatch = (queryDigits.length > 0 && compteurDigits.includes(queryDigits));
        let isNameMatch = isFuzzyMatch(searchQuery, rawName);
        return isNameMatch || isCompteurMatch;
    });

    // Compteurs ayant au moins un paiement valide dans le GRAND LIVRE (une seule passe, pas par carte) :
    // conditionne le bouton « Annuler encaissement » (président uniquement, voir comptaButtons). Toujours
    // calculé depuis l'état comptable réel — indépendant de ledgerMode, qui ne régit que les montants
    // AFFICHÉS sur la carte d'une archive antérieure à la clôture de migration.
    const compteursAvecPaiement = new Set();
    if (migrated) Object.values(S.paiements || {}).forEach(p => { if (p.statut === 'valide') compteursAvecPaiement.add(p.compteur_id); });

    // Montants de chaque carte : TOUJOURS via billing.js / compta.js (aucun calcul métier ici).
    filteredBase.forEach(item => {
        const cur = window.Billing.computeCurrent(item);
        item.conso = cur.conso;                               // 0 si anomalie de relevé
        item.avance = 0;
        if (ledgerMode && monthSel === 'actuel') {
            const du = Compta.amountDueNow(S, item.key, item);
            item.calculatedAmount = du.facture_provisoire;    // relevé du mois (facturé à la clôture)
            item.arriere = du.arrieres;                       // factures échues non réglées
            item.avance = du.avance;
            item.totalDu = du.total_du;
            item.estSolde = du.total_du <= 0 && (du.facture_provisoire > 0 || du.account.total_paye > 0 || du.account.total_facture > 0);
        } else if (ledgerMode) {
            const f = S.factures[Compta.factureId(monthSel, item.key)];
            const acc = Compta.computeAccount(S, item.key);
            const anterieurs = acc.factures.filter(x => x.cycle < monthSel && !x.annulee).reduce((t, x) => t + x.reste_a_payer, 0);
            if (f) {
                const st = Compta.factureState(S, f);
                item.calculatedAmount = st.montant_net;
                item.factureStatut = st.statut;
                item.totalDu = st.reste_a_payer + anterieurs;
                item.estSolde = st.statut === 'payee';
            } else {
                item.calculatedAmount = 0;
                item.factureStatut = null;
                item.totalDu = anterieurs;
                item.estSolde = false; // aucune facture pour ce mois
            }
            item.arriere = anterieurs;
        } else {
            const stmt = window.Billing.computeStatement(item, indexedBackups, { beforeCycle, fbKey: item.key, currentKeys });
            item.calculatedAmount = stmt.facture_courante;
            item.arriere = stmt.arriere;
            item.totalDu = stmt.total;
            item.estSolde = window.Billing.isPaid(item);
        }
        // Un compte soldé ou une avance ne constitue pas une facture payée
        // tant qu'aucun relevé valide n'existe pour la période affichée.
        item.estSolde = item.estSolde && parseFloat(item.new_index || 0) > 0 && !cur.anomalie;
        item.hasAnomalie = (parseFloat(item.new_index || 0) > 0 && cur.anomalie) || window.Billing.isUnusualConsumption(item);
        item.hasValidPayment = compteursAvecPaiement.has(item.key);
    });

    currentFilteredData = filteredBase.filter(item => {
        if (isNaN(item.totalDu)) return false;
        const isPaid = item.estSolde;
        if (currentTab === 'paye' && !isPaid) return false;
        if (currentTab === 'impaye' && (isPaid || !(item.totalDu > 0))) return false;
        // ✅ onglet Problèmes : erreur d'index (nouveau < ancien) ou surconsommation (> 100 m³)
        if (currentTab === 'anomalies' && !item.hasAnomalie) return false;
        if (releveFilter === 'releves' && !(parseFloat(item.new_index || 0) > 0)) return false;
        if (releveFilter === 'non-releves' && (parseFloat(item.new_index || 0) > 0)) return false;
        return true;
    });

    if (sortOption === "max_amount") currentFilteredData.sort((a, b) => (b.totalDu || 0) - (a.totalDu || 0));
    else if (sortOption === "min_amount") currentFilteredData.sort((a, b) => (a.totalDu || 0) - (b.totalDu || 0));
    else if (sortOption === "zone") currentFilteredData.sort((a, b) => zoneOf(a).localeCompare(zoneOf(b)));
    else if (sortOption === "name") currentFilteredData.sort((a, b) => (a.name || "Z").localeCompare(b.name || "Z"));
    else if (sortOption === "compteur") currentFilteredData.sort((a, b) => {
        const na = String(a.numero_compteur || "").replace(/\D/g, "").padStart(10, "0");
        const nb = String(b.numero_compteur || "").replace(/\D/g, "").padStart(10, "0");
        return na.localeCompare(nb);
    });

    // ── Indicateurs (Facturé / Encaissé / Arriérés / Avances / Ajustements / Problèmes) ──
    // Chaque montant n'est compté qu'UNE fois : une facture > 100 m³ impayée compte 1 dossier dans
    // « Problèmes » et son montant dans « Arriérés », jamais deux fois.
    // Sans filtre : TOUT le forage (y compris les dettes de compteurs absents de la liste) ;
    // avec un filtre agent/recherche : uniquement les compteurs affichés.
    let ids = null;
    if (selectedId !== 'all' || searchQuery) {
        ids = {};
        filteredBase.forEach(it => { ids[it.key] = true; });
    }
    const fig = periodFigures(monthSel, filteredBase, ids, S, ledgerMode);
    const prevCycle = previousCycleOf(monthSel);
    const prevFig = prevCycle ? periodFigures(prevCycle, null, ids, S, migrated && prevCycle > cutoff) : null;

    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const F = (n) => n === null ? '—' : Math.round(n || 0).toLocaleString() + " CFA";
    const aReclamer = ledgerMode && monthSel === 'actuel'
        ? filteredBase.reduce((t, it) => t + (it.totalDu || 0), 0)
        : fig.arrieres;
    document.getElementById('total-money').innerText = F(fig.encaisse);
    document.getElementById('total-debt').innerText = F(aReclamer);
    setTxt('rc-source', fig.historique
        ? 'Chiffres reconstitués depuis les archives (avant la comptabilité).'
        : (ledgerMode ? fig.periodLabel : (!backupsLoaded ? 'Mois courant uniquement. Arriérés historiques indisponibles avant consultation des archives ou migration comptable.' : '')));
    updateReceiptDetails(fig);

    const recapKnown = fig.encaisse !== null && aReclamer !== null;
    const recapTotal = recapKnown ? fig.encaisse + aReclamer : 0;
    const recapPct = recapTotal > 0 ? (fig.encaisse / recapTotal * 100) : 0;
    const recapBar = document.getElementById('recap-bar-fill');
    if (recapBar) {
        recapBar.style.width = Math.min(100, recapPct) + '%';
        recapBar.style.background = recapPct >= 75 ? 'var(--success)' : recapPct >= 40 ? '#f59e0b' : 'var(--danger)';
    }
    const recapStoryEl = document.getElementById('recap-story');
    if (recapStoryEl) {
        recapStoryEl.textContent = aReclamer === null ? 'Consultez les archives pour connaître les arriérés historiques.' : aReclamer > 0
            ? `Il reste ${Math.round(aReclamer).toLocaleString()} F à encaisser`
            : '🎉 Rien à réclamer !';
    }
    const recapPctEl = document.getElementById('recap-pct');
    if (recapPctEl) recapPctEl.textContent = recapKnown ? recapPct.toFixed(1).replace('.', ',') + ' % encaissé' : '—';

    // Tendances : même définition pour la période précédente (sinon comparaison trompeuse).
    const calcTrend = (current, prev, elId, goodWhenUp) => {
        const el = document.getElementById(elId);
        if (!el) return;
        if (!prev || current === null) { el.innerHTML = ""; return; }
        const diff = ((current - prev) / prev) * 100;
        const dirUp = diff >= 0;
        const sign = dirUp ? '+' : '';
        const arrow = dirUp ? '↑' : '↓';
        const isGood = dirUp === goodWhenUp;
        const colorClass = isGood ? 'trend-good' : 'trend-bad';
        const qualifier = isGood ? 'Plutôt bien' : 'À surveiller';
        el.innerHTML = `<span class="${colorClass}">${arrow} ${qualifier} <span class="trend-detail">(${sign}${diff.toFixed(1)}% vs mois précédent)</span></span>`;
    };
    calcTrend(fig.encaisse, monthSel === 'actuel' ? null : prevFig && prevFig.encaisse, 'trend-money', true);
    calcTrend(fig.arrieres, prevFig && prevFig.arrieres, 'trend-debt', false);

    renderMigrationBanner();
    renderList();
    renderTopQuartiers();
    updateRelevesProgress();
}

// Cycle précédent (archive) de la période affichée ; null s'il n'y en a pas.
function previousCycleOf(sel) {
    const cycles = Object.keys(allBackupsCache).sort();
    if (sel === 'actuel') return cycles[cycles.length - 1] || null;
    const i = cycles.indexOf(sel);
    return i > 0 ? cycles[i - 1] : null;
}

/**
 * Chiffres d'une période. Grand livre (compta.js) si ledger, sinon reconstitués depuis l'archive.
 * @param {string} sel - 'actuel' ou cycle archivé
 * @param {Array|null} items - relevés affichés (déjà calculés) ou null (période voisine : lecture archive)
 * @param {object|null} ids - {compteurId:true} pour restreindre (filtre agent/recherche) ; null = tous
 */
function periodFigures(sel, items, ids, S, ledger) {
    const W = getBackupWindows();
    if (ledger) {
        const isOpen = sel === 'actuel';
        const w = isOpen ? receiptMonthWindow() : (W.windows[sel] || { start: 0, end: Infinity });
        const period = { cycle: isOpen ? '__ouvert__' : sel, start: w.start, end: w.end, startInclusive: !!w.startInclusive, compteurIds: ids || undefined };
        const st = Compta.periodStats(S, period);
        const payments = Compta.periodPayments(S, period);
        const periodLabel = isOpen ? 'Versements reçus en ' + w.label + '.' : 'Versements reçus pendant le cycle ' + monthLabelFR(sel) + '.';
        let problemes = st.problemes;
        let facture = st.facture, previsionnel = false;
        const rows = items || (isOpen ? null : Object.entries((allBackupsCache[sel] || {}).donnees || {}).map(([key, r]) => ({ key, ...r })));
        if (isOpen && items) {
            facture = items.reduce((t, it) => t + (it.calculatedAmount || 0), 0);   // relevés en cours, facturés à la clôture
            previsionnel = true;
        }
        if (rows) rows.forEach(it => {
            if (ids && !ids[it.key]) return;
            const cur = window.Billing.computeCurrent(it);
            // anomalies d'index du relevé (pas de facture) ; les surconsommations facturées sont déjà dans st.problemes
            if (parseFloat(it.new_index || 0) > 0 && cur.anomalie) problemes++;
            else if (isOpen && window.Billing.isUnusualConsumption(it)) problemes++;
        });
        if (isOpen) {
            // factures d'anciens cycles dont le problème n'est pas encore résolu
            Object.values(S.factures).forEach(f => {
                if ((!ids || ids[f.compteur_id]) && f.probleme && f.probleme.actif && !f.probleme.resolu) problemes++;
            });
        }
        return { facture, previsionnel, encaisse: st.encaisse, payments, periodLabel, arrieres: st.arrieres, avances: st.avances, ajustements: st.ajustements, problemes, historique: false };
    }
    // Historique : relevés de la période (archive ou actuel avant migration)
    const rows = items || Object.entries((allBackupsCache[sel] || {}).donnees || {}).map(([key, r]) => ({ key, ...r }));
    const idx = getBackupIndex();
    let facture = 0, encaisse = 0, arrieres = 0, problemes = 0;
    rows.forEach(it => {
        if (ids && !ids[it.key]) return;
        const cur = window.Billing.computeCurrent(it);
        const paid = window.Billing.isPaid(it);
        if (!cur.anomalie) { facture += cur.montant; if (paid) encaisse += cur.montant; }
        const arr = items ? (it.arriere || 0) : window.Billing.computeArrears(it, idx, { beforeCycle: sel, fbKey: it.key }).arriere;
        arrieres += arr + (!paid && !cur.anomalie ? cur.montant : 0);
        if ((parseFloat(it.new_index || 0) > 0 && cur.anomalie) || window.Billing.isUnusualConsumption(it)) problemes++;
    });
    return { facture, previsionnel: sel === 'actuel', encaisse, arrieres: !backupsLoaded && sel === 'actuel' ? null : arrieres, avances: 0, ajustements: 0, problemes, historique: sel !== 'actuel' };
}

// Bandeau « migration comptable requise » (président : bouton Migrer).
function renderMigrationBanner() {
    const box = document.getElementById('compta-migration');
    if (!box || !ledgerReady) return;
    ComptaUI.migrationBanner(box, () => window.applyFilter());
}

// ✅ v4 : remplace le donut ET le graphique en barres (noms de zone inclinés)
// par une liste "Top 3 quartiers" toute simple — l'essentiel d'un coup
// d'œil, sans avoir à lire un graphique.
function renderTopQuartiers() {
    const zonesConso = {};
    currentFilteredData.forEach(item => {
        const zone = zoneOf(item);
        // item.conso vient de billing.js (calculé dans applyFilter), déjà à 0
        // pour toute lecture invraisemblable (anomalie).
        const conso = item.conso || 0;
        zonesConso[zone] = (zonesConso[zone] || 0) + conso;
    });
    const sorted = Object.entries(zonesConso).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const box = document.getElementById('top-quartiers');
    if (!box) return;

    if (!sorted.length) {
        box.innerHTML = '<p class="muted-note">Pas encore de données ce mois-ci.</p>';
        return;
    }

    const maxVal = sorted[0][1] || 1;
    box.innerHTML = sorted.map(([zone, val], i) => {
        const pct = Math.max(4, Math.round(val / maxVal * 100));
        return `
        <div class="quartier-row">
            <span class="quartier-rank">${i + 1}</span>
            <div class="quartier-info">
                <div class="quartier-name"><i class="fa-solid fa-house"></i> ${escHtml(zone)}</div>
                <div class="quartier-bar-bg"><div class="quartier-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <span class="quartier-val">${Math.round(val).toLocaleString()} m³</span>
        </div>`;
    }).join('');
}

function updateRelevesProgress() {
    const allEntries = Object.values(storeReleves);
    const total = allEntries.length;
    const relevesCount = allEntries.filter(item => parseFloat(item.new_index || 0) > 0).length;
    const pct = total > 0 ? Math.round((relevesCount / total) * 100) : 0;

    const ratio = document.getElementById('releves-ratio');
    const fill = document.getElementById('releves-bar-fill');
    const pctEl = document.getElementById('releves-progress-pct');

    if (ratio) ratio.textContent = relevesCount + ' / ' + total;
    if (fill) {
        fill.style.width = pct + '%';
        fill.style.background = pct === 100 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
    }
    if (pctEl) pctEl.textContent = pct + '%';
}

// Boutons comptables d'une carte : « Encaisser » (président/trésorier, période actuelle) et « Relevé ».
function comptaButtons(item, due) {
    // ✅ v8 : Encaisser et Annuler restent disponibles en archive (mois passé) — payer une vieille dette
    // ou corriger un paiement mal saisi ne dépend pas du mois affiché à l'écran.
    const invoiceDue = ComptaUI.isMigrated() ? Compta.invoiceAmountDue(ComptaUI.getState(), item.key, isArchiveView ? null : item).total_du : due;
    const canPay = ComptaUI.canCollect() && invoiceDue > 0 && !item.estSolde;
    const ready = ledgerReady && (!isArchiveView || backupsLoaded) && ComptaUI.isMigrated();
    const lock = ready ? '' : `disabled title="${ComptaUI.isMigrated() ? 'Chargement de la comptabilité…' : 'Migration comptable requise'}" style="opacity:.55;cursor:wait"`;
    const pay = canPay ? `<button class="btn-paye btn-sec" onclick="encaisser('${item.key}')" ${lock}><i class="fa-solid fa-hand-holding-dollar"></i><span>Encaisser</span></button>` : '';
    const rel = `<button class="btn-edit btn-ghost" onclick="openReleve('${item.key}')" title="Paiements : suivi des versements"><i class="fa-solid fa-file-invoice"></i><span>Paiements</span></button>`;
    // ✅ v8 : correction d'un paiement saisi par erreur — réservé au président, visible seulement si
    // ce client a au moins un paiement valide. Toute la logique (contre-écriture, FIFO, audit) est
    // dans Compta.buildPaymentCancelOps ; ce bouton ne fait qu'ouvrir la fenêtre de confirmation.
    const canCancelPay = ComptaUI.isPresident() && item.hasValidPayment;
    const cancel = canCancelPay ? `<button class="btn-cancel-pay" onclick="annulerEncaissement('${item.key}')" ${lock} title="Annuler un encaissement saisi par erreur (président)"><i class="fa-solid fa-rotate-left"></i><span>Annuler</span></button>` : '';
    // ✅ v8 : une archive marquée « Payé » (ancien statut, sans encaissement enregistré) peut être remise
    // « Non payé » par le président : la dette réapparaît dans le grand livre (facture tracée).
    const canUnpay = isArchiveView && ComptaUI.isPresident() && item.estSolde && item.factureStatut !== 'annulee';
    const unpay = canUnpay ? `<button class="btn-unpay" onclick="marquerNonPaye('${item.key}')" ${lock} title="Remettre ce mois en « non payé » (président)"><i class="fa-solid fa-rotate-left"></i><span>Non payé</span></button>` : '';
    const details = `<button class="btn-edit btn-ghost" onclick="openDetails('${item.key}')" title="Charger les factures archivées de ce client"><i class="fa-solid fa-list"></i><span>Détails</span></button>`;
    return pay + rel + details + cancel + unpay;
}

const actionLabels = new Set();
function measureActionLabel(label) {
    const text = label.firstElementChild;
    if (!text || !label.isConnected) return;
    const distance = Math.max(0, text.scrollWidth - label.clientWidth);
    label.classList.toggle('is-marquee', distance > 1);
    text.style.setProperty('--marquee-distance', -distance + 'px');
    text.style.setProperty('--marquee-duration', Math.max(5, distance / 22 + 3) + 's');
}
const actionLabelObserver = window.ResizeObserver ? new ResizeObserver(entries => entries.forEach(entry => measureActionLabel(entry.target))) : null;
function syncActionLabels(list) {
    const current = new Set(list.querySelectorAll('.action-label'));
    actionLabels.forEach(label => {
        if (!current.has(label)) { if (actionLabelObserver) actionLabelObserver.unobserve(label); actionLabels.delete(label); }
    });
    current.forEach(label => {
        if (actionLabels.has(label)) return;
        actionLabels.add(label);
        if (actionLabelObserver) actionLabelObserver.observe(label);
        else measureActionLabel(label);
    });
}
if (!actionLabelObserver) window.addEventListener('resize', () => actionLabels.forEach(measureActionLabel));

function compactActions(card, key) {
    const actions = card.querySelector('.citem-actions');
    if (!actions) return;
    const names = { openEditModal: 'edit', encaisser: 'collect', openReleve: 'payments', openDetails: 'details', annulerEncaissement: 'cancel', marquerNonPaye: 'unpay' };
    const chips = [];
    actions.querySelectorAll('button, a').forEach(source => {
        const handler = (source.getAttribute('onclick') || '').match(/^([a-zA-Z]+)\(/);
        const phone = source.getAttribute('href');
        const action = handler ? names[handler[1]] : phone && phone.startsWith('tel:') ? 'call' : null;
        if (!action) return;
        const label = action === 'payments' ? 'Paiements' : action === 'cancel' ? 'Annuler un paiement' : source.textContent.trim();
        const chip = document.createElement(action === 'call' ? 'a' : 'button');
        chip.className = 'client-action-chip'; chip.dataset.clientActions = key; chip.dataset.action = action;
        chip.setAttribute('aria-label', label); chip.title = source.title || label;
        if (action === 'call') chip.href = 'tel:' + phone.slice(4).replace(/[^0-9+]/g, '');
        else { chip.type = 'button'; chip.disabled = !!source.disabled; }
        const icon = source.querySelector('i');
        if (icon) { const copy = icon.cloneNode(true); copy.setAttribute('aria-hidden','true'); chip.appendChild(copy); }
        const viewport = document.createElement('span'); viewport.className = 'action-label'; viewport.setAttribute('aria-hidden','true');
        const text = document.createElement('span'); text.className = 'action-label-text'; text.textContent = label;
        viewport.appendChild(text); chip.appendChild(viewport); chips.push(chip);
    });
    actions.setAttribute('role','group');
    actions.setAttribute('aria-label','Actions pour ' + ((storeReleves[key] || {}).name || 'ce client'));
    if (!chips.length) { actions.textContent = 'Lecture seule'; return; }
    actions.replaceChildren(...chips);
}
// Le focus clavier doit révéler le chip, même quand la ligne a été balayée.
document.getElementById('releves-list').addEventListener('focusin', event => {
    const chip = event.target.closest('[data-client-actions]');
    if (!chip) return;
    const row = chip.parentElement;
    const bounds = row.getBoundingClientRect(), target = chip.getBoundingClientRect();
    if (target.right > bounds.right - 4) row.scrollLeft += target.right - bounds.right + 4;
    else if (target.left < bounds.left + 4) row.scrollLeft -= bounds.left + 4 - target.left;
});
document.getElementById('releves-list').addEventListener('click', event => {
    const chip = event.target.closest('[data-client-actions]');
    if (!chip || chip.disabled || !storeReleves[chip.dataset.clientActions]) return;
    const action = chip.dataset.action, key = chip.dataset.clientActions;
    const handlers = { edit: window.openEditModal, collect: window.encaisser, payments: window.openReleve, details: window.openDetails, cancel: window.annulerEncaissement, unpay: window.marquerNonPaye };
    if (handlers[action]) handlers[action](key);
});

function renderList() {
    if (!statisticsReady()) { renderPendingList(); return; }
    // ✅ FIX XSS : échappement de toute valeur dynamique injectée dans innerHTML.
    const esc = escHtml;
    const listDiv = document.getElementById('releves-list');
    const previousCards = new Map([...listDiv.querySelectorAll(':scope > [data-counter-id]')].map(card => [card.dataset.counterId, card]));
    const desiredCards = [];
    function appendCard(candidate, key) {
        candidate.dataset.counterId = key;
        compactActions(candidate, key);
        const previous = previousCards.get(key);
        const markup = candidate.innerHTML;
        const card = previous || candidate;
        if (previous && (previous.__asuforMarkup !== markup || previous.className !== candidate.className)) {
            previous.className = candidate.className;
            previous.innerHTML = markup;
        }
        card.__asuforMarkup = markup;
        desiredCards.push(card);
    }
    document.getElementById('item-count').innerText = `${currentFilteredData.length} élément(s) trouvé(s)`;
    const dataToShow = currentFilteredData.slice(0, displayLimit);

    // ✅ v3 : pour des utilisateurs novices, la couleur de fond redevient un
    // vrai repère pédagogique (payé=vert, impayé=rouge, anomalie=saumon —
    // délibérément différent du rouge "impayé" pour ne pas confondre les deux
    // situations —, non relevé=gris), mais jamais SEULE : chaque carte porte
    // aussi un symbole/texte explicite (✓/✕/⚠/○) pour rester lisible sans
    // interpréter la couleur.
    dataToShow.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const hasIndex = nIdx > 0;
        const realConso = nIdx - lIdx;
        // Une erreur d'index suppose qu'un index A été saisi ce mois — sinon
        // (compteur pas encore relevé), realConso est mécaniquement négatif
        // sans que ce soit une anomalie : c'est juste "non relevé".
        const isIndexError = hasIndex && realConso < 0;
        const isNotRead = !hasIndex;
        const zoneName = esc(zoneOf(item));
        const div = document.createElement('div');

        // ✅ Anomalie minimale au niveau du compteur : la seule information
        // utile est la raison (texte libre saisi par l'agent) pour laquelle
        // ce compteur n'a pas pu être relevé — pas de page dédiée, pas de
        // photo, pas d'actions de résolution, juste la raison en une ligne.
        const noteHtml = item.note
            ? `<div class="citem-note" title="${esc(item.note)}"><i class="fa-solid fa-circle-info"></i> ${esc(item.note)}</div>`
            : '';

        // 1) Compteur pas encore relevé ce mois : ni erreur, ni statut
        // financier à afficher — une simple action à venir, pas un problème.
        if (isNotRead) {
            const arriere = item.arriere || 0;
            const arriereNote = (arriere > 0
                ? `<div class="citem-band band-danger"><i class="fa-solid fa-circle-exclamation"></i>Arriérés : <b>${arriere.toLocaleString()} F</b></div>`
                : '') + ((item.avance || 0) > 0
                ? `<div class="citem-band band-danger"><i class="fa-solid fa-circle-exclamation"></i>Versement non affecté à vérifier : <b>${item.avance.toLocaleString()} F</b></div>`
                : '');
            // ✅ "Saisir le relevé" est désormais l'action PRINCIPALE de cette
            // carte (bouton plein bleu, comme .btn-paye ailleurs) — c'est
            // l'objectif de la page. Elle reste réservée au président, hors
            // archive ; on ne retire pas cette possibilité, on la met juste
            // en avant plutôt que l'appel, qui n'est qu'un moyen d'y arriver.
            const editOrLock = isPresident()
                ? `<button class="btn-relever" onclick="openEditModal('${item.key}')" title="Saisir le relevé"><i class="fa-solid fa-pen-to-square"></i><span>Relever</span></button>`
                : (isArchiveView ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>` : '');
            // ✅ Appel de l'agent en charge, en action SECONDAIRE (contour,
            // pas un pavé plein) : numéro figé sur le relevé en priorité
            // (agent_tel, écrit à la création du compteur), sinon repli sur
            // la fiche agent actuelle (storeAgents) — même logique de repli
            // que zoneOf() ci-dessus. Non destructif : affiché même en
            // archive et pour tout utilisateur, dès qu'un numéro existe.
            // Le nom de l'agent est affiché à part (ligne dédiée) pour que
            // le libellé du bouton reste court et ne retombe jamais sur 2
            // lignes, quelle que soit la longueur du nom.
            const agentInfo = storeAgents[item.agent_id] || {};
            const agentTelRaw = String(item.agent_tel || agentInfo.agent_tel || '').trim();
            const agentTel = agentTelRaw.replace(/[^0-9+]/g, '');
            const agentName = String(item.agent_name || agentInfo.agent || '').trim();
            const agentLine = agentName
                ? `<span class="citem-agent"><i class="fa-solid fa-user"></i>${esc(agentName)}</span>`
                : '';
            const callBtn = agentTel
                ? `<a class="btn-call" href="tel:${esc(agentTel)}" title="Appeler ${esc(agentName || "l'agent")} pour ce compteur non relevé"><i class="fa-solid fa-phone"></i><span>Appeler</span></a>`
                : '';
            div.className = 'item bg-non-releve';
            div.innerHTML = `
                <div class="citem-main">
                    <span class="citem-name">${esc(item.name || 'Inconnu')}</span>
                    <span class="status-pill status-pill-warn">● À relever</span>
                </div>
                <div class="citem-sub">
                    <span><i class="fa-solid fa-location-dot"></i>${zoneName}</span>
                    <span><i class="fa-solid fa-gauge"></i>n°${esc(item.numero_compteur || 'N/A')}</span>
                    <span><i class="fa-solid fa-droplet"></i>Index ${lIdx} m³</span>
                    ${agentLine}
                </div>
                ${arriereNote}
                ${noteHtml}
                <div class="citem-actions">${editOrLock}${callBtn}${comptaButtons(item, item.totalDu || 0)}</div>
            `;
            appendCard(div, item.key);
            return;
        }

        // 2) Erreur d'index (nouveau < ancien) — prend le pas sur le statut
        // financier : on ne présente jamais une consommation/un montant
        // négatifs comme s'ils étaient normaux. Fond volontairement différent
        // du rouge "Impayé" pour ne pas confondre les deux situations.
        // ✅ v4 : "Compteur en erreur" — moins technique qu'"Anomalie de relevé".
        if (isIndexError) {
            const canFix = isPresident();
            const fixOrLock = canFix
                ? `<button class="btn-edit btn-fix" onclick="openEditModal('${item.key}')"><i class="fa-solid fa-pen-to-square"></i> Corriger le relevé</button>`
                : (isArchiveView ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>` : '');
            div.className = 'item bg-anomalie';
            div.innerHTML = `
                <div class="citem-main">
                    <span class="citem-name">${esc(item.name || 'Inconnu')}</span>
                    <span class="status-pill status-pill-anomaly">⚠ Compteur en erreur</span>
                </div>
                <div class="citem-sub">
                    <span><i class="fa-solid fa-location-dot"></i>${zoneName}</span>
                    <span><i class="fa-solid fa-gauge"></i>Compteur n°${esc(item.numero_compteur || 'N/A')}</span>
                </div>
                <div style="font-size:0.85rem; color:var(--text-main);">Ancien index : <b>${lIdx} m³</b> → Nouvel index : <b>${nIdx} m³</b></div>
                <div style="font-size:0.78rem; color:var(--text-sub);">Le nouvel index est inférieur à l'ancien : ce relevé doit être corrigé.</div>
                ${noteHtml}
                ${fixOrLock ? `<div class="citem-actions">${fixOrLock}</div>` : ''}
            `;
            appendCard(div, item.key);
            return;
        }

        const calculatedAmount = item.calculatedAmount || 0;
        const arriere = item.arriere || 0;
        const avance = item.avance || 0;
        const totalDu = (item.totalDu != null) ? item.totalDu : calculatedAmount;
        const isPaid = !!item.estSolde;
        // Détail : mois + arriérés − avance (seulement quand il y a quelque chose à expliquer)
        const arriereHtml = !ComptaUI.isMigrated() && !backupsLoaded ? '<div class="stats-pending-note">Mois courant uniquement — arriérés historiques non chargés.</div>' : ((arriere > 0 || avance > 0) && !isPaid)
            ? `<div style="font-size:0.8rem;color:var(--danger);font-weight:700;">${isArchiveView ? 'Facture' : 'Mois'} : ${calculatedAmount.toLocaleString()} F + Arriérés : ${arriere.toLocaleString()} F${avance > 0 ? ` − Versement non affecté (à vérifier) : ${avance.toLocaleString()} F` : ''}</div>`
            : (avance > 0 ? `<div style="font-size:0.8rem;color:#9a3412;font-weight:700;">Versement non affecté à vérifier : ${avance.toLocaleString()} F</div>` : '');
        const factStatut = item.factureStatut ? { payee: '✓ Facture payée', partielle: '◐ Facture partielle', ouverte: '✕ Facture ouverte', annulee: '⊘ Facture annulée' }[item.factureStatut] : null;

        // Fuite (> 100 m³) : consommation plausible mais suspecte — reste
        // affichée normalement, avec une simple alerte en plus (contrairement
        // à l'erreur d'index, ce n'est pas une donnée aberrante).
        const anomalyHtml = window.Billing.isUnusualConsumption(item)
            ? `<div class="leak-alert"><i class="fa-solid fa-triangle-exclamation"></i> Consommation inhabituelle, à vérifier (&gt; 100 m³)</div>`
            : '';

        let auditHtml = item.last_modified_by
            ? `<span class="audit-trail">Modifié par ${esc(item.last_modified_by)} le ${new Date(item.last_modified_at).toLocaleDateString()}</span>`
            : '';

        // Badge relevé affiché quand le filtre "Relevés uniquement" est actif
        const relevesBadge = (releveFilter === 'releves')
            ? `<span class="badge-releve"><i class="fa-solid fa-gauge-high"></i> Relevé</span>`
            : '';

        // ✅ v3 : icône + texte (« Modifier ») au lieu d'une icône seule — plus
        // explicite pour un utilisateur novice.
        // ✅ Action secondaire de la carte (voir statusBtn ci-dessous pour
        // l'action principale) — même hiérarchie que sur la carte "à relever".
        // ✅ Aussi disponible sur une archive : corriger un index d'un mois passé.
        const editBtn = isPresident()
            ? `<button class="btn-edit" onclick="openEditModal('${item.key}')" title="Modifier les données"><i class="fa-solid fa-pen-to-square"></i> Modifier</button>`
            : '';

        // ✅ v7 : « Encaisser » ouvre la fenêtre de paiement (partiel, avance, reçu) ; la correction
        // d'un paiement se fait depuis le relevé de compte (annulation tracée par le président).
        const statusBtn = comptaButtons(item, totalDu);

        // ✅ v3 : le fond coloré redevient le repère principal (payé=vert,
        // impayé=rouge) pour des utilisateurs novices — toujours doublé d'un
        // badge texte explicite (✓/✕), jamais la couleur seule.
        div.className = `item ${isPaid ? 'bg-paye' : 'bg-impaye'} ${window.Billing.isUnusualConsumption(item) ? 'bg-alerte-fuite' : ''}`;

        // ✅ v4 : carte empilée — nom + montant en gros en tête (l'essentiel
        // d'un coup d'œil), détails (quartier, compteur, relevé) en dessous
        // en gris avec icônes, actions en pleine largeur en bas.
        div.innerHTML = `
            <div class="citem-main">
                <span class="citem-name">${esc(item.name || 'Inconnu')}${relevesBadge}</span>
                <span class="citem-amt" style="color: ${isPaid ? 'var(--success)' : 'var(--danger)'}">${totalDu.toLocaleString()} F</span>
            </div>
            <div class="citem-sub">
                <span><i class="fa-solid fa-location-dot"></i>${zoneName}</span>
                <span><i class="fa-solid fa-gauge"></i>Compteur n°${esc(item.numero_compteur || 'N/A')}</span>
                <span><i class="fa-solid fa-droplet"></i>${nIdx} m³ (préc. ${lIdx})</span>
            </div>
            <span class="status-pill ${isPaid ? 'status-pill-paid' : 'status-pill-unpaid'}">${factStatut || (isPaid ? '✓ Payé' : '✕ Impayé')}</span>
            ${arriereHtml}
            ${auditHtml}
            ${anomalyHtml}
            ${noteHtml}
            <div class="citem-actions">
                ${statusBtn}
                ${editBtn}
            </div>
        `;
        appendCard(div, item.key);
    });

    const wanted = new Set(desiredCards);
    [...listDiv.children].forEach(card => { if (!wanted.has(card)) card.remove(); });
    let cursor = listDiv.firstElementChild;
    desiredCards.forEach(card => {
        if (card === cursor) cursor = cursor.nextElementSibling;
        else listDiv.insertBefore(card, cursor);
    });
    syncActionLabels(listDiv);
    const btnLoadMore = document.getElementById('btn-load-more');
    if (currentFilteredData.length > displayLimit) {
        btnLoadMore.style.display = "block";
        btnLoadMore.innerText = `⬇️ Charger plus (${currentFilteredData.length - displayLimit} restants)`;
    } else {
        btnLoadMore.style.display = "none";
    }
}

window.openEditModal = function(key) {
    if (!isPresident()) { showToast("⛔ Seul le président peut modifier ces données.", true); return; }
    const item = storeReleves[key];
    if (!item) {
        showToast("Relevé introuvable.", true);
        return;
    }
    document.getElementById('edit-key').value = key;
    document.getElementById('edit-name').value = item.name || '';
    document.getElementById('edit-compteur').value = item.numero_compteur || '';
    document.getElementById('edit-last-index').value = item.last_index || '';
    document.getElementById('edit-new-index').value = item.new_index || '';
    document.getElementById('edit-facteur').value = item.facteur || '';
    const titleEl = document.getElementById('edit-modal-title');
    if (titleEl) {
        titleEl.textContent = isArchiveView
            ? `Modifier le relevé — ${monthLabelFR(currentSelection)}`
            : 'Modifier le relevé';
    }
    const noteEl = document.getElementById('edit-archive-note');
    if (noteEl) noteEl.style.display = isArchiveView ? 'block' : 'none';
    document.getElementById('edit-modal').style.display = 'flex';
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').style.display = 'none';
};

// ✅ CORRECTION : submitEdit() exposé globalement (le form est maintenant un div dans le HTML)
window.submitEdit = function() {
    if (!isPresident()) {
        showToast("⛔ Accès refusé : Seul le président peut modifier ces données.", true);
        closeEditModal();
        return;
    }

    const key = document.getElementById('edit-key').value;
    if (!key) return;

    const nameVal    = document.getElementById('edit-name').value.trim();
    const cptVal     = document.getElementById('edit-compteur').value.trim();
    const lastIdx    = parseFloat(document.getElementById('edit-last-index').value);
    const newIdx     = parseFloat(document.getElementById('edit-new-index').value);
    const facteurVal = parseFloat(document.getElementById('edit-facteur').value);

    if (!nameVal) { showToast("Le nom du client est requis.", true); return; }
    if (isNaN(lastIdx) || isNaN(newIdx) || isNaN(facteurVal)) {
        showToast("Les valeurs d'index et facteur doivent être des nombres.", true);
        return;
    }
    if (newIdx < lastIdx) {
        if (!confirm("Le nouvel index est inférieur à l'ancien. Confirmer quand même ?")) return;
    }

    if (!currentActivePath) {
        showToast("Erreur : Chemin de base de données inconnu.", true);
        return;
    }

    const updatedData = {
        name:             nameVal,
        numero_compteur:  cptVal,
        last_index:       lastIdx,
        new_index:        newIdx,
        facteur:          facteurVal,
        last_modified_by: currentUser,
        last_modified_at: new Date().toISOString()
    };

    const dbPath = `${currentActivePath}/${key}`;
    const updates = {};
    Object.entries(updatedData).forEach(([field, val]) => { updates[`${dbPath}/${field}`] = val; });

    // ✅ Archive : si le nouvel index d'un mois passé change, l'ancien index du
    // mois SUIVANT doit suivre (sinon la consommation du mois suivant est
    // faussée). Le mois suivant est l'archive d'après, ou la base active si
    // l'archive modifiée est la plus récente.
    let propagatedTo = null;
    const editedCycle = currentSelection;
    const previousNewIdx = parseFloat((storeReleves[key] || {}).new_index);
    if (isArchiveView && newIdx !== previousNewIdx) {
        const next = nextCycleTarget(editedCycle, key);
        if (next && confirm(`Reporter aussi ce nouvel index (${newIdx}) comme ancien index de ${next.label} ?`)) {
            updates[`${next.path}/last_index`] = String(newIdx);
            propagatedTo = next;
        }
    }

    const done = (msgExtra) => {
        // Garder le cache des archives cohérent.
        if (isArchiveView) patchBackupCache(editedCycle, key, updatedData);
        if (propagatedTo && propagatedTo.cycle !== 'actuel') {
            patchBackupCache(propagatedTo.cycle, key, { last_index: String(newIdx) });
        }
        showToast((propagatedTo
            ? `✅ Relevé mis à jour (report sur ${propagatedTo.label}).`
            : "✅ Données du compteur mises à jour !") + (msgExtra || ''));
        closeEditModal();
    };

    // ✅ v7 : un relevé ARCHIVÉ corrigé après la migration ne réécrit jamais la facture figée :
    // l'écart devient un ajustement « correction » validé (ou une facture « correction_releve »
    // si le relevé était en anomalie), écrit dans la MÊME opération atomique que la correction.
    if (isArchiveView && ComptaUI.isMigrated()) {
        const newRecord = { ...(storeReleves[key] || {}), ...updatedData };
        ComptaUI.run((St, base) => {
            if (propagatedTo && propagatedTo.cycle === 'actuel') Compta.validateReadingPayments(St,key,{last_index:newIdx});
            const c = Compta.buildArchiveCorrectionOps(St, { ...base, cycle: editedCycle, compteurId: key, newRecord, motif: `Correction du relevé ${monthLabelFR(editedCycle)} (index ${lastIdx} → ${newIdx})` });
            return { updates: Object.assign({}, updates, c.updates), correction: c };
        }).then((r) => {
            const c = r && r.correction;
            done(c && c.action === 'ajustement' ? ` Facture corrigée par ajustement (${c.ecart > 0 ? '+' : ''}${c.ecart.toLocaleString()} F).`
                : (c && c.action === 'facture' ? ` Facture créée (${c.ecart.toLocaleString()} F).` : ''));
        }).catch(err => showToast("Erreur lors de la mise à jour : " + (err.message || err), true));
        return;
    }

    if (ComptaUI.isMigrated()) {
        ComptaUI.run((St) => { Compta.validateReadingPayments(St,key,{...(storeReleves[key]||{}),...updatedData}); return {updates}; }).then(() => done()).catch(err => showToast('Erreur : '+err.message,true));
        return;
    }
    update(ref(db), updates)
        .then(() => done())
        .catch(err => showToast("Erreur lors de la mise à jour : " + err, true));
};

// Cible du report d'index pour le mois qui suit `cycle` : archive suivante
// (si le compteur y figure) ou, à défaut d'archive plus récente, base active.
function nextCycleTarget(cycle, key) {
    const later = Object.keys(allBackupsCache).filter(c => c > cycle).sort();
    if (later.length) {
        const nextCycle = later[0];
        const donnees = (allBackupsCache[nextCycle] || {}).donnees || {};
        if (!donnees[key]) return null;
        return {
            cycle: nextCycle,
            label: monthLabelFR(nextCycle) + ' (archive)',
            path: `${P.backup}/${nextCycle}/donnees/${key}`
        };
    }
    return { cycle: 'actuel', label: 'la période actuelle', path: `${P.compteurs}/${key}` };
}

function patchBackupCache(cycle, key, fields) {
    const donnees = allBackupsCache[cycle] && allBackupsCache[cycle].donnees;
    if (donnees && donnees[key]) { donnees[key] = { ...donnees[key], ...fields }; invalidateBackupCalculations(); }
}

// Fermer le modal en cliquant sur l'overlay
const editModal = document.getElementById('edit-modal');
if (editModal) {
    editModal.addEventListener('click', function(e) {
        if (e.target === this) closeEditModal();
    });
}

function handleScroll() {
    const listElement = document.getElementById('scrollable-list');
    const isBottomWindow = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 50;
    const isBottomDiv = listElement && (listElement.scrollTop + listElement.clientHeight) >= listElement.scrollHeight - 50;
    const topBtn = document.getElementById('back-to-top');
    if (window.scrollY > 300 || (listElement && listElement.scrollTop > 300)) topBtn.style.display = "block";
    else topBtn.style.display = "none";
    if ((isBottomWindow || isBottomDiv) && currentFilteredData.length > displayLimit) window.loadMore();
}

window.addEventListener('scroll', handleScroll);
document.addEventListener("DOMContentLoaded", () => {
    const listSection = document.getElementById('scrollable-list');
    if (listSection) listSection.addEventListener('scroll', handleScroll);
});

// Écouteur d'état d'authentification requis pour valider les droits de lecture Realtime Database
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (window.AsuforLoader) AsuforLoader.update('Chargement des relevés…');
        loadForageBranding();
        window.startSync();
        // ✅ v85 : rappel de réabonnement (1er au 12 du mois, tant que le mois n'est pas marqué payé)
        if (window.AsuforAbonnement && P.base) window.AsuforAbonnement.init({ db, ref, onValue, set, basePath: P.base });
    } else {
        // ✅ CORRECTION v4 : message visible (plus de redirection silencieuse)
        // + nettoyage centralisé via security.js, cohérent avec les autres pages.
        if (window.AsuforLoader) {
            AsuforLoader.fail('Session expirée ou invalide. Reconnexion nécessaire.');
        }
        if (typeof window.handleFirebaseSessionLoss === 'function') {
            window.handleFirebaseSessionLoss(
                'stats.js : onAuthStateChanged(user=null)',
                (msg) => showToast(msg, true)
            );
        } else {
            console.error("Accès Firebase refusé : Session utilisateur non valide.");
            localStorage.removeItem('asufor_session');
            window.location.replace('../index.html');
        }
    }
});

// --- EXPORT PDF DES IMPAYÉS ---
window.exportPDFImpayes = function() {
    if (!statisticsReady()) { showToast('Les montants sont encore en cours de vérification.', true); return; }
    if (typeof window.jspdf === 'undefined') {
        showToast("Erreur : La bibliothèque PDF n'est pas chargée.", true);
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Formatage du montant : 10 500 FCFA (espace ordinaire, compatible jsPDF)
    const formatMontant = (amount) => {
        const n = Math.round(amount || 0);
        return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA';
    };

    // Période affichée dans l'entête
    const selectedPeriod = document.getElementById('month-filter').value;
    let periodLabel = '';
    if (selectedPeriod === 'actuel') {
        const now = new Date();
        periodLabel = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    } else {
        const [year, month] = selectedPeriod.split('-');
        const d = new Date(parseInt(year), parseInt(month) - 1, 1);
        periodLabel = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    }

    // Exclure les payés ET les montants à 0 (total dû = facture du mois + arriérés)
    const impayes = currentFilteredData.filter(item => {
        const du = (item.totalDu != null) ? item.totalDu : (item.calculatedAmount || 0);
        return !item.estSolde && du > 0;
    });

    if (impayes.length === 0) {
        showToast("Aucun impayé trouvé pour cette sélection.", true);
        return;
    }

    doc.setFontSize(16);
    doc.setTextColor(239, 68, 68);
    doc.text("Liste des Impayés - " + forageBranding, 14, 15);

    doc.setFontSize(11);
    doc.setTextColor(60, 60, 60);
    doc.text(`Période : ${periodLabel}`, 14, 23);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Date d'export : ${new Date().toLocaleDateString('fr-FR')}`, 14, 30);
    doc.text(`Nombre de compteurs : ${impayes.length}`, 14, 36);

    const tableColumn = ["Client", "N° Compteur", "Zone", "Montant"];
    const tableRows = [];
    let totalImpaye = 0;

    impayes.forEach(item => {
        const zoneName = zoneOf(item);
        const clientName = item.name || "Inconnu";
        const numCompteur = item.numero_compteur || "N/A";
        const montant = (item.totalDu != null) ? item.totalDu : (item.calculatedAmount || 0);

        totalImpaye += montant;

        tableRows.push([
            clientName,
            numCompteur,
            zoneName,
            formatMontant(montant)
        ]);
    });

    tableRows.push([
        { content: 'TOTAL À RECOUVRER', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', textColor: [239, 68, 68] } },
        { content: formatMontant(totalImpaye), styles: { fontStyle: 'bold', textColor: [239, 68, 68] } }
    ]);

    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: 41,
        theme: 'striped',
        headStyles: { fillColor: [239, 68, 68] },
        styles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [254, 242, 242] }
    });

    const dateStr = new Date().toISOString().split('T')[0];
    doc.save(`SatigueEau_Impayes_${dateStr}.pdf`);
    showToast("✅ Fichier PDF des impayés généré avec succès !");
};
