import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, onChildChanged, onChildRemoved, update, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ✅ CORRECTION : utiliser la config Firebase centralisée (firebase-config.js chargé dans stats.html)
const firebaseConfig = window.ASUFOR_FIREBASE_CONFIG;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
// ✅ Chemins Firebase du forage courant, résolus dynamiquement (namespacé Asufor/{forageKey}/…)
const P = window.ForageContext.paths();

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
let prevMonthData = {}; 
let unsubCurrentMonth = null; 

let currentTab = 'all';
// ✅ v2 : Relevés/Non relevés quittent la ligne d'onglets pour un filtre
// secondaire indépendant (voir setQuickFilter) — la ligne d'onglets se
// limite désormais à Tous / Payés / Impayés / Anomalies.
let releveFilter = 'all';
// ✅ v5 : filtre actif quand on clique un quartier dans "Où consomme-t-on le
// plus ?" — null = pas de filtre de zone.
let zoneFilter = null;
// ✅ v5 : hors ligne — bloque les actions financières (jamais d'écriture à
// l'aveugle), reprise automatique dès le retour du réseau.
let isOffline = !navigator.onLine;
// ✅ v5 : micro-interaction — flash discret sur une carte qui vient d'être
// encaissée (clé → timestamp de l'action optimiste).
const justPaidKeys = new Map();
// ✅ v5 : détection de conflit — timestamp de dernière modif au moment où le
// modal d'édition a été ouvert, pour repérer une écriture concurrente.
let editingSnapshotModifiedAt = null;
// ✅ v2 : vrai en consultant une période archivée — verrouille les actions
// de modification (statut, édition) dans renderList() et les handlers.
let isArchiveView = false;
let displayLimit = 100;
let currentFilteredData = [];
let currentActivePath = "";

// Cache de l'arbre complet asufor_backup (pour billing.js : arriérés + cascade paiement)
let allBackupsCache = {};

let currentUser = 'Trésorier/Admin';

