import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
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
// secondaire indépendant (voir setReleveFilter) — la ligne d'onglets se
// limite désormais à Tous / Payés / Impayés / Anomalies.
let releveFilter = 'all';
// ✅ v2 : vrai en consultant une période archivée — verrouille les actions
// de modification (statut, édition) dans renderList() et les handlers.
let isArchiveView = false;
let displayLimit = 100;
let currentFilteredData = [];
let chartBarInstance = null;
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

// ✅ CORRECTION : Restaurer le thème enregistré dès le chargement
(function restoreTheme() {
    try {
        const saved = localStorage.getItem('asufor-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
        const icon = document.getElementById('theme-icon');
        if (icon) {
            if (saved === 'light') {
                icon.classList.replace('fa-moon', 'fa-sun');
            }
        }
    } catch(_) {}
})();

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

// --- FONCTIONS UTILITAIRES & THEME ---
window.toggleTheme = function() {
    // ✅ CORRECTION : utiliser data-theme sur html (cohérent avec le reste de l'app)
    const html = document.documentElement;
    const current = html.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    try { localStorage.setItem('asufor-theme', next); } catch(_) {}
    const icon = document.getElementById('theme-icon');
    if (icon) {
        if (next === 'light') {
            icon.classList.replace('fa-moon', 'fa-sun');
        } else {
            icon.classList.replace('fa-sun', 'fa-moon');
        }
    }
    // ✅ CORRECTION : Recalcul depuis les données réelles plutôt que l'innerText
    let paye = 0; let impaye = 0;
    currentFilteredData.forEach(item => {
        if (item.status === 'paye') paye += (item.calculatedAmount || 0);
        else impaye += (item.totalDu != null ? item.totalDu : (item.calculatedAmount || 0));
    });
    updateCharts(paye, impaye);
};

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
window.confirmRevoke = function(key) {
    if (isArchiveView) { showToast("🔒 Archive : lecture seule, modification impossible.", true); return; }
    if (confirm("🚨 ATTENTION !\nÊtes-vous sûr de vouloir marquer cette facture comme NON PAYÉE ?")) {
        window.updateStatus(key, 'impaye');
    }
};

window.updateStatus = function(key, newStatus) {
    // ✅ v2 : verrou défensif — la carte ne propose déjà plus ce bouton sur une
    // archive, mais on bloque aussi l'appel direct (deuxième ligne de défense).
    if (isArchiveView) { showToast("🔒 Archive : lecture seule, modification impossible.", true); return; }
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
        window.applyFilter();
    }

    update(ref(db), updates)
        .then(() => showToast(newStatus === 'paye' ? "✅ Facture encaissée ! Historique régularisé." : "⚠️ Facture révoquée !"))
        .catch(err => {
            if (previousRecord) {
                storeReleves[key] = previousRecord;
                window.applyFilter();
            }
            showToast("Erreur réseau : " + err, true);
        });
};

// --- EXPORT CSV ---
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
window.initMonthFilter = async function() {
    const monthSelect = document.getElementById('month-filter');

    try {
        const snapshot = await get(ref(db, P.backup));
        let optionsHtml = '<option value="actuel">Données actuelles</option>';

        if (snapshot.exists()) {
            const backups = snapshot.val();
            allBackupsCache = backups; // conservé pour billing.js (arriérés + cascade paiement)
            const sortedMonths = Object.keys(backups).sort().reverse();

            sortedMonths.forEach(month => {
                optionsHtml += `<option value="${month}">${monthLabelFR(month)} — Archive</option>`;
            });
        }

        monthSelect.innerHTML = optionsHtml;
        monthSelect.value = "actuel";
        loadDataForMonth("actuel");

    } catch (error) {
        console.error("Erreur lors du chargement des périodes:", error);
        monthSelect.innerHTML = '<option value="actuel">Données actuelles</option>';
        loadDataForMonth("actuel");
    }
}

