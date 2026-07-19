/**
 * rapports.js — Rapports d'Assemblée Générale & Tableau de bord KPIs (ASUFOR)
 * ===========================================================================
 *
 * 100 % front : lit les données existantes (base active + asufor_backup +
 * db_agents), délègue TOUT le calcul monétaire à billing.js (source unique de
 * vérité, comme l'impression et les statistiques). Aucune écriture en base.
 *
 * Contenu :
 *   • Tableau de bord : taux de recouvrement, évolution des recettes (12 cycles),
 *     top débiteurs, zones à risque.
 *   • Rapport PDF mensuel et annuel pour l'Assemblée Générale (recettes, taux de
 *     recouvrement, consommation par zone, dépenses saisies manuellement).
 *
 * Les « dépenses » ne sont pas encore stockées en base : elles sont saisies au
 * moment de générer le rapport (persistance à venir avec le module « caisse »).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = window.ASUFOR_FIREBASE_CONFIG;
const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

if (window.AsuforLoader) AsuforLoader.show('Connexion sécurisée…');

// ── État global ──────────────────────────────────────────────
let agents = {};          // db_agents
let activeRecords = [];    // base active (cycle courant), en tableau
let backupsRaw = {};       // asufor_backup brut { "YYYY-MM": { donnees: {...} } }
let indexedBackups = [];   // sortie de Billing.indexBackups
let chartRecettes = null;

const esc = window.escHtml || (s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));

const B = window.Billing; // moteur de facturation partagé

// ── Utilitaires ──────────────────────────────────────────────
function currentMonthStr() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

/** Montant formaté pour l'écran : "12 500 FCFA". */
function fMoney(n) {
    return Math.round(n || 0).toLocaleString('fr-FR') + ' FCFA';
}
/** Montant formaté pour jsPDF (espace comme séparateur de milliers, sans NBSP). */
function fMoneyPdf(n) {
    return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA';
}
/** Libellé « mois année » en français à partir de "YYYY-MM". */
function monthLabel(cycle) {
    if (cycle === 'actuel') cycle = currentMonthStr();
    const [y, m] = cycle.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}
/** Zone d'un relevé : champ zone du relevé, repli sur la zone de l'agent. */
function zoneOf(r) {
    const z = (r.zone && String(r.zone).trim()) ||
              (agents[r.agent_id] && agents[r.agent_id].zone) || '';
    return z ? String(z).trim() : 'Sans zone';
}

/** Relevés d'un cycle donné (tableau). "actuel" → base active. */
function recordsOfCycle(cycle) {
    if (cycle === 'actuel' || cycle === currentMonthStr()) {
        if (activeRecords.length) return activeRecords;
    }
    const node = backupsRaw[cycle];
    if (node && node.donnees) return Object.values(node.donnees);
    return [];
}

/** Liste des cycles archivés triés (ancien → récent) + le cycle courant. */
function allCyclesAsc() {
    const set = new Set(Object.keys(backupsRaw));
    set.add(currentMonthStr());
    return Array.from(set).sort();
}

// ── Calcul des métriques d'un cycle (via billing.js) ─────────
function cycleMetrics(records) {
    let facture = 0, encaisse = 0, impayes = 0, volume = 0, nbReleves = 0, anomalies = 0;
    const zones = {};
    records.forEach(r => {
        const zone = zoneOf(r);
        if (!zones[zone]) zones[zone] = { facture: 0, encaisse: 0, impaye: 0, volume: 0, nb: 0 };
        zones[zone].nb++;
        if (B.toInt(r.new_index) > 0) nbReleves++;

        const c = B.computeCurrent(r);
        if (c.anomalie) { anomalies++; return; } // exclu des montants (cf. règle métier)

        facture += c.montant; volume += c.conso;
        zones[zone].facture += c.montant; zones[zone].volume += c.conso;
        if (B.isPaid(r)) { encaisse += c.montant; zones[zone].encaisse += c.montant; }
        else { impayes += c.montant; zones[zone].impaye += c.montant; }
    });
    const taux = facture > 0 ? (encaisse / facture * 100) : 0;
    return {
        facture, encaisse, impayes, volume, anomalies,
        nbCompteurs: records.length, nbReleves, taux, zones
    };
}

// ── Tableau de bord ──────────────────────────────────────────
function renderDashboard() {
    const cur = cycleMetrics(activeRecords);

    // Cartes KPI
    setText('kpi-taux', cur.taux.toFixed(1) + ' %');
    setText('kpi-recettes', fMoney(cur.encaisse));
    setText('kpi-impayes', fMoney(cur.impayes));
    setText('kpi-volume', Math.round(cur.volume).toLocaleString('fr-FR') + ' m³');

    const bar = document.getElementById('kpi-taux-bar');
    if (bar) {
        bar.style.width = Math.min(100, cur.taux) + '%';
        bar.style.background = cur.taux >= 75 ? '#22c55e' : cur.taux >= 50 ? '#f59e0b' : '#ef4444';
    }

    renderRecettesChart();
    renderTopDebiteurs();
    renderZonesRisque(cur.zones);
}

