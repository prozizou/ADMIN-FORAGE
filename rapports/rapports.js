/**
 * rapports.js — Rapports d'AG, Tableau de bord KPIs & Caisse (ASUFOR)
 * ===================================================================
 *
 * Lit les données existantes (db_agents, asufor_db_diandioly, asufor_backup) et
 * délègue tout le calcul monétaire à billing.js (source unique de vérité).
 *
 * Nouveautés :
 *   • Sélecteur de PÉRIODE : le tableau de bord peut afficher n'importe quel
 *     cycle passé, pas seulement le mois courant.
 *   • COMPARAISON : afficher les écarts d'un mois par rapport à un autre.
 *   • DÉPENSES persistées dans Firebase (asufor_depenses/{cycle}) → CAISSE :
 *     encaissé − dépenses = solde restant. Les rapports lisent ces dépenses.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, get, push, remove, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = window.ASUFOR_FIREBASE_CONFIG;
const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

if (window.AsuforLoader) AsuforLoader.show('Connexion sécurisée…');

const B = window.Billing; // moteur de facturation partagé
const esc = window.escHtml || (s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));

// ── État global ──────────────────────────────────────────────
let agents = {};
let activeRecords = [];
let backupsRaw = {};
let indexedBackups = [];
let expensesRaw = {};      // asufor_depenses : { "YYYY-MM": { id: {libelle,montant,...} } }
let chartRecettes = null;

let selCycle = 'actuel';   // période affichée au tableau de bord
let cmpCycle = null;       // période de comparaison (ou null)

let currentUser = 'système';
try { const s = JSON.parse(localStorage.getItem('asufor_session') || '{}'); if (s && s.role) currentUser = s.role; } catch (_) {}
const canEditExpenses = ['président', 'trésorier'].includes((currentUser || '').toLowerCase());

// ── Utilitaires ──────────────────────────────────────────────
function currentMonthStr() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
/** Clé de cycle réelle "YYYY-MM" (résout "actuel"). */
function cycleKey(cycle) { return (cycle === 'actuel') ? currentMonthStr() : cycle; }