// ✅ Branding par forage : nom affiché (en-tête, titre, PDF impayés) résolu
// depuis Asufor/{forageKey}/config.nom, jamais "Diandioly" en dur — chaque
// village doit voir son propre nom.
let forageBranding = 'ASUFOR';
async function loadForageBranding() {
    try {
        const snap = await get(ref(db, P.config));
        const cfg = snap.exists() ? snap.val() : {};
        if (cfg.nom) {
            forageBranding = cfg.nom;
            document.title = cfg.nom + ' – Statistiques';
            const titleEl = document.getElementById('forage-title');
            if (titleEl) titleEl.textContent = cfg.nom;
        }
    } catch (_) { /* garde le repli générique */ }
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
function showToast(msg, isError = false) {
    const toast = document.getElementById("toast");
    toast.innerText = msg;
    toast.style.backgroundColor = isError ? "var(--danger)" : "var(--success)";
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

// ✅ v5 : chips de filtre rapide (remplacent les 4 onglets + le sélecteur
// Relevés/Non relevés séparé) — "À relever" retrouve le même filtre que
// l'ancien <select releve-filter value="non-releves">.
const QUICK_FILTERS = {
    all:       { tab: 'all',       releve: 'all',          chip: 'chip-all' },
    paye:      { tab: 'paye',      releve: 'all',          chip: 'chip-paye' },
    impaye:    { tab: 'impaye',    releve: 'all',          chip: 'chip-impaye' },
    arelever:  { tab: 'all',       releve: 'non-releves',  chip: 'chip-arelever' },
    anomalies: { tab: 'anomalies', releve: 'all',          chip: 'chip-anomalies' }
};
window.setQuickFilter = function(name) {
    const cfg = QUICK_FILTERS[name] || QUICK_FILTERS.all;
    currentTab = cfg.tab;
    releveFilter = cfg.releve;
    displayLimit = 100;
    document.querySelectorAll('.chip').forEach(btn => btn.classList.remove('active'));
    const chipEl = document.getElementById(cfg.chip);
    if (chipEl) chipEl.classList.add('active');
    const progressCard = document.getElementById('releves-progress-card');
    if (progressCard) progressCard.style.display = (releveFilter === 'releves' || releveFilter === 'non-releves') ? 'block' : 'none';
    window.applyFilter();
};

// ✅ v5 : un clic sur un quartier ("Où consomme-t-on le plus ?") filtre la
// liste sur ce quartier — un petit chip amovible rappelle le filtre actif.
window.filterByZone = function(zone) {
    zoneFilter = zone;
    displayLimit = 100;
    const chip = document.getElementById('zone-filter-chip');
    const label = document.getElementById('zone-filter-label');
    if (chip) chip.classList.add('visible');
    if (label) label.textContent = 'Quartier : ' + zone;
    window.applyFilter();
    const listSection = document.getElementById('scrollable-list');
    if (listSection) listSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.clearZoneFilter = function() {
    zoneFilter = null;
    const chip = document.getElementById('zone-filter-chip');
    if (chip) chip.classList.remove('visible');
    window.applyFilter();
};

// ✅ v5 : action du bouton "Réinitialiser les filtres" de l'état vide.
window.resetAllFilters = function() {
    const search = document.getElementById('search-client');
    const sort = document.getElementById('sort-spinner');
    const agent = document.getElementById('agent-spinner');
    if (search) search.value = '';
    if (sort) sort.value = 'recent';
    if (agent) agent.value = 'all';
    window.clearZoneFilter();
    window.setQuickFilter('all');
};

// ✅ v5 : menu ⋮ (actions secondaires d'une carte) — un seul menu ouvert à la
// fois, fermé au clic en dehors (voir l'écouteur global plus bas).
window.toggleCardMenu = function(event, menuId) {
    event.stopPropagation();
    const dropdown = document.getElementById(menuId);
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains('open');
    document.querySelectorAll('.card-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    if (!wasOpen) dropdown.classList.add('open');
};

// ✅ v5 : un seul bouton "Exporter" ouvrant PDF / Excel / Imprimer, au lieu
// de deux boutons fixes qui prenaient beaucoup de largeur sur mobile.
window.toggleExportMenu = function(event) {
    event.stopPropagation();
    const menu = document.getElementById('export-menu');
    const btn = document.getElementById('btn-export-toggle');
    if (!menu) return;
    const willOpen = !menu.classList.contains('open');
    menu.classList.toggle('open', willOpen);
    if (btn) btn.classList.toggle('open', willOpen);
};
function closeExportMenu() {
    const menu = document.getElementById('export-menu');
    const btn = document.getElementById('btn-export-toggle');
    if (menu) menu.classList.remove('open');
    if (btn) btn.classList.remove('open');
}
window.closeExportMenuAnd = function(fn) {
    closeExportMenu();
    if (typeof fn === 'function') fn();
};

// Ferme les menus ouverts (carte, export) au clic en dehors.
document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-menu-wrap')) {
        document.querySelectorAll('.card-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    }
    if (!e.target.closest('.export-wrap')) closeExportMenu();
});

// --- ÉTAT DE SYNCHRONISATION (discret, uniquement pour NOS écritures) ---
function pingSync(ok) {
    const el = document.getElementById('sync-indicator');
    const txt = document.getElementById('sync-indicator-text');
    if (!el) return;
    el.classList.toggle('sync-error', !ok);
    if (txt) txt.textContent = ok ? 'Synchronisé' : 'Échec de synchro';
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 2200);
}

// --- GESTION HORS LIGNE ---
// ✅ v5 : on bloque les actions d'écriture (jamais de paiement/edit "à
// l'aveugle") plutôt que de les mettre en file pour rejouer plus tard — trop
// risqué pour un système de facturation (double encaissement en cas de
// conflit). Dès le retour du réseau, on rafraîchit automatiquement les
// données affichées.
function updateOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.toggle('visible', isOffline);
}
window.addEventListener('offline', () => {
    isOffline = true;
    updateOfflineBanner();
    showToast('⚠️ Connexion perdue : encaissement et modifications bloqués.', true);
});
window.addEventListener('online', () => {
    isOffline = false;
    updateOfflineBanner();
    showToast('✅ Connexion rétablie : actualisation…');
    const monthSel = document.getElementById('month-filter');
    loadDataForMonth(monthSel ? monthSel.value : 'actuel');
});
updateOfflineBanner();

window.loadMore = function() {
    displayLimit += 100;
    renderList();
};

window.scrollToTop = function() {
    const listSection = document.getElementById('scrollable-list');
    if (listSection) listSection.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// --- AUDIT TRAIL : MODIFICATION DU STATUT ---
// ✅ v4 : ton adouci ("Corriger" un paiement, pas une alerte "ATTENTION") —
// cette action reste réversible, elle ne mérite pas un ton alarmant.
window.confirmRevoke = function(key) {
    if (isArchiveView) { showToast("🔒 Archive : lecture seule, modification impossible.", true); return; }
    if (confirm("Remettre cette facture en \"à encaisser\" ? Elle ne sera plus marquée comme payée.")) {
        window.updateStatus(key, 'impaye');
    }
};

window.updateStatus = function(key, newStatus) {
    // ✅ v2 : verrou défensif — la carte ne propose déjà plus ce bouton sur une
    // archive, mais on bloque aussi l'appel direct (deuxième ligne de défense).
    if (isArchiveView) { showToast("🔒 Archive : lecture seule, modification impossible.", true); return; }
    // ✅ v5 : hors ligne, on bloque plutôt que d'écrire à l'aveugle (risque de
    // double encaissement une fois la connexion revenue).
    if (isOffline) { showToast("⚠️ Vous êtes hors ligne : action impossible.", true); return; }
    if (!currentActivePath) {
        showToast("Erreur : Chemin de base de données inconnu.", true);
        return;
    }

    const now = new Date().toISOString();
    const record = storeReleves[key] || {};

    // La cascade complète (nettoyage base active + historique backup) n'a de sens
    // que sur la base ACTIVE. Sur une archive on se contente d'un simple flip.
    const onActiveBase = (currentActivePath === P.compteurs);

    let updates;
    if (window.Billing && onActiveBase) {
        const indexedBackups = window.Billing.indexBackups(allBackupsCache);
        if (newStatus === 'paye') {
            // §3 Régularisation : status→paye, arriere→0, + tous les cycles impayés de l'historique
            updates = window.Billing.buildPaymentUpdates({
                activePath: currentActivePath,
                activeKey: key,
                record,
                indexedBackups,
                backupPath: P.backup,
                paidBy: currentUser,
                timestamp: now
            }).updates;
        } else {
            // Révocation : repasse la base active en impayé (l'historique reste inchangé)
            updates = window.Billing.buildRevokeUpdates({
                activePath: currentActivePath,
                activeKey: key,
                paidBy: currentUser,
                timestamp: now
            }).updates;
        }
    } else {
        // Repli : archive consultée, ou billing.js indisponible → flip minimal
        const p = `${currentActivePath}/${key}`;
        updates = {
            [`${p}/status`]: newStatus,
            [`${p}/statut`]: newStatus === 'paye',
            [`${p}/last_modified_by`]: currentUser,
            [`${p}/last_modified_at`]: now
        };
        if (newStatus === 'paye') updates[`${p}/date_paiement`] = now;
    }

    // ✅ CORRECTION : mise à jour optimiste — reflète le changement dans la liste
    //   immédiatement, sans attendre l'aller-retour réseau vers Firebase. Le
    //   listener onValue (loadDataForMonth) confirmera/réconciliera silencieusement
    //   une fois l'écriture propagée ; en cas d'échec, on annule localement.
    const previousRecord = storeReleves[key] ? { ...storeReleves[key] } : null;
    if (storeReleves[key]) {
        storeReleves[key] = {
            ...storeReleves[key],
            status: newStatus,
            statut: newStatus === 'paye',
            arriere: newStatus === 'paye' ? 0 : storeReleves[key].arriere
        };
        // ✅ v5 : micro-interaction — flash discret sur la carte dès l'action
        // optimiste (pas besoin d'attendre la confirmation réseau).
        if (newStatus === 'paye') justPaidKeys.set(key, Date.now());
        window.applyFilter();
    }

    update(ref(db), updates)
        .then(() => {
            pingSync(true);
            showToast(newStatus === 'paye' ? "✅ Facture encaissée ! Historique régularisé." : "↩️ Paiement corrigé : facture remise à encaisser.");
        })
        .catch(err => {
            pingSync(false);
            if (previousRecord) {
                storeReleves[key] = previousRecord;
                justPaidKeys.delete(key);
                window.applyFilter();
            }
            showToast("Erreur réseau : " + err, true);
        });
};

// --- EXPORT CSV ---
// ✅ v5 : "Imprimer" — troisième option du menu Exporter. Affiche
// temporairement TOUTE la liste filtrée (au-delà de displayLimit) pour que
// l'impression ne se limite pas aux éléments déjà chargés à l'écran.
window.exportPrint = function() {
    if (currentFilteredData.length === 0) {
        showToast("La liste est vide, rien à imprimer.", true);
        return;
    }
    const previousLimit = displayLimit;
    displayLimit = currentFilteredData.length;
    renderList();
    const restore = () => {
        displayLimit = previousLimit;
        renderList();
        window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
};

window.exportCSV = function() {
    if (currentFilteredData.length === 0) {
        showToast("La liste est vide, rien à exporter.", true);
        return;
    }
    let csvContent = "\uFEFF"; 
    csvContent += "Client;N° Compteur;Zone;Ancien Index;Nouvel Index;Conso (m3);Facteur;Montant Mois (CFA);Arriérés (CFA);Total dû (CFA);Statut;Dernière Modif;Par\n";

    currentFilteredData.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const conso = Math.max(0, nIdx - lIdx);
        const facteur = parseFloat(item.facteur || 0);
        // ✅ Valeurs issues de billing.js (calculées dans applyFilter), pas d'un recalcul divergent
        const calculatedAmount = item.calculatedAmount || 0;
        const arriere = item.arriere || 0;
        const totalDu = (item.totalDu != null) ? item.totalDu : calculatedAmount;

        const isPaid = item.status === 'paye' ? 'Paye' : 'Impaye';
        const zoneName = zoneOf(item);
        const clientName = (item.name || "Client Inconnu").replace(/;/g, ' ');
        const numCompteur = (item.numero_compteur || "").replace(/;/g, ' ');
        const lastModif = item.last_modified_at ? new Date(item.last_modified_at).toLocaleString() : 'N/A';
        const par = item.last_modified_by || 'N/A';

        csvContent += `${clientName};${numCompteur};${zoneName};${lIdx};${nIdx};${conso};${facteur};${calculatedAmount};${arriere};${totalDu};${isPaid};${lastModif};${par}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ASUFOR_Export_${new Date().toISOString().split('T')[0]}.csv`;
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

// --- INITIALISATION DU MENU DÉROULANT DES MOIS ---
window.initMonthFilter = function() {
    const monthSelect = document.getElementById('month-filter');
    monthSelect.innerHTML = '<option value="actuel">Données actuelles</option>';
    monthSelect.value = "actuel";

    // ✅ Chargement INSTANTANÉ : la liste des relevés (le plus important à
    // l'écran) se charge tout de suite, SANS attendre la liste des archives
    // ci-dessous — les deux se font en parallèle plutôt qu'en série.
    loadDataForMonth("actuel");

    get(ref(db, P.backup)).then((snapshot) => {
        let optionsHtml = '<option value="actuel">Données actuelles</option>';

        if (snapshot.exists()) {
            const backups = snapshot.val();
            allBackupsCache = backups; // conservé pour billing.js (arriérés + cascade paiement)
            const sortedMonths = Object.keys(backups).sort().reverse();

            sortedMonths.forEach(month => {
                optionsHtml += `<option value="${month}">${monthLabelFR(month)} — Archive</option>`;
            });
        }

        const activeValue = monthSelect.value;
        monthSelect.innerHTML = optionsHtml;
        monthSelect.value = activeValue;
    }).catch((error) => {
        console.error("Erreur lors du chargement des périodes:", error);
    });
}

// --- CHARGEMENT DES DONNÉES ---
window.changeMonth = function() {
    const selectedValue = document.getElementById('month-filter').value;
    loadDataForMonth(selectedValue);
};

function cacheKeyFor(dbPath) {
    return 'releves:' + dbPath;
}

async function loadDataForMonth(selection) {
    storeReleves = {};

    if (unsubCurrentMonth) {
        unsubCurrentMonth();
        unsubCurrentMonth = null;
    }

    let dbPath = "";
    let monthForTrend = "";

    if (selection === "actuel") {
        dbPath = P.compteurs;
        const now = new Date();
        monthForTrend = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else {
        dbPath = `${P.backup}/${selection}/donnees`;
        monthForTrend = selection;
    }

    currentActivePath = dbPath;

    // ✅ v2 : une archive est un état historique figé — on verrouille les
    // actions de modification (statut, édition) et on l'indique clairement
    // (bandeau + libellé du bilan), au lieu d'un simple sélecteur technique.
    isArchiveView = (selection !== "actuel");
    const banner = document.getElementById('archive-banner');
    if (banner) banner.classList.toggle('visible', isArchiveView);
    const recapTitle = document.getElementById('recap-title');
    if (recapTitle) recapTitle.textContent = isArchiveView ? `Bilan — ${monthLabelFR(selection)}` : 'Bilan du mois';

    // ✅ Chargement INSTANTANÉ : si une copie locale existe déjà (session
    // précédente ou dernier chargement), on l'affiche immédiatement, sans
    // attendre le réseau — le skeleton/l'overlay bloquant ne s'affichent que
    // si on n'a vraiment rien à montrer tout de suite.
    const cacheKey = cacheKeyFor(dbPath);
    const cached = window.AsuforCache ? window.AsuforCache.read(cacheKey) : null;
    if (cached && typeof cached === 'object') {
        storeReleves = cached;
        document.getElementById('skeleton-loader').style.display = "none";
        document.getElementById('releves-list').innerHTML = "";
        if (window.AsuforLoader) AsuforLoader.hide();
        fetchPreviousMonthStats(monthForTrend);
    } else {
        document.getElementById('skeleton-loader').style.display = "flex";
        document.getElementById('releves-list').innerHTML = "";
    }

    const dataRef = ref(db, dbPath);
    const thisPath = dbPath; // capture : ignorer une réponse tardive si le mois a changé entre-temps

    try {
        const snap = await get(dataRef);
        if (currentActivePath !== thisPath) return; // l'utilisateur a changé de mois pendant le chargement
        storeReleves = snap.val() || {};
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeReleves);
        document.getElementById('skeleton-loader').style.display = "none";
        if (window.AsuforLoader) AsuforLoader.hide();
        fetchPreviousMonthStats(monthForTrend);
    } catch (err) {
        console.error('Firebase relevés :', err.code, err.message);
        if (cached) {
            // ✅ Une copie locale est déjà affichée : on prévient sans bloquer l'écran.
            showToast('⚠️ Connexion indisponible : données locales affichées (peut-être non à jour).', true);
        } else if (window.AsuforLoader) {
            AsuforLoader.fail('Impossible de charger les relevés (' + err.code + '). Session peut-être expirée.');
        }
        return;
    }

    // ✅ Rafraîchissement CIBLÉ : au lieu d'un unique listener sur tout le
    // nœud (qui renvoyait l'arbre COMPLET au moindre changement, même pour la
    // modification d'un seul compteur), on écoute désormais les événements
    // par élément — l'ajout, la modification ou la suppression d'UN compteur
    // ne transmet et ne retraite plus que CET élément, pas toute la liste.
    const unsubAdd = onChildAdded(dataRef, (snap) => {
        if (Object.prototype.hasOwnProperty.call(storeReleves, snap.key)) return; // déjà connu (chargement initial)
        storeReleves[snap.key] = snap.val();
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeReleves);
        window.applyFilter();
    });
    const unsubChange = onChildChanged(dataRef, (snap) => {
        storeReleves[snap.key] = snap.val();
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeReleves);
        window.applyFilter();
    });
    const unsubRemove = onChildRemoved(dataRef, (snap) => {
        delete storeReleves[snap.key];
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeReleves);
        window.applyFilter();
    });
    unsubCurrentMonth = () => { unsubAdd(); unsubChange(); unsubRemove(); };
}

function fetchPreviousMonthStats(baseMonthStr) {
    let yyyy, mm;
    if (baseMonthStr.includes('-')) {
        [yyyy, mm] = baseMonthStr.split('-');
    } else {
        const now = new Date();
        yyyy = now.getFullYear();
        mm = now.getMonth() + 1;
    }
    
    let prevDate = new Date(parseInt(yyyy), parseInt(mm) - 2, 1);
    let prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    
    get(ref(db, `${P.backup}/${prevMonthStr}/donnees`)).then((snap) => {
        prevMonthData = snap.val() || {};
        window.applyFilter();
    }).catch(() => {
        prevMonthData = {};
        window.applyFilter();
    });
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

async function syncAgents() {
    const cacheKey = 'agents:' + P.agents;
    const cachedAgents = window.AsuforCache ? window.AsuforCache.read(cacheKey) : null;
    if (cachedAgents && typeof cachedAgents === 'object') {
        storeAgents = cachedAgents;
        renderAgentSpinner();
    }

    const agentsRef = ref(db, P.agents);
    try {
        const snap = await get(agentsRef);
        storeAgents = snap.val() || {};
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeAgents);
        renderAgentSpinner();
    } catch (err) {
        console.error('Firebase agents :', err.code, err.message);
    }

    // ✅ Rafraîchissement ciblé : un agent ajouté/modifié/supprimé ne renvoie
    // et ne retraite plus que CET agent, pas la liste complète.
    onChildAdded(agentsRef, (snap) => {
        if (Object.prototype.hasOwnProperty.call(storeAgents, snap.key)) return;
        storeAgents[snap.key] = snap.val();
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeAgents);
        renderAgentSpinner();
    });
    onChildChanged(agentsRef, (snap) => {
        storeAgents[snap.key] = snap.val();
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeAgents);
        renderAgentSpinner();
    });
    onChildRemoved(agentsRef, (snap) => {
        delete storeAgents[snap.key];
        if (window.AsuforCache) window.AsuforCache.write(cacheKey, storeAgents);
        renderAgentSpinner();
    });
}