// --- CHARGEMENT DES DONNÉES ---
window.changeMonth = function() {
    const selectedValue = document.getElementById('month-filter').value;
    loadDataForMonth(selectedValue);
};

function loadDataForMonth(selection) {
    document.getElementById('skeleton-loader').style.display = "flex";
    document.getElementById('releves-list').innerHTML = "";
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

    unsubCurrentMonth = onValue(ref(db, dbPath), (snap) => {
        storeReleves = snap.val() || {};
        document.getElementById('skeleton-loader').style.display = "none";
        if (window.AsuforLoader) AsuforLoader.hide();
        fetchPreviousMonthStats(monthForTrend);
    }, (err) => {
        console.error('Firebase relevés :', err.code, err.message);
        if (window.AsuforLoader) {
            AsuforLoader.fail('Impossible de charger les relevés (' + err.code + '). Session peut-être expirée.');
        }
    });
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
window.startSync = function() {
    onValue(ref(db, P.agents), (snap) => {
        storeAgents = snap.val() || {};
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
    });

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

    currentFilteredData = filteredBase.filter(item => {
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

        if (isNaN(totalDu)) return false;

        const isPaid = item.status === 'paye';

        if (isPaid) {
            tCFA_Paye += calculatedAmount;
        } else {
            tCFA_Impaye += totalDu; // ✅ inclut désormais les arriérés
        }

        if (currentTab === 'paye' && !isPaid) return false;
        if (currentTab === 'impaye' && isPaid) return false;
        // ✅ v2 : onglet Anomalies — erreur d'index (nouveau < ancien) ou fuite (> 100 m³)
        if (currentTab === 'anomalies') {
            const nIdxA = parseFloat(item.new_index || 0);
            const lIdxA = parseFloat(item.last_index || 0);
            const realConsoA = nIdxA - lIdxA;
            if (!(realConsoA < 0 || realConsoA > 100)) return false;
        }
        // ✅ v2 : filtre secondaire (déplacé hors des onglets) — uniquement les
        // compteurs dont l'index a bien été saisi (new_index > 0), ou l'inverse.
        if (releveFilter === 'releves') {
            const hasIndex = parseFloat(item.new_index || 0) > 0;
            if (!hasIndex) return false;
        }
        if (releveFilter === 'non-releves') {
            const hasIndex = parseFloat(item.new_index || 0) > 0;
            if (hasIndex) return false;
        }

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

    // ✅ v2 : barre de recouvrement (remplace le donut) dans la carte Bilan
    const recapTotal = tCFA_Paye + tCFA_Impaye;
    const recapPct = recapTotal > 0 ? (tCFA_Paye / recapTotal * 100) : 0;
    const recapBar = document.getElementById('recap-bar-fill');
    if (recapBar) recapBar.style.width = Math.min(100, recapPct) + '%';
    const recapPctEl = document.getElementById('recap-pct');
    if (recapPctEl) recapPctEl.textContent = recapPct.toFixed(1) + ' % recouvré';

    // ✅ v2 : la couleur reflète si la variation est une BONNE ou une MAUVAISE
    // nouvelle pour cet indicateur — avant, +294,6 % d'impayés s'affichait en
    // vert (hausse = vert, peu importe le sens), ce qui donnait le message
    // exactement inverse de la réalité.
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
        el.innerHTML = `<span class="${colorClass}">${arrow} ${sign}${diff.toFixed(1)}% vs mois préc.</span>`;
    };

    calcTrend(tCFA_Paye, tCFA_Paye_Prev, 'trend-money', true);   // encaissé : une hausse est une bonne nouvelle
    calcTrend(tCFA_Impaye, tCFA_Impaye_Prev, 'trend-debt', false); // impayés : une hausse est une mauvaise nouvelle

    renderList();
    updateCharts(tCFA_Paye, tCFA_Impaye);
    updateRelevesProgress();
}

// ✅ v2 : le donut (répartition encaissé/impayés) est retiré — cette info est
// désormais portée par la carte Bilan (chiffres + barre de recouvrement),
// beaucoup plus lisible et moins gourmande en espace sur mobile.
function updateCharts(paye, impaye) {
    // ✅ FIX : le thème est porté par [data-theme] sur <html>, pas par une classe
    //   body.dark-theme (qui n'existait jamais → texte des graphiques toujours en
    //   couleur claire, illisible en mode sombre).
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

    const zonesConso = {};
    currentFilteredData.forEach(item => {
        const zone = zoneOf(item);
        // ✅ CORRECTION : item.conso vient de billing.js (calculé dans applyFilter),
        //   déjà à 0 pour toute lecture invraisemblable (anomalie) — évite qu'un seul
        //   relevé corrompu écrase l'échelle du graphique (axe en milliards).
        const conso = item.conso || 0;
        if (!zonesConso[zone]) zonesConso[zone] = 0;
        zonesConso[zone] += conso;
    });
    // ✅ v2 : barres horizontales triées (au lieu de barres verticales avec
    // des noms de zone inclinés, illisibles) — les valeurs se lisent d'un coup d'œil.
    const sortedZones = Object.entries(zonesConso).sort((a, b) => b[1] - a[1]);

    const ctxBar = document.getElementById('barChart');
    if (chartBarInstance) chartBarInstance.destroy();
    chartBarInstance = new Chart(ctxBar, {
        type: 'bar',
        data: {
            labels: sortedZones.map(z => z[0]),
            datasets: [{
                label: 'Volume (m³)',
                data: sortedZones.map(z => z[1]),
                backgroundColor: '#0052fe',
                borderRadius: 5
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { display: false } }
            },
            plugins: { legend: { display: false }, title: { display: true, text: 'Volume par Zone (m³)', color: textColor } }
        }
    });
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

function renderList() {
    // ✅ FIX XSS : échappement de toute valeur dynamique injectée dans innerHTML.
    const esc = escHtml;
    const listDiv = document.getElementById('releves-list');
    listDiv.innerHTML = "";
    document.getElementById('item-count').innerText = `${currentFilteredData.length} élément(s) trouvé(s)`;
    const dataToShow = currentFilteredData.slice(0, displayLimit);

    dataToShow.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const realConso = nIdx - lIdx;
        const isIndexError = realConso < 0;
        const zoneName = esc(zoneOf(item));
        const div = document.createElement('div');

        // ✅ v2 : une erreur d'index (nouveau < ancien) prend le pas sur le
        // statut financier — on ne présente jamais une consommation/un
        // montant négatifs comme s'ils étaient normaux. L'action proposée
        // est de corriger le relevé, pas de payer/révoquer.
        if (isIndexError) {
            const canFix = !isArchiveView && currentUser.toLowerCase() === 'président';
            const fixOrLock = canFix
                ? `<button class="btn-edit btn-fix" onclick="openEditModal('${item.key}')"><i class="fa-solid fa-pen-to-square"></i> Corriger le relevé</button>`
                : (isArchiveView ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>` : '');
            div.className = 'item bg-alerte-index';
            div.innerHTML = `
                <div style="flex: 1;">
                    <b style="color:var(--text-main);">${esc(item.name || 'Inconnu')}</b> <span style="font-size:0.7rem; color:var(--text-sub);">[${zoneName}]</span><br>
                    <small style="color:var(--text-main)">Cpt: ${esc(item.numero_compteur || 'N/A')}</small><br>
                    <span class="anomaly-badge"><i class="fa-solid fa-triangle-exclamation"></i> Anomalie de relevé</span>
                    <div style="margin-top:6px; font-size:0.78rem; color:var(--text-main);">Ancien index : <b>${lIdx}</b> · Nouvel index : <b>${nIdx}</b></div>
                </div>
                <div style="text-align:right; align-self: flex-start; margin-left: 10px;">${fixOrLock}</div>
            `;
            listDiv.appendChild(div);
            return;
        }

        const calculatedAmount = item.calculatedAmount || 0;
        const arriere = item.arriere || 0;
        const totalDu = (item.totalDu != null) ? item.totalDu : calculatedAmount;
        const isPaid = item.status === 'paye';
        // Détail arriérés affiché uniquement quand il y en a (compteurs avec dette passée)
        const arriereHtml = (!isPaid && arriere > 0)
            ? `<div style="margin-top:4px;font-size:0.68rem;color:var(--danger);font-weight:600;">Mois: ${calculatedAmount.toLocaleString()} F + Arriérés: ${arriere.toLocaleString()} F</div>`
            : '';

        // Fuite (> 100 m³) : consommation plausible mais suspecte — reste
        // affichée normalement, avec une simple alerte en plus (contrairement
        // à l'erreur d'index, ce n'est pas une donnée aberrante).
        const anomalyHtml = (realConso > 100)
            ? `<div class="leak-alert"><i class="fa-solid fa-triangle-exclamation"></i> Alerte fuite (&gt; 100 m³)</div>`
            : '';

        let auditHtml = item.last_modified_by
            ? `<span class="audit-trail">Modifié par ${esc(item.last_modified_by)} le ${new Date(item.last_modified_at).toLocaleDateString()}</span>`
            : '';

        // Badge relevé affiché quand le filtre "Relevés uniquement" est actif
        const relevesBadge = (releveFilter === 'releves')
            ? `<span class="badge-releve"><i class="fa-solid fa-gauge-high"></i> Relevé</span>`
            : '';

        const editBtn = (!isArchiveView && currentUser.toLowerCase() === 'président')
            ? `<button class="btn-edit" onclick="openEditModal('${item.key}')" title="Modifier les données"><i class="fa-solid fa-pen-to-square"></i></button>`
            : '';

        // ✅ v2 : sur une archive, le bouton Payé/Révoquer laisse place à un
        // simple cadenas — l'historique ne doit pas pouvoir être modifié
        // accidentellement.
        const statusBtn = isArchiveView
            ? `<span class="archive-lock" title="Archive : lecture seule"><i class="fa-solid fa-lock"></i></span>`
            : (!isPaid
                ? `<button class="btn-paye" onclick="updateStatus('${item.key}', 'paye')"><i class="fa-solid fa-check"></i> Payé</button>`
                : `<button class="btn-revoquer" onclick="confirmRevoke('${item.key}')"><i class="fa-solid fa-xmark"></i> Révoquer</button>`);

        // ✅ v2 : carte neutre + badge de statut (le fond plein rose/vert sur
        // chaque carte rendait toute la page rouge dès qu'une cinquantaine
        // d'impayés se suivaient).
        div.className = `item ${realConso > 100 ? 'bg-alerte-fuite' : ''}`;

        div.innerHTML = `
            <div style="flex: 1;">
                <b style="color:var(--text-main);">${esc(item.name || 'Inconnu')}</b> <span style="font-size:0.7rem; color:var(--text-sub);">[${zoneName}]</span>${relevesBadge}<br>
                <small style="color:var(--text-main)">${lIdx} → ${nIdx} (${realConso.toFixed(1)} m³) | Cpt: ${esc(item.numero_compteur || 'N/A')}</small><br>
                <span class="status-badge ${isPaid ? 'status-paid' : 'status-unpaid'}">${isPaid ? 'PAYÉ' : 'IMPAYÉ'}</span>
                ${arriereHtml}
                ${auditHtml}
                ${anomalyHtml}
            </div>
            <div style="text-align:right; align-self: flex-start; margin-left: 10px;">
                <span class="amt" style="color: ${isPaid ? 'var(--success)' : 'var(--danger)'}">${totalDu.toLocaleString()} F</span>
                <div class="action-btns">
                    ${editBtn}
                    ${statusBtn}
                </div>
            </div>
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
    update(ref(db, dbPath), updatedData)
        .then(() => {
            showToast("✅ Données du compteur mises à jour !");
            closeEditModal();
        })
        .catch(err => showToast("Erreur lors du mise à jour : " + err, true));
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

