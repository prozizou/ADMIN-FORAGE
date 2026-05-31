import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAKC7lrKSCFwfuoXASvX-yYIGneLXInvDk",
    authDomain: "asufor-67a06.firebaseapp.com",
    databaseURL: "https://asufor-67a06-default-rtdb.firebaseio.com",
    projectId: "asufor-67a06"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

let storeReleves = {};
let storeAgents = {};
let prevMonthData = {}; 
let unsubCurrentMonth = null; 

let currentTab = 'all'; 
let displayLimit = 100; 
let currentFilteredData = []; 
let chartPieInstance = null;
let chartBarInstance = null;
let currentActivePath = ""; 

let currentUser = 'Trésorier/Admin';
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
    document.body.classList.toggle('dark-theme');
    const icon = document.getElementById('theme-icon');
    if(document.body.classList.contains('dark-theme')) {
        icon.classList.replace('fa-moon', 'fa-sun');
    } else {
        icon.classList.replace('fa-sun', 'fa-moon');
    }
    const paye = parseInt(document.getElementById('total-money').innerText.replace(/\D/g,'')) || 0;
    const impaye = parseInt(document.getElementById('total-debt').innerText.replace(/\D/g,'')) || 0;
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
    if (confirm("🚨 ATTENTION !\nÊtes-vous sûr de vouloir marquer cette facture comme NON PAYÉE ?")) {
        window.updateStatus(key, 'impaye');
    }
};

window.updateStatus = function(key, newStatus) {
    const now = new Date().toISOString();
    
    const updateData = { 
        status: newStatus,
        last_modified_by: currentUser,
        last_modified_at: now
    };

    if (!currentActivePath) {
        showToast("Erreur : Chemin de base de données inconnu.", true);
        return;
    }

    const dbPath = `${currentActivePath}/${key}`;

    update(ref(db, dbPath), updateData)
        .then(() => showToast(newStatus === 'paye' ? "✅ Facture encaissée !" : "⚠️ Facture révoquée !"))
        .catch(err => showToast("Erreur réseau : " + err, true));
};