window.startSync = function() {
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
window.applyFilter = function() {
    const selectedId = document.getElementById('agent-spinner').value;
    const searchQuery = document.getElementById('search-client').value.trim();
    const sortOption = document.getElementById('sort-spinner').value;
    
    let entries = Object.entries(storeReleves).map(([key, item]) => ({ key, ...item })).reverse();
    
    let tCFA_Paye = 0; let tCFA_Impaye = 0;
    let tCFA_Paye_Prev = 0; let tCFA_Impaye_Prev = 0;

    Object.values(prevMonthData).forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const conso = Math.max(0, nIdx - lIdx); 
        const facteur = parseFloat(item.facteur || 0);
        const calculatedAmount = conso * facteur;

        if (!isNaN(calculatedAmount)) {
            const isPaid = item.status === 'paye';
            if (isPaid) tCFA_Paye_Prev += calculatedAmount; else tCFA_Impaye_Prev += calculatedAmount;
        }
    });

    let filteredBase = entries.filter(item => {
        if (selectedId !== "all" && item.agent_id !== selectedId) return false;
        // ✅ v5 : filtre de quartier (clic sur "Où consomme-t-on le plus ?")
        if (zoneFilter && zoneOf(item) !== zoneFilter) return false;
        const rawName = item.name || "";
        const rawCompteur = String(item.numero_compteur || "");
        const queryDigits = searchQuery.replace(/\D/g, '');
        const compteurDigits = rawCompteur.replace(/\D/g, '');
        let isCompteurMatch = (queryDigits.length > 0 && compteurDigits.includes(queryDigits));
        let isNameMatch = isFuzzyMatch(searchQuery, rawName);
        return isNameMatch || isCompteurMatch;
    });

    // ✅ FIX : brancher les totaux sur billing.js (source unique de vérité) afin
    //   d'inclure les ARRIÉRÉS, exactement comme le fait déjà l'impression.
    //   Avant, le total « impayés » ne comptait que la facture du mois courant,
    //   d'où une divergence avec les factures imprimées.
    const monthSel = (document.getElementById('month-filter') || {}).value || 'actuel';
    const beforeCycle = (monthSel === 'actuel') ? '9999-99' : monthSel;
    const useBilling = !!(window.Billing && window.Billing.computeStatement);
    const indexedBackups = useBilling ? window.Billing.indexBackups(allBackupsCache) : [];

    // ✅ v5 : PASSE 1 — un seul calcul de facturation par compteur, dont on tire
    // à la fois les totaux (déjà le cas avant) ET les compteurs des chips de
    // filtre rapide (Tous/Payés/Impayés/À relever/Problèmes), indépendamment
    // de l'onglet actif — "Tous 420" reste 420 même sous l'onglet "Payés".
    let consoTotal = 0;
    let countAll = 0, countPaye = 0, countImpaye = 0, countARelever = 0, countAnomalies = 0;
    const computed = [];

    filteredBase.forEach(item => {
        let calculatedAmount, arriere = 0, totalDu;
        if (useBilling) {
            const stmt = window.Billing.computeStatement(item, indexedBackups, { beforeCycle });
            calculatedAmount = stmt.facture_courante; // facture du mois courant
            arriere = stmt.arriere;                   // arriérés cumulés
            totalDu = stmt.total;                     // facture + arriérés
            item.conso = stmt.conso;                  // ✅ 0 si consommation invraisemblable (anomalie)
        } else {
            const nIdx = parseFloat(item.new_index || 0);
            const lIdx = parseFloat(item.last_index || 0);
            const facteur = parseFloat(item.facteur || 0);
            calculatedAmount = Math.max(0, nIdx - lIdx) * facteur;
            totalDu = calculatedAmount;
            item.conso = Math.max(0, nIdx - lIdx);
        }

        item.calculatedAmount = calculatedAmount;
        item.arriere = arriere;
        item.totalDu = totalDu;

        if (isNaN(totalDu)) return;

        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const hasIndex = nIdx > 0;
        const realConso = nIdx - lIdx;
        const isNotRead = !hasIndex;
        const isIndexError = hasIndex && realConso < 0;
        // ✅ Un compteur pas encore relevé (new_index = 0) n'est pas une
        // anomalie — l'erreur d'index suppose qu'un index A été saisi.
        const isAnomaly = (hasIndex && realConso < 0) || realConso > 100;
        const isPaid = item.status === 'paye';

        item._isNotRead = isNotRead;
        item._isIndexError = isIndexError;
        item._isAnomaly = isAnomaly;
        item._isPaid = isPaid;
        item._realConso = realConso;

        if (isPaid) tCFA_Paye += calculatedAmount; else tCFA_Impaye += totalDu; // ✅ inclut désormais les arriérés
        consoTotal += (item.conso || 0);

        countAll++;
        if (isPaid) countPaye++; else countImpaye++;
        if (isNotRead) countARelever++;
        if (isAnomaly) countAnomalies++;

        computed.push(item);
    });

    // ✅ v5 : PASSE 2 — l'onglet actif (chip) + le filtre secondaire filtrent
    // l'affichage, en réutilisant les champs déjà calculés ci-dessus.
    currentFilteredData = computed.filter(item => {
        if (currentTab === 'paye' && !item._isPaid) return false;
        if (currentTab === 'impaye' && item._isPaid) return false;
        if (currentTab === 'anomalies' && !item._isAnomaly) return false;
        if (releveFilter === 'releves' && item._isNotRead) return false;
        if (releveFilter === 'non-releves' && !item._isNotRead) return false;
        return true;
    });

    if (sortOption === "max_amount") currentFilteredData.sort((a, b) => (b.calculatedAmount || 0) - (a.calculatedAmount || 0));
    else if (sortOption === "min_amount") currentFilteredData.sort((a, b) => (a.calculatedAmount || 0) - (b.calculatedAmount || 0));
    else if (sortOption === "zone") currentFilteredData.sort((a, b) => zoneOf(a).localeCompare(zoneOf(b)));
    else if (sortOption === "name") currentFilteredData.sort((a, b) => (a.name || "Z").localeCompare(b.name || "Z"));
    else if (sortOption === "compteur") currentFilteredData.sort((a, b) => {
        const na = String(a.numero_compteur || "").replace(/\D/g, "").padStart(10, "0");
        const nb = String(b.numero_compteur || "").replace(/\D/g, "").padStart(10, "0");
        return na.localeCompare(nb);
    });

    document.getElementById('total-money').innerText = tCFA_Paye.toLocaleString() + " CFA";
    document.getElementById('total-debt').innerText = tCFA_Impaye.toLocaleString() + " CFA";

    // ✅ v5 : chips de filtre rapide — compteurs live, indépendants de l'onglet
    // actif (portée = agent + zone + recherche sélectionnés).
    const setChipCount = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val.toLocaleString(); };
    setChipCount('chip-count-all', countAll);
    setChipCount('chip-count-paye', countPaye);
    setChipCount('chip-count-impaye', countImpaye);
    setChipCount('chip-count-arelever', countARelever);
    setChipCount('chip-count-anomalies', countAnomalies);

    // ✅ v5 : KPI compactes — recouvrement, impayés, consommation totale et
    // compteurs à relever, en plus des 2 montants déjà affichés.
    const recapTotal = tCFA_Paye + tCFA_Impaye;
    const recapPct = recapTotal > 0 ? (tCFA_Paye / recapTotal * 100) : 0;
    const kpiTauxEl = document.getElementById('kpi-taux');
    if (kpiTauxEl) kpiTauxEl.textContent = recapPct.toFixed(1) + ' %';
    const kpiImpayeEl = document.getElementById('kpi-count-impaye');
    if (kpiImpayeEl) kpiImpayeEl.textContent = countImpaye.toLocaleString();
    const kpiConsoEl = document.getElementById('kpi-conso');
    if (kpiConsoEl) kpiConsoEl.textContent = Math.round(consoTotal).toLocaleString() + ' m³';
    const kpiARelevEl = document.getElementById('kpi-count-arelever');
    if (kpiARelevEl) kpiARelevEl.textContent = countARelever.toLocaleString();

    // ✅ v4 : la carte Bilan raconte le mois en une phrase ("Il reste X F à
    // encaisser") plutôt qu'en pourcentage brut, avec une jauge qui va du
    // rouge au vert selon le niveau atteint — plus parlant pour un novice
    // qu'un simple "0,1 % recouvré".
    const recapBar = document.getElementById('recap-bar-fill');
    if (recapBar) {
        recapBar.style.width = Math.min(100, recapPct) + '%';
        recapBar.style.background = recapPct >= 75 ? 'var(--success)' : recapPct >= 40 ? '#f59e0b' : 'var(--danger)';
    }
    const recapStoryEl = document.getElementById('recap-story');
    if (recapStoryEl) {
        recapStoryEl.textContent = tCFA_Impaye > 0
            ? `Il reste ${Math.round(tCFA_Impaye).toLocaleString()} F à encaisser ce mois-ci`
            : '🎉 Tout est encaissé ce mois-ci !';
    }

    // ✅ v2 : la couleur reflète si la variation est une BONNE ou une MAUVAISE
    // nouvelle pour cet indicateur — avant, +294,6 % d'impayés s'affichait en
    // vert (hausse = vert, peu importe le sens), ce qui donnait le message
    // exactement inverse de la réalité.
    // ✅ v4 : mène par un mot simple ("Plutôt bien"/"À surveiller") — le
    // pourcentage exact reste affiché, mais en second plan, moins anxiogène
    // qu'un chiffre brut du type "+294,6 %".
    const calcTrend = (current, prev, elId, goodWhenUp) => {
        const el = document.getElementById(elId);
        if (!el) return;
        if (prev === 0) { el.innerHTML = ""; return; }
        const diff = ((current - prev) / prev) * 100;
        const dirUp = diff >= 0;
        const sign = dirUp ? '+' : '';
        const arrow = dirUp ? '↑' : '↓';
        const isGood = dirUp === goodWhenUp;
        const colorClass = isGood ? 'trend-good' : 'trend-bad';
        const qualifier = isGood ? 'Plutôt bien' : 'À surveiller';
        el.innerHTML = `<span class="${colorClass}">${arrow} ${qualifier} <span class="trend-detail">(${sign}${diff.toFixed(1)}% vs mois dernier)</span></span>`;
    };

    calcTrend(tCFA_Paye, tCFA_Paye_Prev, 'trend-money', true);   // encaissé : une hausse est une bonne nouvelle
    calcTrend(tCFA_Impaye, tCFA_Impaye_Prev, 'trend-debt', false); // impayés : une hausse est une mauvaise nouvelle

    renderList();
    renderTopQuartiers();
    updateRelevesProgress();
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
    // ✅ v5 : chaque ligne est cliquable (data-zone + délégation d'événement
    // ci-dessous) — filtre directement la liste sur ce quartier.
    box.innerHTML = sorted.map(([zone, val], i) => {
        const pct = Math.max(4, Math.round(val / maxVal * 100));
        return `
        <button type="button" class="quartier-row" data-zone="${escHtml(zone)}" title="Filtrer sur ce quartier">
            <span class="quartier-rank">${i + 1}</span>
            <div class="quartier-info">
                <div class="quartier-name"><i class="fa-solid fa-house"></i> ${escHtml(zone)}</div>
                <div class="quartier-bar-bg"><div class="quartier-bar-fill" style="width:${pct}%"></div></div>
            </div>
            <span class="quartier-val">${Math.round(val).toLocaleString()} m³</span>
        </button>`;
    }).join('');
}