function fMoney(n) { return Math.round(n || 0).toLocaleString('fr-FR') + ' FCFA'; }
function fMoneyPdf(n) { return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA'; }

function monthLabel(cycle) {
    const c = cycleKey(cycle);
    const [y, m] = c.split('-');
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
        .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}
function monthLabelShort(cycle) {
    const c = cycleKey(cycle);
    const [y, m] = c.split('-');
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
        .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
}
function zoneOf(r) {
    const z = (r.zone && String(r.zone).trim()) ||
              (agents[r.agent_id] && agents[r.agent_id].zone) || '';
    return z ? String(z).trim() : 'Sans zone';
}
function recordsOfCycle(cycle) {
    const c = cycleKey(cycle);
    if (c === currentMonthStr() && activeRecords.length) return activeRecords;
    const node = backupsRaw[c];
    return (node && node.donnees) ? Object.values(node.donnees) : [];
}
function allCyclesAsc() {
    const set = new Set(Object.keys(backupsRaw));
    set.add(currentMonthStr());
    return Array.from(set).sort();
}

// ── Dépenses / Caisse ────────────────────────────────────────
function expensesOfCycle(cycle) {
    const node = expensesRaw[cycleKey(cycle)] || {};
    return Object.entries(node).map(([key, d]) => ({ key, ...d }));
}
function expensesTotalOfCycle(cycle) {
    return expensesOfCycle(cycle).reduce((s, d) => s + (Number(d.montant) || 0), 0);
}
function expensesOfYear(year) {
    const out = [];
    Object.keys(expensesRaw).filter(k => k.startsWith(year + '-')).sort().forEach(k => {
        Object.entries(expensesRaw[k]).forEach(([key, d]) => out.push({ cycle: k, key, ...d }));
    });
    return out;
}
function totalEncaisseAllTime() {
    return allCyclesAsc().reduce((s, c) => s + cycleMetrics(recordsOfCycle(c)).encaisse, 0);
}
function totalDepensesAllTime() {
    return Object.values(expensesRaw).reduce((s, node) =>
        s + Object.values(node).reduce((a, d) => a + (Number(d.montant) || 0), 0), 0);
}

// ── Métriques d'un cycle (billing.js) ────────────────────────
function cycleMetrics(records) {
    let facture = 0, encaisse = 0, impayes = 0, volume = 0, nbReleves = 0, anomalies = 0;
    const zones = {};
    records.forEach(r => {
        const zone = zoneOf(r);
        if (!zones[zone]) zones[zone] = { facture: 0, encaisse: 0, impaye: 0, volume: 0, nb: 0 };
        zones[zone].nb++;
        if (B.toInt(r.new_index) > 0) nbReleves++;

        const c = B.computeCurrent(r);
        if (c.anomalie) { anomalies++; return; }

        facture += c.montant; volume += c.conso;
        zones[zone].facture += c.montant; zones[zone].volume += c.conso;
        if (B.isPaid(r)) { encaisse += c.montant; zones[zone].encaisse += c.montant; }
        else { impayes += c.montant; zones[zone].impaye += c.montant; }
    });
    const taux = facture > 0 ? (encaisse / facture * 100) : 0;
    return { facture, encaisse, impayes, volume, anomalies, nbCompteurs: records.length, nbReleves, taux, zones };
}

// ── Tableau de bord ──────────────────────────────────────────
function renderDashboard() {
    const cur = cycleMetrics(recordsOfCycle(selCycle));
    const cmp = cmpCycle ? cycleMetrics(recordsOfCycle(cmpCycle)) : null;

    setText('period-label', monthLabel(selCycle));

    setText('kpi-taux', cur.taux.toFixed(1) + ' %');
    setText('kpi-recettes', fMoney(cur.encaisse));
    setText('kpi-impayes', fMoney(cur.impayes));
    setText('kpi-volume', Math.round(cur.volume).toLocaleString('fr-FR') + ' m³');

    const bar = document.getElementById('kpi-taux-bar');
    if (bar) {
        bar.style.width = Math.min(100, cur.taux) + '%';
        bar.style.background = cur.taux >= 75 ? '#22c55e' : cur.taux >= 50 ? '#f59e0b' : '#ef4444';
    }

    // Deltas de comparaison
    renderDeltaPct('d-taux', cur.taux, cmp && cmp.taux, true);
    renderDelta('d-recettes', cur.encaisse, cmp && cmp.encaisse, true);
    renderDelta('d-impayes', cur.impayes, cmp && cmp.impayes, false);
    renderDelta('d-volume', cur.volume, cmp && cmp.volume, true, ' m³');

    renderCaisse(cur);
    renderRecettesChart();
    renderTopDebiteurs();
    renderZonesRisque(cur.zones);
    renderExpenses();
}

function renderDelta(id, cur, prev, goodWhenUp, suffix = ' FCFA') {
    const el = document.getElementById(id);
    if (!el) return;
    if (prev == null) { el.textContent = ''; return; }
    const diff = cur - prev;
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
    const good = diff === 0 ? null : (goodWhenUp ? diff > 0 : diff < 0);
    el.style.color = good === null ? 'var(--sub)' : good ? 'var(--success)' : 'var(--danger)';
    const val = suffix === ' m³' ? Math.round(Math.abs(diff)).toLocaleString('fr-FR') : Math.abs(diff).toLocaleString('fr-FR');
    el.textContent = `${arrow} ${val}${suffix} vs ${monthLabelShort(cmpCycle)}`;
}
function renderDeltaPct(id, cur, prev, goodWhenUp) {
    const el = document.getElementById(id);
    if (!el) return;
    if (prev == null) { el.textContent = ''; return; }
    const diff = cur - prev;
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
    const good = diff === 0 ? null : (goodWhenUp ? diff > 0 : diff < 0);
    el.style.color = good === null ? 'var(--sub)' : good ? 'var(--success)' : 'var(--danger)';
    el.textContent = `${arrow} ${Math.abs(diff).toFixed(1)} pts vs ${monthLabelShort(cmpCycle)}`;
}

function renderCaisse(curMetrics) {
    const depMois = expensesTotalOfCycle(selCycle);
    const soldeMois = curMetrics.encaisse - depMois;
    const totalEnc = totalEncaisseAllTime();
    const totalDep = totalDepensesAllTime();
    const soldeCaisse = totalEnc - totalDep;

    setText('caisse-encaisse', fMoney(totalEnc));
    setText('caisse-depenses', fMoney(totalDep));
    setText('caisse-solde', fMoney(soldeCaisse));
    const soldeEl = document.getElementById('caisse-solde');
    if (soldeEl) soldeEl.style.color = soldeCaisse >= 0 ? 'var(--success)' : 'var(--danger)';

    setText('caisse-mois-detail',
        `Sur ${monthLabel(selCycle)} : encaissé ${fMoney(curMetrics.encaisse)} − dépenses ${fMoney(depMois)} = ` +
        `solde ${fMoney(soldeMois)}`);
}

function renderRecettesChart() {
    const cycles = allCyclesAsc().slice(-12);
    const labels = cycles.map(monthLabelShort);
    const data = cycles.map(c => cycleMetrics(recordsOfCycle(c)).encaisse);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

    // Met en évidence la période sélectionnée
    const selKey = cycleKey(selCycle);
    const colors = cycles.map(c => c === selKey ? '#38bdf8' : '#0052fe');

    const ctx = document.getElementById('chart-recettes');
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartRecettes) chartRecettes.destroy();
    chartRecettes = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Recettes (FCFA)', data, backgroundColor: colors, borderRadius: 5 }] },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                title: { display: true, text: 'Recettes encaissées — 12 derniers cycles', color: textColor }
            },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            }
        }
    });
}