function renderRecettesChart() {
    const cycles = allCyclesAsc().slice(-12); // 12 derniers cycles max
    const labels = cycles.map(c => {
        const [y, m] = c.split('-');
        return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
            .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    });
    const data = cycles.map(c => cycleMetrics(recordsOfCycle(c)).encaisse);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

    const ctx = document.getElementById('chart-recettes');
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartRecettes) chartRecettes.destroy();
    chartRecettes = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Recettes encaissées (FCFA)',
                data,
                backgroundColor: '#0052fe',
                borderRadius: 5
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                title: { display: true, text: 'Évolution des recettes (12 derniers cycles)', color: textColor }
            },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            }
        }
    });
}

function renderTopDebiteurs() {
    // Total dû = facture courante + arriérés (billing.js), pour les non-payés.
    const debiteurs = activeRecords
        .filter(r => !B.isPaid(r))
        .map(r => {
            const stmt = B.computeStatement(r, indexedBackups, { beforeCycle: '9999-99' });
            return {
                name: r.name || 'Inconnu',
                zone: zoneOf(r),
                compteur: r.numero_compteur || 'N/A',
                total: stmt.total
            };
        })
        .filter(d => d.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    const box = document.getElementById('top-debiteurs');
    if (!debiteurs.length) {
        box.innerHTML = '<p class="muted">Aucun débiteur — tout est réglé 🎉</p>';
        return;
    }
    box.innerHTML = debiteurs.map((d, i) => `
        <div class="row-item">
            <span class="rank">${i + 1}</span>
            <div class="row-main">
                <b>${esc(d.name)}</b>
                <small>${esc(d.zone)} · Cpt ${esc(d.compteur)}</small>
            </div>
            <span class="row-amt">${fMoney(d.total)}</span>
        </div>`).join('');
}

function renderZonesRisque(zones) {
    const rows = Object.entries(zones).map(([zone, z]) => {
        const taux = z.facture > 0 ? (z.encaisse / z.facture * 100) : 0;
        return { zone, taux, impaye: z.impaye, nb: z.nb };
    }).sort((a, b) => a.taux - b.taux); // du plus à risque au moins à risque

    const box = document.getElementById('zones-risque');
    if (!rows.length) { box.innerHTML = '<p class="muted">Aucune donnée de zone.</p>'; return; }

    box.innerHTML = rows.map(r => {
        const cls = r.taux >= 75 ? 'ok' : r.taux >= 50 ? 'warn' : 'bad';
        return `
        <div class="row-item">
            <div class="row-main">
                <b>${esc(r.zone)}</b>
                <small>${r.nb} compteur(s) · Impayés : ${fMoney(r.impaye)}</small>
            </div>
            <span class="tag tag-${cls}">${r.taux.toFixed(0)} %</span>
        </div>`;
    }).join('');
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

// ── Dépenses (saisie manuelle, non persistée) ────────────────
window.addExpenseRow = function (libelle = '', montant = '') {
    const list = document.getElementById('expense-list');
    const row = document.createElement('div');
    row.className = 'expense-row';
    row.innerHTML = `
        <input type="text" class="exp-lib" placeholder="Libellé (ex: carburant groupe)" value="${esc(libelle)}">
        <input type="number" class="exp-mnt" placeholder="Montant" min="0" value="${esc(montant)}">
        <button type="button" class="exp-del" title="Supprimer">✕</button>`;
    row.querySelector('.exp-del').addEventListener('click', () => row.remove());
    list.appendChild(row);
};

function readExpenses() {
    const rows = document.querySelectorAll('#expense-list .expense-row');
    const items = [];
    let total = 0;
    rows.forEach(r => {
        const lib = r.querySelector('.exp-lib').value.trim();
        const mnt = parseFloat(r.querySelector('.exp-mnt').value) || 0;
        if (lib || mnt) { items.push({ lib: lib || 'Dépense', mnt }); total += mnt; }
    });
    return { items, total };
}

// ── Sélecteurs de période ────────────────────────────────────
function populatePeriodSelectors() {
    // Mensuel
    const mSel = document.getElementById('report-month');
    const cycles = allCyclesAsc().slice().reverse();
    mSel.innerHTML = cycles.map(c => {
        const isCur = (c === currentMonthStr());
        const val = isCur ? 'actuel' : c;
        return `<option value="${val}">${isCur ? '🌟 Mois courant — ' : '📅 '}${monthLabel(c)}</option>`;
    }).join('');

    // Annuel
    const years = Array.from(new Set(allCyclesAsc().map(c => c.split('-')[0]))).sort().reverse();
    const ySel = document.getElementById('report-year');
    ySel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
}

window.toggleReportMode = function () {
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    document.getElementById('wrap-month').style.display = (mode === 'mensuel') ? 'block' : 'none';
    document.getElementById('wrap-year').style.display  = (mode === 'annuel') ? 'block' : 'none';
};

// ── Génération PDF ───────────────────────────────────────────
window.genererRapport = function () {
    if (typeof window.jspdf === 'undefined') {
        alert("La bibliothèque PDF n'est pas chargée. Vérifiez votre connexion.");
        return;
    }
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    if (mode === 'mensuel') genererMensuel();
    else genererAnnuel();
};

function pdfHeader(doc, titre, sousTitre) {
    doc.setFontSize(16); doc.setTextColor(0, 82, 254);
    doc.text('ASUFOR Diandioly — Gestion de l\'eau', 14, 16);
    doc.setFontSize(13); doc.setTextColor(30, 41, 59);
    doc.text(titre, 14, 25);
    doc.setFontSize(10); doc.setTextColor(100);
    doc.text(sousTitre, 14, 31);
    doc.text("Édité le " + new Date().toLocaleDateString('fr-FR'), 14, 36);
}

function pdfSignatures(doc, y) {
    doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    const cols = [['Le Président', 20], ['Le Trésorier', 85], ['Le Secrétaire', 150]];
    cols.forEach(([label, x]) => {
        doc.text(label, x, y);
        doc.line(x, y + 18, x + 45, y + 18);
    });
}

function genererMensuel() {
    const cycle = document.getElementById('report-month').value;
    const m = cycleMetrics(recordsOfCycle(cycle));
    const { items: expenses, total: depTotal } = readExpenses();
    const solde = m.encaisse - depTotal;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, 'Rapport mensuel — Assemblée Générale', 'Période : ' + monthLabel(cycle));

    // 1. Synthèse
    doc.autoTable({
        startY: 42,
        head: [['Indicateur', 'Valeur']],
        body: [
            ['Compteurs suivis', String(m.nbCompteurs)],
            ['Relevés effectués', `${m.nbReleves} / ${m.nbCompteurs}`],
            ['Volume consommé', Math.round(m.volume).toLocaleString('fr-FR') + ' m³'],
            ['Montant facturé', fMoneyPdf(m.facture)],
            ['Montant encaissé', fMoneyPdf(m.encaisse)],
            ['Impayés du mois', fMoneyPdf(m.impayes)],
            ['Taux de recouvrement', m.taux.toFixed(1) + ' %'],
            ['Anomalies signalées', String(m.anomalies)]
        ],
        theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 10 }
    });

    // 2. Consommation & recouvrement par zone
    const zoneRows = Object.entries(m.zones).map(([zone, z]) => {
        const taux = z.facture > 0 ? (z.encaisse / z.facture * 100) : 0;
        return [zone, String(z.nb), Math.round(z.volume).toLocaleString('fr-FR'),
                fMoneyPdf(z.facture), fMoneyPdf(z.encaisse), taux.toFixed(0) + ' %'];
    });
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Zone', 'Cpt', 'Volume (m³)', 'Facturé', 'Encaissé', 'Taux']],
        body: zoneRows.length ? zoneRows : [['—', '—', '—', '—', '—', '—']],
        theme: 'grid', headStyles: { fillColor: [30, 41, 59] }, styles: { fontSize: 9 }
    });

    // 3. Dépenses + solde
    const depBody = expenses.length
        ? expenses.map(e => [e.lib, fMoneyPdf(e.mnt)])
        : [['Aucune dépense saisie', fMoneyPdf(0)]];
    depBody.push([{ content: 'TOTAL DÉPENSES', styles: { fontStyle: 'bold' } },
                  { content: fMoneyPdf(depTotal), styles: { fontStyle: 'bold' } }]);
    depBody.push([{ content: 'SOLDE (encaissé - dépenses)', styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } },
                  { content: fMoneyPdf(solde), styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } }]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Dépenses', 'Montant']],
        body: depBody,
        theme: 'striped', headStyles: { fillColor: [245, 158, 11] }, styles: { fontSize: 10 }
    });

    let y = doc.lastAutoTable.finalY + 20;
    if (y > 250) { doc.addPage(); y = 30; }
    pdfSignatures(doc, y);

    doc.save(`ASUFOR_Rapport_Mensuel_${cycle === 'actuel' ? currentMonthStr() : cycle}.pdf`);
}