// Délégation : un seul écouteur pour toutes les lignes de quartier (évite
// d'attacher un onclick par ligne, régénérées à chaque rendu).
document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('top-quartiers');
    if (box) box.addEventListener('click', (e) => {
        const row = e.target.closest('.quartier-row');
        if (row && row.dataset.zone) window.filterByZone(row.dataset.zone);
    });
});

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

function renderList() {
    // ✅ FIX XSS : échappement de toute valeur dynamique injectée dans innerHTML.
    const esc = escHtml;
    const listDiv = document.getElementById('releves-list');
    listDiv.innerHTML = "";
    document.getElementById('item-count').innerText = `${currentFilteredData.length} élément(s)`;
    const dataToShow = currentFilteredData.slice(0, displayLimit);

    // ✅ v5 : état vide — évite un écran silencieux quand un filtre/recherche
    // ne retourne rien (420 clients, une faute de frappe arrive vite).
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = currentFilteredData.length === 0 ? 'flex' : 'none';

    // ✅ v3 : pour des utilisateurs novices, la couleur de fond redevient un
    // vrai repère pédagogique (payé=vert, impayé=rouge, anomalie=saumon —
    // délibérément différent du rouge "impayé" pour ne pas confondre les deux
    // situations —, non relevé=gris), mais jamais SEULE : chaque carte porte
    // aussi un symbole/texte explicite (✓/✕/⚠/○) pour rester lisible sans
    // interpréter la couleur.
    // ✅ v5 : carte compactée sur 3-4 courtes lignes + UNE action principale
    // par situation (Encaisser / Saisir le relevé / Corriger le relevé) — le
    // reste (Modifier, historique de modification…) passe derrière un menu ⋮.
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
        const menuId = 'menu-' + item.key;

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
            const arriereNote = arriere > 0
                ? `<span style="color:var(--danger);font-weight:700;">+${arriere.toLocaleString()} F arriérés</span>`
                : '';
            // ✅ "Saisir le relevé" reste l'action PRINCIPALE de cette carte
            // (bouton plein bleu, comme .btn-paye ailleurs) — réservée au
            // président, hors archive.
            const primaryOrLock = isArchiveView
                ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>`
                : (currentUser.toLowerCase() === 'président'
                    ? `<button class="btn-relever" onclick="openEditModal('${item.key}')" title="Saisir le relevé"><i class="fa-solid fa-pen-to-square"></i> Saisir le relevé</button>`
                    : '');
            // ✅ Appel de l'agent : reste accessible même en archive (non
            // destructif) — passe en action secondaire (menu ⋮) plutôt qu'un
            // 2e bouton plein sur la carte.
            const agentInfo = storeAgents[item.agent_id] || {};
            const agentTelRaw = String(item.agent_tel || agentInfo.agent_tel || '').trim();
            const agentTel = agentTelRaw.replace(/[^0-9+]/g, '');
            const agentName = String(item.agent_name || agentInfo.agent || '').trim();
            const callItem = agentTel
                ? `<a href="tel:${esc(agentTel)}" title="Appeler ${esc(agentName || "l'agent")}"><i class="fa-solid fa-phone"></i> Appeler ${esc(agentName || "l'agent")}</a>`
                : '';
            const menuWrap = callItem ? `
                <div class="card-menu-wrap">
                    <button class="btn-kebab" onclick="toggleCardMenu(event,'${menuId}')" title="Autres actions" aria-label="Autres actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                    <div class="card-menu-dropdown" id="${menuId}">${callItem}</div>
                </div>` : '';
            div.className = 'item bg-non-releve';
            div.innerHTML = `
                <div class="citem-main">
                    <span class="citem-name">${esc(item.name || 'Inconnu')}</span>
                    <span class="status-pill status-pill-warn">● À relever</span>
                </div>
                <div class="citem-sub">
                    <span><i class="fa-solid fa-location-dot"></i>${zoneName}</span>
                    <span><i class="fa-solid fa-gauge"></i>N° ${esc(item.numero_compteur || 'N/A')}</span>
                    <span><i class="fa-solid fa-droplet"></i>Dernier : ${lIdx} m³</span>
                    ${arriereNote}
                </div>
                ${noteHtml}
                ${(primaryOrLock || menuWrap) ? `<div class="citem-actions">${primaryOrLock}${menuWrap}</div>` : ''}
            `;
            listDiv.appendChild(div);
            return;
        }

        // 2) Erreur d'index (nouveau < ancien) — prend le pas sur le statut
        // financier : on ne présente jamais une consommation/un montant
        // négatifs comme s'ils étaient normaux. Fond volontairement différent
        // du rouge "Impayé" pour ne pas confondre les deux situations.
        // ✅ v4 : "Compteur en erreur" — moins technique qu'"Anomalie de relevé".
        if (isIndexError) {
            const canFix = !isArchiveView && currentUser.toLowerCase() === 'président';
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
                    <span><i class="fa-solid fa-gauge"></i>N° ${esc(item.numero_compteur || 'N/A')}</span>
                    <span><i class="fa-solid fa-rotate"></i>${lIdx} → ${nIdx} m³</span>
                </div>
                <div class="citem-row2" style="font-size:var(--fs-meta);color:var(--text-sub);">Le nouvel index est inférieur à l'ancien : ce relevé doit être corrigé.</div>
                ${noteHtml}
                ${fixOrLock ? `<div class="citem-actions">${fixOrLock}</div>` : ''}
            `;
            listDiv.appendChild(div);
            return;
        }

        const calculatedAmount = item.calculatedAmount || 0;
        const arriere = item.arriere || 0;
        const totalDu = (item.totalDu != null) ? item.totalDu : calculatedAmount;
        const isPaid = item.status === 'paye';

        // Notes courtes inline (arriérés / fuite) — regroupées sur la ligne du
        // badge de statut plutôt qu'empilées sur des lignes pleine largeur.
        const inlineNotes = [];
        if (!isPaid && arriere > 0) inlineNotes.push(`<span style="color:var(--danger);font-weight:700;">+${arriere.toLocaleString()} F arriérés</span>`);
        if (realConso > 100) inlineNotes.push(`<span style="color:var(--danger);font-weight:700;"><i class="fa-solid fa-triangle-exclamation"></i> Conso. inhabituelle</span>`);
        const inlineNotesHtml = inlineNotes.length ? `<span style="font-size:var(--fs-micro);">${inlineNotes.join(' · ')}</span>` : '';

        // "Modifié par…" déplacé dans le menu ⋮ — beaucoup plus discret que la
        // ligne toujours visible d'avant, tout en restant consultable.
        const auditText = item.last_modified_by
            ? `Modifié par ${esc(item.last_modified_by)} le ${new Date(item.last_modified_at).toLocaleDateString()}`
            : '';

        // Badge relevé affiché quand le filtre "Relevés uniquement" est actif
        const relevesBadge = (releveFilter === 'releves')
            ? `<span class="badge-releve"><i class="fa-solid fa-gauge-high"></i> Relevé</span>`
            : '';

        // ✅ v5 : une seule action principale par carte — Encaisser pour un
        // impayé. Un compteur déjà payé n'a PAS d'action principale ("Corriger
        // le paiement" devient secondaire, dans le menu ⋮).
        const primaryOrLock = isArchiveView
            ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>`
            : (!isPaid ? `<button class="btn-paye" onclick="updateStatus('${item.key}', 'paye')"><i class="fa-solid fa-hand-holding-dollar"></i> Encaisser</button>` : '');

        const secondaryItems = [];
        if (!isArchiveView && currentUser.toLowerCase() === 'président') {
            secondaryItems.push(`<button onclick="openEditModal('${item.key}')"><i class="fa-solid fa-pen-to-square"></i> Modifier les données</button>`);
        }
        if (!isArchiveView && isPaid) {
            secondaryItems.push(`<button class="danger" onclick="confirmRevoke('${item.key}')"><i class="fa-solid fa-rotate-left"></i> Corriger le paiement</button>`);
        }
        const menuWrap = (!isArchiveView && (secondaryItems.length || auditText)) ? `
            <div class="card-menu-wrap">
                <button class="btn-kebab" onclick="toggleCardMenu(event,'${menuId}')" title="Autres actions" aria-label="Autres actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                <div class="card-menu-dropdown" id="${menuId}">
                    ${secondaryItems.join('')}
                    ${auditText ? `<div class="card-menu-meta">${auditText}</div>` : ''}
                </div>
            </div>` : '';

        // ✅ v3 : le fond coloré redevient le repère principal (payé=vert,
        // impayé=rouge) pour des utilisateurs novices — toujours doublé d'un
        // badge texte explicite (✓/✕), jamais la couleur seule.
        // ✅ v5 : flash discret (0.9s) juste après un encaissement.
        const shouldFlash = justPaidKeys.has(item.key) && (Date.now() - justPaidKeys.get(item.key) < 1200);
        div.className = `item ${isPaid ? 'bg-paye' : 'bg-impaye'} ${realConso > 100 ? 'bg-alerte-fuite' : ''} ${shouldFlash ? 'flash-success' : ''}`;

        // ✅ v5 : carte compacte — nom + montant, puis zone/compteur/relevé,
        // puis statut + notes courtes, puis UNE action principale + menu ⋮.
        div.innerHTML = `
            <div class="citem-main">
                <span class="citem-name">${esc(item.name || 'Inconnu')}${relevesBadge}</span>
                <span class="citem-amt" style="color: ${isPaid ? 'var(--success)' : 'var(--danger)'}">${totalDu.toLocaleString()} F</span>
            </div>
            <div class="citem-sub">
                <span><i class="fa-solid fa-location-dot"></i>${zoneName}</span>
                <span><i class="fa-solid fa-gauge"></i>N° ${esc(item.numero_compteur || 'N/A')}</span>
                <span><i class="fa-solid fa-droplet"></i>${nIdx} m³ (préc. ${lIdx})</span>
            </div>
            <div class="citem-row2">
                <span class="status-pill ${isPaid ? 'status-pill-paid' : 'status-pill-unpaid'}">${isPaid ? '✓ Payé' : '✕ Impayé'}</span>
                ${inlineNotesHtml}
            </div>
            ${noteHtml}
            ${(primaryOrLock || menuWrap) ? `<div class="citem-actions">${primaryOrLock}${menuWrap}</div>` : ''}
        `;
        listDiv.appendChild(div);
    });

    const btnLoadMore = document.getElementById('btn-load-more');
    if (currentFilteredData.length > displayLimit) {
        btnLoadMore.style.display = "block";
        btnLoadMore.innerText = `⬇️ Charger plus (${currentFilteredData.length - displayLimit} restants)`;
    } else {
        btnLoadMore.style.display = "none";
    }
}