function renderTopDebiteurs() {
    const debiteurs = activeRecords
        .filter(r => !B.isPaid(r))
        .map(r => {
            const stmt = B.computeStatement(r, indexedBackups, { beforeCycle: '9999-99' });
            return { name: r.name || 'Inconnu', zone: zoneOf(r), compteur: r.numero_compteur || 'N/A', total: stmt.total };
        })
        .filter(d => d.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    const box = document.getElementById('top-debiteurs');
    box.innerHTML = debiteurs.length
        ? debiteurs.map((d, i) => `
            <div class="row-item">
                <span class="rank">${i + 1}</span>
                <div class="row-main"><b>${esc(d.name)}</b><small>${esc(d.zone)} · Cpt ${esc(d.compteur)}</small></div>
                <span class="row-amt">${fMoney(d.total)}</span>
            </div>`).join('')
        : '<p class="muted">Aucun débiteur — tout est réglé 🎉</p>';
}

function renderZonesRisque(zones) {
    const rows = Object.entries(zones).map(([zone, z]) => ({
        zone, taux: z.facture > 0 ? (z.encaisse / z.facture * 100) : 0, impaye: z.impaye, nb: z.nb
    })).sort((a, b) => a.taux - b.taux);

    const box = document.getElementById('zones-risque');
    box.innerHTML = rows.length ? rows.map(r => {
        const cls = r.taux >= 75 ? 'ok' : r.taux >= 50 ? 'warn' : 'bad';
        return `<div class="row-item">
            <div class="row-main"><b>${esc(r.zone)}</b><small>${r.nb} compteur(s) · Impayés : ${fMoney(r.impaye)}</small></div>
            <span class="tag tag-${cls}">${r.taux.toFixed(0)} %</span>
        </div>`;
    }).join('') : '<p class="muted">Aucune donnée de zone.</p>';
}

// ── Dépenses : liste + CRUD Firebase ─────────────────────────
function renderExpenses() {
    const list = expensesOfCycle(selCycle).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const total = list.reduce((s, d) => s + (Number(d.montant) || 0), 0);
    const box = document.getElementById('expense-list');
    const ck = cycleKey(selCycle);

    if (!list.length) {
        box.innerHTML = '<p class="muted">Aucune dépense enregistrée pour ' + esc(monthLabel(selCycle)) + '.</p>';
    } else {
        box.innerHTML = list.map(d => `
            <div class="row-item">
                <div class="row-main">
                    <b>${esc(d.libelle || 'Dépense')}</b>
                    <small>${esc(d.date || '')}${d.created_by ? ' · ' + esc(d.created_by) : ''}</small>
                </div>
                <span class="row-amt" style="color:var(--amber)">${fMoney(d.montant)}</span>
                ${canEditExpenses ? `<button class="exp-del" title="Supprimer" onclick="deleteExpense('${ck}','${d.key}')">✕</button>` : ''}
            </div>`).join('');
    }
    setText('expense-total', fMoney(total));
    setText('expense-period', monthLabel(selCycle));
}

window.addExpense = async function () {
    if (!canEditExpenses) { alert('Seuls le président et le trésorier peuvent saisir des dépenses.'); return; }
    const libEl = document.getElementById('exp-new-lib');
    const mntEl = document.getElementById('exp-new-mnt');
    const libelle = libEl.value.trim();
    const montant = parseFloat(mntEl.value);
    if (!libelle) { alert('Libellé requis.'); return; }
    if (!(montant >= 0) || isNaN(montant)) { alert('Montant invalide.'); return; }

    const ck = cycleKey(selCycle);
    try {
        await push(ref(db, 'asufor_depenses/' + ck), {
            libelle, montant,
            date: new Date().toISOString().slice(0, 10),
            created_by: currentUser,
            created_at: new Date().toISOString()
        });
        libEl.value = ''; mntEl.value = '';
        // onValue re-render automatiquement
    } catch (e) {
        alert('Erreur enregistrement dépense : ' + (e.code || e.message));
    }
};

window.deleteExpense = async function (ck, key) {
    if (!canEditExpenses) return;
    if (!confirm('Supprimer cette dépense ?')) return;
    try { await remove(ref(db, 'asufor_depenses/' + ck + '/' + key)); }
    catch (e) { alert('Erreur suppression : ' + (e.code || e.message)); }
};

// ── Sélecteurs de période ────────────────────────────────────
function populateSelectors() {
    const cyclesDesc = allCyclesAsc().slice().reverse();
    const optFor = (c) => {
        const isCur = (c === currentMonthStr());
        const val = isCur ? 'actuel' : c;
        return `<option value="${val}">${isCur ? '🌟 Mois courant — ' : '📅 '}${monthLabel(c)}</option>`;
    };
    document.getElementById('dash-period').innerHTML = cyclesDesc.map(optFor).join('');
    document.getElementById('dash-compare').innerHTML =
        '<option value="">— Aucune comparaison —</option>' + cyclesDesc.map(optFor).join('');

    const years = Array.from(new Set(allCyclesAsc().map(c => c.split('-')[0]))).sort().reverse();
    document.getElementById('report-year').innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');

    // Masque le formulaire d'ajout de dépense pour les rôles non autorisés
    const addForm = document.getElementById('expense-add');
    if (addForm && !canEditExpenses) addForm.style.display = 'none';
}

window.onPeriodChange = function () {
    selCycle = document.getElementById('dash-period').value;
    renderDashboard();
};
window.onCompareChange = function () {
    const v = document.getElementById('dash-compare').value;
    cmpCycle = v || null;
    renderDashboard();
};

window.toggleReportMode = function () {
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    document.getElementById('wrap-year').style.display = (mode === 'annuel') ? 'block' : 'none';
    document.getElementById('report-mensuel-note').style.display = (mode === 'mensuel') ? 'block' : 'none';
};

// ── Génération PDF ───────────────────────────────────────────
window.genererRapport = function () {
    if (typeof window.jspdf === 'undefined') { alert("Bibliothèque PDF non chargée."); return; }
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    if (mode === 'mensuel') genererMensuel();
    else genererAnnuel();
};

function pdfHeader(doc, titre, sousTitre) {
    doc.setFontSize(16); doc.setTextColor(0, 82, 254);
    doc.text("ASUFOR Diandioly — Gestion de l'eau", 14, 16);
    doc.setFontSize(13); doc.setTextColor(30, 41, 59);
    doc.text(titre, 14, 25);
    doc.setFontSize(10); doc.setTextColor(100);
    doc.text(sousTitre, 14, 31);
    doc.text("Édité le " + new Date().toLocaleDateString('fr-FR'), 14, 36);
}
function pdfSignatures(doc, y) {
    doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    [['Le Président', 20], ['Le Trésorier', 85], ['Le Secrétaire', 150]].forEach(([label, x]) => {
        doc.text(label, x, y); doc.line(x, y + 18, x + 45, y + 18);
    });
}
function depensesTable(doc, expenses, total, encaisse, labelTotal) {
    const body = expenses.length
        ? expenses.map(e => [e.libelle || 'Dépense', fMoneyPdf(e.montant)])
        : [['Aucune dépense enregistrée', fMoneyPdf(0)]];
    const solde = encaisse - total;
    body.push([{ content: labelTotal, styles: { fontStyle: 'bold' } }, { content: fMoneyPdf(total), styles: { fontStyle: 'bold' } }]);
    body.push([
        { content: 'SOLDE (encaissé − dépenses)', styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } },
        { content: fMoneyPdf(solde), styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } }
    ]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Dépenses', 'Montant']], body,
        theme: 'striped', headStyles: { fillColor: [245, 158, 11] }, styles: { fontSize: 10 }
    });
}