function genererAnnuel() {
    const year = document.getElementById('report-year').value;
    const { items: expenses, total: depTotal } = readExpenses();

    const rows = [];
    let tFacture = 0, tEncaisse = 0, tVolume = 0;
    for (let mm = 1; mm <= 12; mm++) {
        const cycle = `${year}-${String(mm).padStart(2, '0')}`;
        const recs = recordsOfCycle(cycle);
        if (!recs.length) continue;
        const m = cycleMetrics(recs);
        tFacture += m.facture; tEncaisse += m.encaisse; tVolume += m.volume;
        rows.push([
            monthLabel(cycle).replace(' ' + year, ''),
            String(m.nbCompteurs),
            Math.round(m.volume).toLocaleString('fr-FR'),
            fMoneyPdf(m.facture),
            fMoneyPdf(m.encaisse),
            (m.taux).toFixed(0) + ' %'
        ]);
    }

    if (!rows.length) { alert("Aucune donnée pour l'année " + year + "."); return; }

    const tauxAnnuel = tFacture > 0 ? (tEncaisse / tFacture * 100) : 0;
    const solde = tEncaisse - depTotal;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, 'Rapport annuel — Assemblée Générale', 'Exercice : ' + year);

    // Récapitulatif mensuel
    rows.push([
        { content: 'TOTAL', styles: { fontStyle: 'bold' } },
        '',
        { content: Math.round(tVolume).toLocaleString('fr-FR'), styles: { fontStyle: 'bold' } },
        { content: fMoneyPdf(tFacture), styles: { fontStyle: 'bold' } },
        { content: fMoneyPdf(tEncaisse), styles: { fontStyle: 'bold' } },
        { content: tauxAnnuel.toFixed(0) + ' %', styles: { fontStyle: 'bold' } }
    ]);
    doc.autoTable({
        startY: 42,
        head: [['Mois', 'Cpt', 'Volume (m³)', 'Facturé', 'Encaissé', 'Taux']],
        body: rows,
        theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 9 }
    });

    // Dépenses + solde
    const depBody = expenses.length
        ? expenses.map(e => [e.lib, fMoneyPdf(e.mnt)])
        : [['Aucune dépense saisie', fMoneyPdf(0)]];
    depBody.push([{ content: 'TOTAL DÉPENSES ANNUELLES', styles: { fontStyle: 'bold' } },
                  { content: fMoneyPdf(depTotal), styles: { fontStyle: 'bold' } }]);
    depBody.push([{ content: 'SOLDE ANNUEL', styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } },
                  { content: fMoneyPdf(solde), styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } }]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Dépenses de l\'exercice', 'Montant']],
        body: depBody,
        theme: 'striped', headStyles: { fillColor: [245, 158, 11] }, styles: { fontSize: 10 }
    });

    let y = doc.lastAutoTable.finalY + 20;
    if (y > 250) { doc.addPage(); y = 30; }
    pdfSignatures(doc, y);

    doc.save(`ASUFOR_Rapport_Annuel_${year}.pdf`);
}