window.openEditModal = function(key) {
    if (isArchiveView) { showToast("🔒 Archive : lecture seule, modification impossible.", true); return; }
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
    document.getElementById('edit-modal').style.display = 'flex';
    // ✅ v5 : instantané pris à l'ouverture, pour détecter un conflit si
    // quelqu'un d'autre modifie ce même compteur pendant l'édition.
    editingSnapshotModifiedAt = item.last_modified_at || null;
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').style.display = 'none';
};

// ✅ CORRECTION : submitEdit() exposé globalement (le form est maintenant un div dans le HTML)
window.submitEdit = function() {
    if (isArchiveView) {
        showToast("🔒 Archive : lecture seule, modification impossible.", true);
        closeEditModal();
        return;
    }
    if (currentUser.toLowerCase() !== 'président') {
        showToast("⛔ Accès refusé : Seul le président peut modifier ces données.", true);
        closeEditModal();
        return;
    }
    // ✅ v5 : hors ligne, on bloque plutôt que d'écrire à l'aveugle.
    if (isOffline) { showToast("⚠️ Vous êtes hors ligne : impossible d'enregistrer.", true); return; }

    const key = document.getElementById('edit-key').value;
    if (!key) return;

    // ✅ v5 : conflit de modification — quelqu'un d'autre a modifié ce
    // compteur pendant que ce modal était ouvert.
    const liveRecord = storeReleves[key];
    const liveModifiedAt = liveRecord ? (liveRecord.last_modified_at || null) : null;
    if (liveModifiedAt !== editingSnapshotModifiedAt) {
        const who = liveRecord && liveRecord.last_modified_by ? ` par ${liveRecord.last_modified_by}` : '';
        if (!confirm(`⚠️ Ce compteur a été modifié${who} pendant votre édition. Enregistrer quand même et écraser ce changement ?`)) {
            closeEditModal();
            return;
        }
    }

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
    update(ref(db, dbPath), updatedData)
        .then(() => {
            pingSync(true);
            showToast("✅ Données du compteur mises à jour !");
            closeEditModal();
        })
        .catch(err => {
            pingSync(false);
            showToast("Erreur lors du mise à jour : " + err, true);
        });
};

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
    // ✅ v5 : seuil plus élevé (600 au lieu de 300) — le bouton, déjà rendu
    // plus discret en CSS, n'apparaît que sur un vrai long défilement.
    if (window.scrollY > 600 || (listElement && listElement.scrollTop > 600)) topBtn.style.display = "block";
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
        return item.status !== 'paye' && du > 0;
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
    doc.save(`ASUFOR_Impayes_${dateStr}.pdf`);
    showToast("✅ Fichier PDF des impayés généré avec succès !");
};