function genererMensuel() {
    const cycle = selCycle;
    const m = cycleMetrics(recordsOfCycle(cycle));
    const expenses = expensesOfCycle(cycle);
    const depTotal = expenses.reduce((s, e) => s + (Number(e.montant) || 0), 0);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, "Rapport mensuel — Assemblée Générale", "Période : " + monthLabel(cycle));

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

    depensesTable(doc, expenses, depTotal, m.encaisse, 'TOTAL DÉPENSES');

    let y = doc.lastAutoTable.finalY + 20;
    if (y > 250) { doc.addPage(); y = 30; }
    pdfSignatures(doc, y);
    doc.save(`ASUFOR_Rapport_Mensuel_${cycleKey(cycle)}.pdf`);
}

function genererAnnuel() {
    const year = document.getElementById('report-year').value;
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
            fMoneyPdf(m.facture), fMoneyPdf(m.encaisse), m.taux.toFixed(0) + ' %'
        ]);
    }
    if (!rows.length) { alert("Aucune donnée pour l'année " + year + "."); return; }

    const expenses = expensesOfYear(year);
    const depTotal = expenses.reduce((s, e) => s + (Number(e.montant) || 0), 0);
    const tauxAnnuel = tFacture > 0 ? (tEncaisse / tFacture * 100) : 0;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, "Rapport annuel — Assemblée Générale", "Exercice : " + year);

    rows.push([
        { content: 'TOTAL', styles: { fontStyle: 'bold' } }, '',
        { content: Math.round(tVolume).toLocaleString('fr-FR'), styles: { fontStyle: 'bold' } },
        { content: fMoneyPdf(tFacture), styles: { fontStyle: 'bold' } },
        { content: fMoneyPdf(tEncaisse), styles: { fontStyle: 'bold' } },
        { content: tauxAnnuel.toFixed(0) + ' %', styles: { fontStyle: 'bold' } }
    ]);
    doc.autoTable({
        startY: 42,
        head: [['Mois', 'Cpt', 'Volume (m³)', 'Facturé', 'Encaissé', 'Taux']],
        body: rows, theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 9 }
    });

    // Dépenses agrégées par mois pour l'exercice
    const expForPdf = expenses.map(e => ({ libelle: `${e.cycle} — ${e.libelle || 'Dépense'}`, montant: e.montant }));
    depensesTable(doc, expForPdf, depTotal, tEncaisse, 'TOTAL DÉPENSES ANNUELLES');

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
    renderRecettesChart();
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
    activeRecords = Object.values(activeSnap.val() || {});
    backupsRaw = backupSnap.val() || {};
    indexedBackups = B.indexBackups(backupsRaw);

    populateSelectors();
    window.toggleReportMode();

    // Dépenses en temps réel (mutées par cette page) → re-render à chaque changement
    onValue(ref(db, 'asufor_depenses'), (snap) => {
        expensesRaw = snap.val() || {};
        renderDashboard();
        if (window.AsuforLoader) AsuforLoader.hide();
    }, (err) => {
        console.error('Dépenses :', err.code, err.message);
        renderDashboard(); // le tableau de bord s'affiche même sans dépenses
        if (window.AsuforLoader) AsuforLoader.hide();
    });
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (!B) { if (window.AsuforLoader) AsuforLoader.fail('Moteur billing.js non chargé.'); return; }
        loadAll().catch(err => {
            console.error('Rapports :', err);
            if (window.AsuforLoader) AsuforLoader.fail('Impossible de charger les données (' + (err.code || err.message) + ').', { retry: () => loadAll() });
        });
    } else if (window.AsuforLoader) {
        AsuforLoader.fail('Session expirée ou invalide. Reconnexion nécessaire.');
    }
});