// --- EXPORT CSV ---
window.exportCSV = function() {
    if (currentFilteredData.length === 0) {
        showToast("La liste est vide, rien à exporter.", true);
        return;
    }
    let csvContent = "\uFEFF"; 
    csvContent += "Client;N° Compteur;Zone;Ancien Index;Nouvel Index;Conso (m3);Facteur;Montant (CFA);Statut;Dernière Modif;Par\n";
    
    currentFilteredData.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const conso = Math.max(0, nIdx - lIdx); 
        const facteur = parseFloat(item.facteur || 0);
        const calculatedAmount = conso * facteur;
        
        const isPaid = item.status === 'paye' ? 'Paye' : 'Impaye';
        const zoneName = storeAgents[item.agent_id]?.zone || "Inconnu";
        const clientName = (item.name || "Client Inconnu").replace(/;/g, ' '); 
        const numCompteur = (item.numero_compteur || "").replace(/;/g, ' ');
        const lastModif = item.last_modified_at ? new Date(item.last_modified_at).toLocaleString() : 'N/A';
        const par = item.last_modified_by || 'N/A';
        
        csvContent += `${clientName};${numCompteur};${zoneName};${lIdx};${nIdx};${conso};${facteur};${calculatedAmount};${isPaid};${lastModif};${par}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ASUFOR_Export_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    showToast("✅ Fichier Excel téléchargé !");
};

// --- INITIALISATION DU MENU DÉROULANT DES MOIS ---
window.initMonthFilter = async function() {
    const monthSelect = document.getElementById('month-filter');
    
    try {
        const snapshot = await get(ref(db, 'asufor_backup'));
        let optionsHtml = '<option value="actuel">🌟 Données Actuelles</option>';
        
        if (snapshot.exists()) {
            const backups = snapshot.val();
            const sortedMonths = Object.keys(backups).sort().reverse();
            
            sortedMonths.forEach(month => {
                optionsHtml += `<option value="${month}">📅 Archive : ${month}</option>`;
            });
        }
        
        monthSelect.innerHTML = optionsHtml;
        monthSelect.value = "actuel";
        loadDataForMonth("actuel");
        
    } catch (error) {
        console.error("Erreur lors du chargement des périodes:", error);
        monthSelect.innerHTML = '<option value="actuel">🌟 Données Actuelles</option>';
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
        dbPath = "asufor_db_diandioly";
        const now = new Date();
        monthForTrend = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else {
        dbPath = `asufor_backup/${selection}/donnees`;
        monthForTrend = selection; 
    }

    currentActivePath = dbPath;
    
    unsubCurrentMonth = onValue(ref(db, dbPath), (snap) => {
        storeReleves = snap.val() || {};
        document.getElementById('skeleton-loader').style.display = "none";
        fetchPreviousMonthStats(monthForTrend);
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
    
    get(ref(db, `asufor_backup/${prevMonthStr}/donnees`)).then((snap) => {
        prevMonthData = snap.val() || {};
        window.applyFilter();
    }).catch(() => {
        prevMonthData = {};
        window.applyFilter();
    });
}

// --- SYNCHRONISATION INITIALE ---
window.startSync = function() {
    onValue(ref(db, 'db_agents'), (snap) => {
        storeAgents = snap.val() || {};
        const spinner = document.getElementById('agent-spinner');
        const active = spinner.value || "all";
        let html = '<option value="all">🟢 Tous les agents (Global)</option>';
        Object.entries(storeAgents).forEach(([key, a]) => {
            let name = (a.agent || "Inconnu").trim();
            let zone = a.zone ? ` [${a.zone}]` : "";
            html += `<option value="${key}">👤 ${name.toUpperCase()}${zone}</option>';
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

    currentFilteredData = filteredBase.filter(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const facteur = parseFloat(item.facteur || 0);
        
        const conso = Math.max(0, nIdx - lIdx);
        const calculatedAmount = conso * facteur;
        
        item.calculatedAmount = calculatedAmount;

        if (isNaN(calculatedAmount)) return false; 
        
        const isPaid = item.status === 'paye';

        if (isPaid) {
            tCFA_Paye += calculatedAmount;
        } else {
            tCFA_Impaye += calculatedAmount;
        }

        if (currentTab === 'paye' && !isPaid) return false;
        if (currentTab === 'impaye' && isPaid) return false;
        
        return true; 
    });

    if (sortOption === "max_amount") currentFilteredData.sort((a, b) => (b.calculatedAmount || 0) - (a.calculatedAmount || 0));
    else if (sortOption === "min_amount") currentFilteredData.sort((a, b) => (a.calculatedAmount || 0) - (b.calculatedAmount || 0));
    else if (sortOption === "zone") currentFilteredData.sort((a, b) => (storeAgents[a.agent_id]?.zone || "Z").localeCompare(storeAgents[b.agent_id]?.zone || "Z"));
    else if (sortOption === "name") currentFilteredData.sort((a, b) => (a.name || "Z").localeCompare(b.name || "Z"));

    document.getElementById('total-money').innerText = tCFA_Paye.toLocaleString() + " CFA";
    document.getElementById('total-debt').innerText = tCFA_Impaye.toLocaleString() + " CFA";

    const calcTrend = (current, prev, elId) => {
        const el = document.getElementById(elId);
        if (prev === 0) { el.innerHTML = ""; return; }
        const diff = ((current - prev) / prev) * 100;
        const sign = diff >= 0 ? '+' : '';
        const arrow = diff >= 0 ? '📈' : '📉';
        const colorClass = diff >= 0 ? 'trend-up' : 'trend-down';
        el.innerHTML = `<span class="${colorClass}">${arrow} ${sign}${diff.toFixed(1)}% vs mois préc.</span>`;
    };
    
    calcTrend(tCFA_Paye, tCFA_Paye_Prev, 'trend-money');
    calcTrend(tCFA_Impaye, tCFA_Impaye_Prev, 'trend-debt');

    renderList();
    updateCharts(tCFA_Paye, tCFA_Impaye);
}