// ── Thème ────────────────────────────────────────────────────
window.toggleTheme = function () {
    const html = document.documentElement;
    const next = (html.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    try { localStorage.setItem('asufor-theme', next); } catch (_) {}
    renderRecettesChart(); // recolore le graphique selon le thème
};
(function restoreTheme() {
    try { document.documentElement.setAttribute('data-theme', localStorage.getItem('asufor-theme') || 'dark'); } catch (_) {}
})();

// ── Chargement des données ───────────────────────────────────
async function loadAll() {
    if (window.AsuforLoader) AsuforLoader.update('Chargement des données…');
    const [agentsSnap, activeSnap, backupSnap] = await Promise.all([
        get(ref(db, 'db_agents')),
        get(ref(db, 'asufor_db_diandioly')),
        get(ref(db, 'asufor_backup'))
    ]);

    agents = agentsSnap.val() || {};
    const activeObj = activeSnap.val() || {};
    activeRecords = Object.values(activeObj);
    backupsRaw = backupSnap.val() || {};
    indexedBackups = B.indexBackups(backupsRaw);

    populatePeriodSelectors();
    renderDashboard();
    window.toggleReportMode();
    // Une ligne de dépense vide par défaut
    if (!document.querySelector('#expense-list .expense-row')) window.addExpenseRow();

    if (window.AsuforLoader) AsuforLoader.hide();
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (!B) {
            if (window.AsuforLoader) AsuforLoader.fail('Moteur de facturation (billing.js) non chargé.');
            return;
        }
        loadAll().catch(err => {
            console.error('Rapports :', err);
            if (window.AsuforLoader) AsuforLoader.fail('Impossible de charger les données (' + (err.code || err.message) + ').', { retry: () => loadAll() });
        });
    } else if (window.AsuforLoader) {
        AsuforLoader.fail('Session expirée ou invalide. Reconnexion nécessaire.');
    }
});