function updateCharts(paye, impaye) {
    const isDark = document.body.classList.contains('dark-theme');
    const textColor = isDark ? '#f1f5f9' : '#1e293b';

    const ctxPie = document.getElementById('pieChart');
    if (chartPieInstance) chartPieInstance.destroy();
    chartPieInstance = new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: ['Encaissé', 'Impayés'],
            datasets: [{
                data: [paye, impaye],
                backgroundColor: ['#22c55e', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { labels: { color: textColor } }, title: { display: true, text: 'Répartition des Recettes', color: textColor } }
        }
    });

    const zonesConso = {};
    currentFilteredData.forEach(item => {
        const zone = storeAgents[item.agent_id]?.zone || "Autre";
        const conso = parseFloat(item.new_index || 0) - parseFloat(item.last_index || 0);
        if (!zonesConso[zone]) zonesConso[zone] = 0;
        zonesConso[zone] += (conso > 0 ? conso : 0);
    });

    const ctxBar = document.getElementById('barChart');
    if (chartBarInstance) chartBarInstance.destroy();
    chartBarInstance = new Chart(ctxBar, {
        type: 'bar',
        data: {
            labels: Object.keys(zonesConso),
            datasets: [{
                label: 'Volume (m³)',
                data: Object.values(zonesConso),
                backgroundColor: '#0052fe',
                borderRadius: 5
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: { ticks: { color: textColor } },
                y: { ticks: { color: textColor } }
            },
            plugins: { legend: { display: false }, title: { display: true, text: 'Volume par Zone (m³)', color: textColor } }
        }
    });
}

function renderList() {
    const listDiv = document.getElementById('releves-list');
    listDiv.innerHTML = "";
    document.getElementById('item-count').innerText = `${currentFilteredData.length} élément(s) trouvé(s)`;
    const dataToShow = currentFilteredData.slice(0, displayLimit);

    dataToShow.forEach(item => {
        const nIdx = parseFloat(item.new_index || 0);
        const lIdx = parseFloat(item.last_index || 0);
        const realConso = nIdx - lIdx; 
        
        const calculatedAmount = item.calculatedAmount || 0;
        const isPaid = item.status === 'paye';
        const zoneName = storeAgents[item.agent_id]?.zone || "Sans Zone";

        let extraClass = ''; let anomalyHtml = '';
        if (realConso < 0) {
            extraClass = 'bg-alerte-index';
            anomalyHtml = `<div style="margin-top: 8px; font-size: 0.75rem; color: #d97706; font-weight: bold;">⚠️ Erreur d'index (Nouveau < Ancien)</div>`;
        } else if (realConso > 80) {
            extraClass = 'bg-alerte-fuite';
            anomalyHtml = `<div style="margin-top: 8px; font-size: 0.75rem; color: var(--danger); font-weight: bold;">⚠️ Alerte Fuite (> 80 m³)</div>`;
        }

        let auditHtml = item.last_modified_by 
            ? `<span class="audit-trail">Modifié par ${item.last_modified_by} le ${new Date(item.last_modified_at).toLocaleDateString()}</span>` 
            : '';

        const editBtn = (currentUser.toLowerCase() === 'président')
            ? `<button class="btn-edit" onclick="openEditModal('${item.key}')" title="Modifier les données"><i class="fa-solid fa-pen-to-square"></i></button>`
            : '';

        const statusBtn = !isPaid
            ? `<button class="btn-paye" onclick="updateStatus('${item.key}', 'paye')"><i class="fa-solid fa-check"></i> Payé</button>`
            : `<button class="btn-revoquer" onclick="confirmRevoke('${item.key}')"><i class="fa-solid fa-xmark"></i> Révoquer</button>`;

        const div = document.createElement('div');
        div.className = `item ${isPaid ? 'bg-paye' : 'bg-impaye'} ${extraClass}`;
        
        div.innerHTML = `
            <div style="flex: 1;">
                <b style="color:var(--text-main);">${item.name || 'Inconnu'}</b> <span style="font-size:0.7rem; color:var(--text-sub);">[${zoneName}]</span><br>
                <small style="color:var(--text-main)">${lIdx} → ${nIdx} (${realConso.toFixed(1)} m³) | Cpt: ${item.numero_compteur || 'N/A'}</small><br>
                <small style="font-size: 0.65rem; font-weight:bold; color:${isPaid ? 'var(--success)' : 'var(--danger)'}">
                    ${isPaid ? '✅ ENCAISSÉ' : '❌ NON PAYÉ'}
                </small>
                ${auditHtml}
                ${anomalyHtml}
            </div>
            <div style="text-align:right; align-self: flex-start; margin-left: 10px;">
                <span class="amt" style="color: ${isPaid ? 'var(--success)' : 'var(--danger)'}">${calculatedAmount.toLocaleString()} F</span>
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

document.getElementById('edit-form').addEventListener('submit', function(e) {
    e.preventDefault();
    
    if (currentUser.toLowerCase() !== 'président') {
        showToast("⛔ Accès refusé : Seul le président peut modifier ces données.", true);
        closeEditModal();
        return;
    }
    
    const key = document.getElementById('edit-key').value;
    if (!key) return;
    
    const updatedData = {
        name: document.getElementById('edit-name').value.trim(),
        numero_compteur: document.getElementById('edit-compteur').value.trim(),
        last_index: parseFloat(document.getElementById('edit-last-index').value) || 0,
        new_index: parseFloat(document.getElementById('edit-new-index').value) || 0,
        facteur: parseFloat(document.getElementById('edit-facteur').value) || 0,
        last_modified_by: currentUser,
        last_modified_at: new Date().toISOString()
    };
    
    if (!currentActivePath) {
        showToast("Erreur : Chemin de base de données inconnu.", true);
        return;
    }
    
    const dbPath = `${currentActivePath}/${key}`;
    update(ref(db, dbPath), updatedData)
        .then(() => {
            showToast("✅ Données du compteur mises à jour !");
            closeEditModal();
        })
        .catch(err => showToast("Erreur lors de la mise à jour : " + err, true));
});

document.getElementById('edit-modal').addEventListener('click', function(e) {
    if (e.target === this) closeEditModal();
});

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
        window.startSync();
    } else {
        console.error("Accès Firebase refusé : Session utilisateur non valide.");
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

    // Récupérer les impayés de la liste filtrée
    const impayes = currentFilteredData.filter(item => item.status !== 'paye');

    if (impayes.length === 0) {
        showToast("Aucun impayé trouvé pour cette sélection.", true);
        return;
    }

    // En-tête
    doc.setFontSize(16);
    doc.setTextColor(239, 68, 68);
    doc.text("Liste des Impayés - ASUFOR Diandioly", 14, 15);
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Date d'export : ${new Date().toLocaleDateString()}`, 14, 22);
    doc.text(`Nombre de compteurs : ${impayes.length}`, 14, 27);

    const tableColumn = ["Client", "N° Compteur", "Zone", "Montant"];
    const tableRows = [];
    let totalImpaye = 0;

    impayes.forEach(item => {
        const zoneName = storeAgents[item.agent_id]?.zone || "Inconnu";
        const clientName = item.name || "Inconnu";
        const numCompteur = item.numero_compteur || "N/A";
        const montant = item.calculatedAmount || 0;
        
        totalImpaye += montant;

        tableRows.push([
            clientName,
            numCompteur,
            zoneName,
            montant.toLocaleString() + " CFA"
        ]);
    });

    tableRows.push([
        { content: 'TOTAL À RECOUVRER', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', textColor: [239, 68, 68] } },
        { content: totalImpaye.toLocaleString() + " CFA", styles: { fontStyle: 'bold', textColor: [239, 68, 68] } }
    ]);

    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: 32,
        theme: 'striped',
        headStyles: { fillColor: [239, 68, 68] },
        styles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [254, 242, 242] }
    });

    const dateStr = new Date().toISOString().split('T')[0];
    doc.save(`ASUFOR_Impayes_${dateStr}.pdf`);
    showToast("✅ Fichier PDF des impayés généré avec succès !");
};
