/**
 * rapports.js — Rapports d'AG, Tableau de bord KPIs & Caisse (ASUFOR)
 * ===================================================================
 *
 * Lit les données existantes (Asufor/{forageKey}/{agents,compteurs,backup}) et
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
// ✅ Chemins Firebase du forage courant (legacy → asufor_db_diandioly, etc.)
const P = window.ForageContext.paths();

// ✅ Vue à 360° super-admin : sélecteur de village (aucun effet pour les autres rôles)
if (window.SuperadminVillage) {
    try {
        const sessionForSelector = JSON.parse(localStorage.getItem('asufor_session') || '{}');
        window.SuperadminVillage.init({ db, get, ref, session: sessionForSelector });
    } catch (_) { /* pas de session lisible : le sélecteur ne s'affiche simplement pas */ }
}

if (window.AsuforLoader) AsuforLoader.show('Connexion sécurisée…');

const B = window.Billing; // moteur de facturation partagé
const esc = window.escHtml || (s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

// ── État global ──────────────────────────────────────────────
let agents = {};
let activeRecords = [];
let backupsRaw = {};
let indexedBackups = [];
let expensesRaw = {};      // asufor_depenses : { "YYYY-MM": { id: {libelle,montant,...} } }
let motivationsRaw = {};   // asufor_motivations : { "YYYY-MM": { id: {beneficiaire,montant,...} } }
let chartRecettes = null;

let selCycle = 'actuel';   // période affichée au tableau de bord
let cmpCycle = null;       // période de comparaison (ou null)

let currentUser = 'système';
try { const s = JSON.parse(localStorage.getItem('asufor_session') || '{}'); if (s && s.role) currentUser = s.role; } catch (_) {}
const canEditExpenses = ['président', 'trésorier'].includes((currentUser || '').toLowerCase());

// ✅ Branding par forage : nom affiché (titre de page, en-tête PDF) résolu
// dynamiquement depuis Asufor/{forageKey}/config.nom, jamais "Diandioly" en dur —
// chaque village doit voir son propre nom (bug constaté en multi-forage).
let forageBranding = 'ASUFOR — Gestion de l\'eau';

// ── Utilitaires ──────────────────────────────────────────────
function currentMonthStr() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
/** Clé de cycle réelle "YYYY-MM" (résout "actuel"). */
function cycleKey(cycle) { return (cycle === 'actuel') ? currentMonthStr() : cycle; }

// Regroupement manuel par espace normale (et non toLocaleString) : le PDF (police
// standard de jsPDF) n'affiche pas l'espace fine insécable U+202F utilisée par
// Intl pour 'fr-FR', ce qui corrompait l'affichage (ex. "8/455" au lieu de "8 455").
function fNumber(n) { return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function fMoney(n) { return fNumber(n) + ' FCFA'; }

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
function expensesOfCycles(cycles) {
    const set = new Set(cycles);
    const out = [];
    Object.keys(expensesRaw).filter(k => set.has(k)).sort().forEach(k => {
        Object.entries(expensesRaw[k]).forEach(([key, d]) => out.push({ cycle: k, key, ...d }));
    });
    return out;
}
function expensesOfYear(year) {
    return expensesOfCycles(Object.keys(expensesRaw).filter(k => k.startsWith(year + '-')));
}
/** Code de confirmation de suppression : "YEAR-N" = N-ième dépense de l'année, triée par date. */
function expenseCode(cycle, key) {
    const year = cycle.split('-')[0];
    const list = expensesOfYear(year).sort((a, b) =>
        (a.date || '').localeCompare(b.date || '') || (a.created_at || '').localeCompare(b.created_at || ''));
    const idx = list.findIndex(d => d.cycle === cycle && d.key === key);
    return `${year}-${idx + 1}`;
}
function totalEncaisseAllTime() {
    return allCyclesAsc().reduce((s, c) => s + cycleMetrics(recordsOfCycle(c)).encaisse, 0);
}
function totalDepensesAllTime() {
    return Object.values(expensesRaw).reduce((s, node) =>
        s + Object.values(node).reduce((a, d) => a + (Number(d.montant) || 0), 0), 0);
}

// ── Motivations des agents / bénéficiaires ───────────────────
// Répartition d'une partie de l'encaissé du cycle entre les bénéficiaires
// (président, trésorier, secrétaire, agents releveurs, programmeur, frais de
// développement…) : Encaissé du mois − Σ(motivations) = Net.
function motivationsOfCycle(cycle) {
    const node = motivationsRaw[cycleKey(cycle)] || {};
    return Object.entries(node).map(([key, d]) => ({ key, ...d }));
}
function motivationsTotalOfCycle(cycle) {
    return motivationsOfCycle(cycle).reduce((s, d) => s + (Number(d.montant) || 0), 0);
}
function motivationsOfCycles(cycles) {
    const set = new Set(cycles);
    const out = [];
    Object.keys(motivationsRaw).filter(k => set.has(k)).sort().forEach(k => {
        Object.entries(motivationsRaw[k]).forEach(([key, d]) => out.push({ cycle: k, key, ...d }));
    });
    return out;
}
function motivationsOfYear(year) {
    return motivationsOfCycles(Object.keys(motivationsRaw).filter(k => k.startsWith(year + '-')));
}
/** Code de confirmation de suppression : "YEAR-Mn" = n-ième motivation de l'année. */
function motivationCode(cycle, key) {
    const year = cycle.split('-')[0];
    const list = motivationsOfYear(year).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const idx = list.findIndex(d => d.cycle === cycle && d.key === key);
    return `${year}-M${idx + 1}`;
}

// ── Métriques d'un cycle (billing.js) ────────────────────────
// ✅ CORRECTION : `impayes` reste la facture du SEUL mois (utilisé tel quel dans
//   les rapports mensuels imprimés/exportés, où « Impayés du mois » est le libellé
//   exact). `impayesTotal` (facture + arriérés cumulés) est la vraie somme « reste
//   à recouvrer » — jusqu'ici absente du tableau de bord, qui affichait le montant
//   du mois seul sous le libellé générique « Impayés », en désaccord avec le total
//   affiché dans les statistiques (même donnée, deux chiffres très différents).
// ✅ `volumePaye` / `volumeImpaye` : mêmes m³ que `volume`, ventilés selon que la
//   facture du mois est réglée ou non — permet d'afficher l'écart entre le m³
//   total facturé et le m³ des factures effectivement payées, valorisé en argent
//   via `impayes` (== facture − encaisse, par construction, sur le même périmètre).
function cycleMetrics(records, cycle) {
    let facture = 0, encaisse = 0, impayesMois = 0, impayesTotal = 0, volume = 0, volumePaye = 0, nbReleves = 0, anomalies = 0;
    const zones = {};
    const beforeCycle = (cycle == null || cycle === 'actuel') ? '9999-99' : cycle;
    records.forEach(r => {
        const zone = zoneOf(r);
        if (!zones[zone]) zones[zone] = { facture: 0, encaisse: 0, impaye: 0, volume: 0, nb: 0 };
        zones[zone].nb++;
        if (B.toInt(r.new_index) > 0) nbReleves++;

        const c = B.computeCurrent(r);
        if (c.anomalie) { anomalies++; return; }

        facture += c.montant; volume += c.conso;
        zones[zone].facture += c.montant; zones[zone].volume += c.conso;
        if (B.isPaid(r)) {
            encaisse += c.montant; zones[zone].encaisse += c.montant;
            volumePaye += c.conso;
        } else {
            impayesMois += c.montant;
            const arr = B.computeArrears(r, indexedBackups, { beforeCycle });
            const totalDu = c.montant + arr.arriere;
            impayesTotal += totalDu;
            zones[zone].impaye += totalDu;
        }
    });
    const taux = facture > 0 ? (encaisse / facture * 100) : 0;
    const volumeImpaye = volume - volumePaye;
    return {
        facture, encaisse, impayes: impayesMois, impayesTotal,
        volume, volumePaye, volumeImpaye,
        anomalies, nbCompteurs: records.length, nbReleves, taux, zones
    };
}

// ── Tableau de bord ──────────────────────────────────────────
function renderDashboard() {
    const cur = cycleMetrics(recordsOfCycle(selCycle), selCycle);
    const cmp = cmpCycle ? cycleMetrics(recordsOfCycle(cmpCycle), cmpCycle) : null;

    setText('period-label', monthLabel(selCycle));

    setText('kpi-taux', cur.taux.toFixed(1) + ' %');
    setText('kpi-recettes', fMoney(cur.encaisse));
    // ✅ « Reste à recouvrer » (facture du mois + arriérés), aligné sur stats.js —
    //   avant : facture du mois seule, en désaccord avec l'écran Statistiques.
    setText('kpi-impayes', fMoney(cur.impayesTotal));
    setText('kpi-volume', fNumber(cur.volume) + ' m³');

    // ✅ Écart entre le m³ total facturé et le m³ des factures payées, valorisé en
    //   argent (= impayés du mois, calculé sur le même périmètre par billing.js).
    setText('kpi-ecart-m3', fNumber(cur.volumeImpaye) + ' m³');
    setText('kpi-ecart-m3-fcfa',
        `${fNumber(cur.volume)} m³ facturés − ${fNumber(cur.volumePaye)} m³ payés ≈ ${fMoney(cur.impayes)}`);

    const bar = document.getElementById('kpi-taux-bar');
    if (bar) {
        bar.style.width = Math.min(100, cur.taux) + '%';
        bar.style.background = cur.taux >= 75 ? '#22c55e' : cur.taux >= 50 ? '#f59e0b' : '#ef4444';
    }

    // Deltas de comparaison
    renderDeltaPct('d-taux', cur.taux, cmp && cmp.taux, true);
    renderDelta('d-recettes', cur.encaisse, cmp && cmp.encaisse, true);
    renderDelta('d-impayes', cur.impayesTotal, cmp && cmp.impayesTotal, false);
    renderDelta('d-volume', cur.volume, cmp && cmp.volume, true, ' m³');
    renderDelta('d-ecart-m3', cur.volumeImpaye, cmp && cmp.volumeImpaye, false, ' m³');

    const soldeMoisNet = cur.encaisse - expensesTotalOfCycle(selCycle);
    setText('kpi-solde', fMoney(soldeMoisNet));
    const soldeKpiEl = document.getElementById('kpi-solde');
    if (soldeKpiEl) soldeKpiEl.style.color = soldeMoisNet >= 0 ? 'var(--success)' : 'var(--danger)';
    renderDelta('d-solde', soldeMoisNet, cmp ? (cmp.encaisse - expensesTotalOfCycle(cmpCycle)) : null, true);

    renderCaisse(cur);
    renderFinanceChart();
    renderTopDebiteurs();
    renderZonesRisque(cur.zones);
    renderExpenses();
    renderMotivations(cur);
}

function renderDelta(id, cur, prev, goodWhenUp, suffix = ' FCFA') {
    const el = document.getElementById(id);
    if (!el) return;
    if (prev == null) { el.textContent = ''; return; }
    const diff = cur - prev;
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
    const good = diff === 0 ? null : (goodWhenUp ? diff > 0 : diff < 0);
    el.style.color = good === null ? 'var(--sub)' : good ? 'var(--success)' : 'var(--danger)';
    el.textContent = `${arrow} ${fNumber(Math.abs(diff))}${suffix} vs ${monthLabelShort(cmpCycle)}`;
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

function renderFinanceChart() {
    const cycles = allCyclesAsc().slice(-12);
    const labels = cycles.map(monthLabelShort);
    const dataEnc = cycles.map(c => cycleMetrics(recordsOfCycle(c)).encaisse);
    const dataDep = cycles.map(c => expensesTotalOfCycle(c));
    const dataSolde = dataEnc.map((v, i) => v - dataDep[i]);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

    // Met en évidence la période sélectionnée
    const selKey = cycleKey(selCycle);
    const colorsEnc = cycles.map(c => c === selKey ? '#38bdf8' : '#0052fe');

    const ctx = document.getElementById('chart-recettes');
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartRecettes) chartRecettes.destroy();
    chartRecettes = new Chart(ctx, {
        data: {
            labels,
            datasets: [
                { type: 'bar', label: 'Encaissé', data: dataEnc, backgroundColor: colorsEnc, borderRadius: 5, order: 2 },
                { type: 'bar', label: 'Dépenses', data: dataDep, backgroundColor: '#f59e0b', borderRadius: 5, order: 2 },
                { type: 'line', label: 'Solde net', data: dataSolde, borderColor: '#a855f7', backgroundColor: '#a855f7', tension: .3, order: 1 }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, labels: { color: textColor } },
                title: { display: true, text: 'Encaissé, dépenses & solde net — 12 derniers cycles', color: textColor }
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
                    <small>N° ${esc(expenseCode(ck, d.key))} · ${esc(d.date || '')}${d.created_by ? ' · ' + esc(d.created_by) : ''}</small>
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
        await push(ref(db, P.depenses + '/' + ck), {
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
    const code = expenseCode(ck, key);
    const saisie = prompt(`Pour confirmer la suppression, tapez le code de la dépense : ${code}`);
    if (saisie === null) return;
    if (saisie.trim() !== code) { alert('Code incorrect — suppression annulée.'); return; }
    try { await remove(ref(db, P.depenses + '/' + ck + '/' + key)); }
    catch (e) { alert('Erreur suppression : ' + (e.code || e.message)); }
};

// ── Motivations des agents/bénéficiaires : liste + CRUD Firebase ────────────
// Somme totale perçue (encaissé du mois) − liste des bénéficiaires qui vont
// recevoir une motivation (président, trésorier, secrétaire, agents releveurs,
// programmeur, frais de développement…) = Net.
function renderMotivations(curMetrics) {
    const list = motivationsOfCycle(selCycle).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const total = list.reduce((s, d) => s + (Number(d.montant) || 0), 0);
    const box = document.getElementById('motivation-list');
    const ck = cycleKey(selCycle);

    if (!list.length) {
        box.innerHTML = '<p class="muted">Aucune motivation enregistrée pour ' + esc(monthLabel(selCycle)) + '.</p>';
    } else {
        box.innerHTML = list.map(d => `
            <div class="row-item">
                <div class="row-main">
                    <b>${esc(d.beneficiaire || 'Bénéficiaire')}</b>
                    <small>N° ${esc(motivationCode(ck, d.key))}${d.created_by ? ' · ' + esc(d.created_by) : ''}</small>
                </div>
                <span class="row-amt" style="color:var(--amber)">${fMoney(d.montant)}</span>
                ${canEditExpenses ? `<button class="exp-del" title="Supprimer" onclick="deleteMotivation('${ck}','${d.key}')">✕</button>` : ''}
            </div>`).join('');
    }

    const encaisseMois = curMetrics.encaisse;
    const net = encaisseMois - total;
    setText('motivation-encaisse', fMoney(encaisseMois));
    setText('motivation-total', fMoney(total));
    setText('motivation-net', fMoney(net));
    setText('motivation-period', monthLabel(selCycle));
    const netEl = document.getElementById('motivation-net');
    if (netEl) netEl.style.color = net >= 0 ? 'var(--success)' : 'var(--danger)';
}

window.addMotivation = async function () {
    if (!canEditExpenses) { alert('Seuls le président et le trésorier peuvent saisir les motivations.'); return; }
    const benEl = document.getElementById('mot-new-ben');
    const mntEl = document.getElementById('mot-new-mnt');
    const beneficiaire = benEl.value.trim();
    const montant = parseFloat(mntEl.value);
    if (!beneficiaire) { alert('Bénéficiaire requis (ex : Président, Agent releveur - Zone A…).'); return; }
    if (!(montant >= 0) || isNaN(montant)) { alert('Montant invalide.'); return; }

    const ck = cycleKey(selCycle);
    try {
        await push(ref(db, P.motivations + '/' + ck), {
            beneficiaire, montant,
            created_by: currentUser,
            created_at: new Date().toISOString()
        });
        benEl.value = ''; mntEl.value = '';
        // onValue re-render automatiquement
    } catch (e) {
        alert('Erreur enregistrement motivation : ' + (e.code || e.message));
    }
};

window.deleteMotivation = async function (ck, key) {
    if (!canEditExpenses) return;
    const code = motivationCode(ck, key);
    const saisie = prompt(`Pour confirmer la suppression, tapez le code de la motivation : ${code}`);
    if (saisie === null) return;
    if (saisie.trim() !== code) { alert('Code incorrect — suppression annulée.'); return; }
    try { await remove(ref(db, P.motivations + '/' + ck + '/' + key)); }
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

    // Masque le formulaire d'ajout de dépense / motivation pour les rôles non autorisés
    const addForm = document.getElementById('expense-add');
    if (addForm && !canEditExpenses) addForm.style.display = 'none';
    const motAddForm = document.getElementById('motivation-add');
    if (motAddForm && !canEditExpenses) motAddForm.style.display = 'none';
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
    document.getElementById('wrap-year').style.display = (mode === 'annuel' || mode === 'trimestriel') ? 'block' : 'none';
    document.getElementById('wrap-quarter').style.display = (mode === 'trimestriel') ? 'block' : 'none';
    document.getElementById('report-mensuel-note').style.display = (mode === 'mensuel') ? 'block' : 'none';
};

// ── Génération PDF ───────────────────────────────────────────
window.genererRapport = function () {
    if (typeof window.jspdf === 'undefined') { alert("Bibliothèque PDF non chargée."); return; }
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    if (mode === 'mensuel') genererMensuel();
    else if (mode === 'trimestriel') genererTrimestriel();
    else genererAnnuel();
};

// Logo chargé une seule fois, en parallèle du reste (utilisé en entête PDF).
let logoDataUrl = null;
(async function loadLogo() {
    try {
        const res = await fetch(new URL('../icons/icon-192.png', import.meta.url));
        const blob = await res.blob();
        logoDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) { console.warn('Logo PDF non chargé :', e); }
})();

function pdfHeader(doc, titre, sousTitre) {
    let x = 14;
    if (logoDataUrl) {
        try { doc.addImage(logoDataUrl, 'PNG', 14, 8, 16, 16); x = 34; } catch (_) {}
    }
    doc.setFontSize(16); doc.setTextColor(0, 82, 254);
    doc.text(forageBranding, x, 16);
    doc.setFontSize(13); doc.setTextColor(30, 41, 59);
    doc.text(titre, x, 25);
    doc.setFontSize(10); doc.setTextColor(100);
    doc.text(sousTitre, x, 31);
    doc.text("Édité le " + new Date().toLocaleDateString('fr-FR'), x, 36);
}
function pdfFooter(doc) {
    const pages = doc.internal.getNumberOfPages();
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(8); doc.setTextColor(120);
        doc.text("Application créée par prozizou298@gmail.com — Besoin d'assistance : +221 77 350 05 95", w / 2, h - 10, { align: 'center' });
        doc.text(`Page ${i}/${pages}`, w - 14, h - 10, { align: 'right' });
    }
}
function pdfSignatures(doc, y) {
    doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    [['Le Président', 20], ['Le Trésorier', 85], ['Le Secrétaire', 150]].forEach(([label, x]) => {
        doc.text(label, x, y); doc.line(x, y + 18, x + 45, y + 18);
    });
}
function depensesTable(doc, expenses, total, encaisse, labelTotal) {
    const body = expenses.length
        ? expenses.map(e => [e.libelle || 'Dépense', fMoney(e.montant)])
        : [['Aucune dépense enregistrée', fMoney(0)]];
    const solde = encaisse - total;
    body.push([{ content: labelTotal, styles: { fontStyle: 'bold' } }, { content: fMoney(total), styles: { fontStyle: 'bold' } }]);
    body.push([
        { content: 'SOLDE (encaissé − dépenses)', styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } },
        { content: fMoney(solde), styles: { fontStyle: 'bold', textColor: solde >= 0 ? [22, 163, 74] : [239, 68, 68] } }
    ]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Dépenses', 'Montant']], body,
        theme: 'striped', headStyles: { fillColor: [245, 158, 11] }, styles: { fontSize: 10 }
    });
}
// Somme totale perçue (encaissé) − liste des bénéficiaires qui vont recevoir une
// motivation (président, trésorier, secrétaire, agents, programmeur, frais de
// développement…) = Net.
function motivationsTable(doc, motivations, total, encaisse) {
    const body = motivations.length
        ? motivations.map(e => [e.beneficiaire || 'Bénéficiaire', fMoney(e.montant)])
        : [['Aucune motivation enregistrée', fMoney(0)]];
    const net = encaisse - total;
    body.push([{ content: 'TOTAL MOTIVATIONS', styles: { fontStyle: 'bold' } }, { content: fMoney(total), styles: { fontStyle: 'bold' } }]);
    body.push([
        { content: 'NET (encaissé − motivations)', styles: { fontStyle: 'bold', textColor: net >= 0 ? [22, 163, 74] : [239, 68, 68] } },
        { content: fMoney(net), styles: { fontStyle: 'bold', textColor: net >= 0 ? [22, 163, 74] : [239, 68, 68] } }
    ]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Motivations des agents / bénéficiaires', 'Montant']], body,
        theme: 'striped', headStyles: { fillColor: [168, 85, 247] }, styles: { fontSize: 10 }
    });
}

function genererMensuel() {
    const cycle = selCycle;
    const m = cycleMetrics(recordsOfCycle(cycle), cycle);
    const expenses = expensesOfCycle(cycle);
    const depTotal = expenses.reduce((s, e) => s + (Number(e.montant) || 0), 0);
    const motivations = motivationsOfCycle(cycle);
    const motTotal = motivations.reduce((s, e) => s + (Number(e.montant) || 0), 0);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, "Rapport mensuel — Assemblée Générale", "Période : " + monthLabel(cycle));

    doc.autoTable({
        startY: 42,
        head: [['Indicateur', 'Valeur']],
        body: [
            ['Compteurs suivis', String(m.nbCompteurs)],
            ['Relevés effectués', `${m.nbReleves} / ${m.nbCompteurs}`],
            ['Volume consommé (facturé)', fNumber(m.volume) + ' m³'],
            ['Volume des factures payées', fNumber(m.volumePaye) + ' m³'],
            ['Écart m³ (facturé − payé)', fNumber(m.volumeImpaye) + ' m³'],
            ['Valeur de l\'écart m³', fMoney(m.impayes)],
            ['Montant facturé', fMoney(m.facture)],
            ['Montant encaissé', fMoney(m.encaisse)],
            ['Impayés du mois', fMoney(m.impayes)],
            ['Reste à recouvrer (dont arriérés)', fMoney(m.impayesTotal)],
            ['Taux de recouvrement', m.taux.toFixed(1) + ' %'],
            ['Anomalies signalées', String(m.anomalies)]
        ],
        theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 10 }
    });

    const zoneRows = Object.entries(m.zones).map(([zone, z]) => {
        const taux = z.facture > 0 ? (z.encaisse / z.facture * 100) : 0;
        return [zone, String(z.nb), fNumber(z.volume),
                fMoney(z.facture), fMoney(z.encaisse), taux.toFixed(0) + ' %'];
    });
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Zone', 'Cpt', 'Volume (m³)', 'Facturé', 'Encaissé', 'Taux']],
        body: zoneRows.length ? zoneRows : [['—', '—', '—', '—', '—', '—']],
        theme: 'grid', headStyles: { fillColor: [30, 41, 59] }, styles: { fontSize: 9 }
    });

    depensesTable(doc, expenses, depTotal, m.encaisse, 'TOTAL DÉPENSES');
    motivationsTable(doc, motivations, motTotal, m.encaisse);

    let y = doc.lastAutoTable.finalY + 20;
    if (y > 250) { doc.addPage(); y = 30; }
    pdfSignatures(doc, y);
    pdfFooter(doc);
    doc.save(`ASUFOR_Rapport_Mensuel_${cycleKey(cycle)}.pdf`);
}

// Rapport multi-mois (annuel ou trimestriel) : tableau mensuel + dépenses + signatures.
function genererPeriode({ cycles, year, titre, sousTitre, filename, expenses, motivations }) {
    const rows = [];
    let tFacture = 0, tEncaisse = 0, tVolume = 0, tVolumePaye = 0, tImpayes = 0;
    cycles.forEach(cycle => {
        const recs = recordsOfCycle(cycle);
        if (!recs.length) return;
        const m = cycleMetrics(recs, cycle);
        tFacture += m.facture; tEncaisse += m.encaisse; tVolume += m.volume;
        tVolumePaye += m.volumePaye; tImpayes += m.impayes;
        rows.push([
            monthLabel(cycle).replace(' ' + year, ''),
            String(m.nbCompteurs),
            fNumber(m.volume),
            fMoney(m.facture), fMoney(m.encaisse), m.taux.toFixed(0) + ' %'
        ]);
    });
    if (!rows.length) { alert("Aucune donnée pour cette période."); return; }

    const depTotal = expenses.reduce((s, e) => s + (Number(e.montant) || 0), 0);
    const motTotal = (motivations || []).reduce((s, e) => s + (Number(e.montant) || 0), 0);
    const tauxPeriode = tFacture > 0 ? (tEncaisse / tFacture * 100) : 0;
    const tVolumeEcart = tVolume - tVolumePaye;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    pdfHeader(doc, titre, sousTitre);

    doc.autoTable({
        startY: 42,
        head: [['Indicateur', 'Valeur']],
        body: [
            ['Volume consommé (facturé)', fNumber(tVolume) + ' m³'],
            ['Volume des factures payées', fNumber(tVolumePaye) + ' m³'],
            ['Écart m³ (facturé − payé)', fNumber(tVolumeEcart) + ' m³'],
            ['Valeur de l\'écart m³', fMoney(tImpayes)]
        ],
        theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 10 }
    });

    rows.push([
        { content: 'TOTAL', styles: { fontStyle: 'bold' } }, '',
        { content: fNumber(tVolume), styles: { fontStyle: 'bold' } },
        { content: fMoney(tFacture), styles: { fontStyle: 'bold' } },
        { content: fMoney(tEncaisse), styles: { fontStyle: 'bold' } },
        { content: tauxPeriode.toFixed(0) + ' %', styles: { fontStyle: 'bold' } }
    ]);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Mois', 'Cpt', 'Volume (m³)', 'Facturé', 'Encaissé', 'Taux']],
        body: rows, theme: 'striped', headStyles: { fillColor: [0, 82, 254] }, styles: { fontSize: 9 }
    });

    const expForPdf = expenses.map(e => ({ libelle: `${e.cycle} — ${e.libelle || 'Dépense'}`, montant: e.montant }));
    depensesTable(doc, expForPdf, depTotal, tEncaisse, 'TOTAL DÉPENSES');

    const motForPdf = (motivations || []).map(e => ({ beneficiaire: `${e.cycle} — ${e.beneficiaire || 'Bénéficiaire'}`, montant: e.montant }));
    motivationsTable(doc, motForPdf, motTotal, tEncaisse);

    let y = doc.lastAutoTable.finalY + 20;
    if (y > 250) { doc.addPage(); y = 30; }
    pdfSignatures(doc, y);
    pdfFooter(doc);
    doc.save(filename);
}

function cyclesOfYear(year) {
    return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}
function cyclesOfQuarter(year, q) {
    const startMonth = (q - 1) * 3 + 1;
    return [0, 1, 2].map(i => `${year}-${String(startMonth + i).padStart(2, '0')}`);
}

function genererAnnuel() {
    const year = document.getElementById('report-year').value;
    genererPeriode({
        cycles: cyclesOfYear(year), year,
        titre: "Rapport annuel — Assemblée Générale",
        sousTitre: "Exercice : " + year,
        filename: `ASUFOR_Rapport_Annuel_${year}.pdf`,
        expenses: expensesOfYear(year),
        motivations: motivationsOfYear(year)
    });
}

function genererTrimestriel() {
    const year = document.getElementById('report-year').value;
    const q = parseInt(document.getElementById('report-quarter').value, 10);
    const cycles = cyclesOfQuarter(year, q);
    genererPeriode({
        cycles, year,
        titre: "Rapport trimestriel — Assemblée Générale",
        sousTitre: `Trimestre : T${q} ${year}`,
        filename: `ASUFOR_Rapport_T${q}_${year}.pdf`,
        expenses: expensesOfCycles(cycles),
        motivations: motivationsOfCycles(cycles)
    });
}

// ── Génération CSV ───────────────────────────────────────────
function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
    return rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}
function downloadCsv(filename, rows) {
    const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.exporterCSV = function () {
    const mode = document.querySelector('input[name="report-mode"]:checked').value;
    if (mode === 'mensuel') exporterMensuelCSV();
    else if (mode === 'trimestriel') exporterTrimestrielCSV();
    else exporterAnnuelCSV();
};

function exporterMensuelCSV() {
    const cycle = selCycle;
    const m = cycleMetrics(recordsOfCycle(cycle), cycle);
    const expenses = expensesOfCycle(cycle);
    const depTotal = expensesTotalOfCycle(cycle);
    const motivations = motivationsOfCycle(cycle);
    const motTotal = motivationsTotalOfCycle(cycle);

    const rows = [
        ['Rapport mensuel', monthLabel(cycle)],
        [],
        ['Indicateur', 'Valeur'],
        ['Compteurs suivis', m.nbCompteurs],
        ['Relevés effectués', `${m.nbReleves}/${m.nbCompteurs}`],
        ['Volume consommé, facturé (m3)', Math.round(m.volume)],
        ['Volume des factures payées (m3)', Math.round(m.volumePaye)],
        ['Écart m3 (facturé - payé)', Math.round(m.volumeImpaye)],
        ['Valeur de l\'écart m3 (FCFA)', Math.round(m.impayes)],
        ['Montant facturé (FCFA)', Math.round(m.facture)],
        ['Montant encaissé (FCFA)', Math.round(m.encaisse)],
        ['Impayés du mois (FCFA)', Math.round(m.impayes)],
        ['Reste à recouvrer, dont arriérés (FCFA)', Math.round(m.impayesTotal)],
        ['Taux de recouvrement (%)', m.taux.toFixed(1)],
        ['Anomalies signalées', m.anomalies],
        [],
        ['Zone', 'Compteurs', 'Volume (m3)', 'Facturé (FCFA)', 'Encaissé (FCFA)', 'Taux (%)']
    ];
    Object.entries(m.zones).forEach(([zone, z]) => {
        const taux = z.facture > 0 ? (z.encaisse / z.facture * 100) : 0;
        rows.push([zone, z.nb, Math.round(z.volume), Math.round(z.facture), Math.round(z.encaisse), taux.toFixed(1)]);
    });
    rows.push([]);
    rows.push(['Dépenses', 'Montant (FCFA)', 'Date', 'Saisi par']);
    expenses.forEach(e => rows.push([e.libelle || 'Dépense', Math.round(e.montant) || 0, e.date || '', e.created_by || '']));
    rows.push(['TOTAL DÉPENSES', Math.round(depTotal), '', '']);
    rows.push(['SOLDE (encaissé − dépenses)', Math.round(m.encaisse - depTotal), '', '']);
    rows.push([]);
    rows.push(['Motivations (bénéficiaires)', 'Montant (FCFA)', 'Saisi par']);
    motivations.forEach(e => rows.push([e.beneficiaire || 'Bénéficiaire', Math.round(e.montant) || 0, e.created_by || '']));
    rows.push(['TOTAL MOTIVATIONS', Math.round(motTotal), '']);
    rows.push(['NET (encaissé − motivations)', Math.round(m.encaisse - motTotal), '']);

    downloadCsv(`ASUFOR_Rapport_Mensuel_${cycleKey(cycle)}.csv`, rows);
}

function exporterPeriodeCSV({ cycles, year, titre, sousTitre, filename, expenses, motivations }) {
    const rows = [[titre, sousTitre], [], ['Mois', 'Compteurs', 'Volume (m3)', 'Facturé (FCFA)', 'Encaissé (FCFA)', 'Taux (%)']];
    let tFacture = 0, tEncaisse = 0, tVolume = 0, tVolumePaye = 0, tImpayes = 0, any = false;
    cycles.forEach(cycle => {
        const recs = recordsOfCycle(cycle);
        if (!recs.length) return;
        any = true;
        const m = cycleMetrics(recs, cycle);
        tFacture += m.facture; tEncaisse += m.encaisse; tVolume += m.volume;
        tVolumePaye += m.volumePaye; tImpayes += m.impayes;
        rows.push([monthLabel(cycle).replace(' ' + year, ''), m.nbCompteurs, Math.round(m.volume), Math.round(m.facture), Math.round(m.encaisse), m.taux.toFixed(1)]);
    });
    if (!any) { alert("Aucune donnée pour cette période."); return; }
    const tauxPeriode = tFacture > 0 ? (tEncaisse / tFacture * 100) : 0;
    rows.push(['TOTAL', '', Math.round(tVolume), Math.round(tFacture), Math.round(tEncaisse), tauxPeriode.toFixed(1)]);

    rows.push([]);
    rows.push(['Volume consommé, facturé (m3)', Math.round(tVolume)]);
    rows.push(['Volume des factures payées (m3)', Math.round(tVolumePaye)]);
    rows.push(['Écart m3 (facturé - payé)', Math.round(tVolume - tVolumePaye)]);
    rows.push(['Valeur de l\'écart m3 (FCFA)', Math.round(tImpayes)]);

    const depTotal = expenses.reduce((s, e) => s + (Number(e.montant) || 0), 0);
    rows.push([]);
    rows.push(['Dépenses', 'Montant (FCFA)', 'Date', 'Saisi par']);
    expenses.forEach(e => rows.push([`${e.cycle} — ${e.libelle || 'Dépense'}`, Math.round(e.montant) || 0, e.date || '', e.created_by || '']));
    rows.push(['TOTAL DÉPENSES', Math.round(depTotal), '', '']);
    rows.push(['SOLDE (encaissé − dépenses)', Math.round(tEncaisse - depTotal), '', '']);

    const motTotal = (motivations || []).reduce((s, e) => s + (Number(e.montant) || 0), 0);
    rows.push([]);
    rows.push(['Motivations (bénéficiaires)', 'Montant (FCFA)', 'Saisi par']);
    (motivations || []).forEach(e => rows.push([`${e.cycle} — ${e.beneficiaire || 'Bénéficiaire'}`, Math.round(e.montant) || 0, e.created_by || '']));
    rows.push(['TOTAL MOTIVATIONS', Math.round(motTotal), '']);
    rows.push(['NET (encaissé − motivations)', Math.round(tEncaisse - motTotal), '']);

    downloadCsv(filename, rows);
}

function exporterAnnuelCSV() {
    const year = document.getElementById('report-year').value;
    exporterPeriodeCSV({
        cycles: cyclesOfYear(year), year,
        titre: 'Rapport annuel', sousTitre: year,
        filename: `ASUFOR_Rapport_Annuel_${year}.csv`,
        expenses: expensesOfYear(year),
        motivations: motivationsOfYear(year)
    });
}

function exporterTrimestrielCSV() {
    const year = document.getElementById('report-year').value;
    const q = parseInt(document.getElementById('report-quarter').value, 10);
    const cycles = cyclesOfQuarter(year, q);
    exporterPeriodeCSV({
        cycles, year,
        titre: 'Rapport trimestriel', sousTitre: `T${q} ${year}`,
        filename: `ASUFOR_Rapport_T${q}_${year}.csv`,
        expenses: expensesOfCycles(cycles),
        motivations: motivationsOfCycles(cycles)
    });
}

// ── Thème ────────────────────────────────────────────────────
window.toggleTheme = function () {
    const html = document.documentElement;
    const next = (html.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    try { localStorage.setItem('asufor-theme', next); } catch (_) {}
    renderFinanceChart();
};
(function restoreTheme() {
    try { document.documentElement.setAttribute('data-theme', localStorage.getItem('asufor-theme') || 'dark'); } catch (_) {}
})();

// ── Chargement des données ───────────────────────────────────
async function loadAll() {
    if (window.AsuforLoader) AsuforLoader.update('Chargement des données…');
    const [agentsSnap, activeSnap, backupSnap, configSnap] = await Promise.all([
        get(ref(db, P.agents)),
        get(ref(db, P.compteurs)),
        get(ref(db, P.backup)),
        get(ref(db, P.config))
    ]);
    agents = agentsSnap.val() || {};
    activeRecords = Object.values(activeSnap.val() || {});
    backupsRaw = backupSnap.val() || {};
    indexedBackups = B.indexBackups(backupsRaw);

    const cfg = configSnap.val() || {};
    if (cfg.nom) {
        forageBranding = cfg.nom;
        document.title = cfg.nom + ' – Rapports & Bilan';
    }

    populateSelectors();
    window.toggleReportMode();

    // Dépenses en temps réel (mutées par cette page) → re-render à chaque changement
    onValue(ref(db, P.depenses), (snap) => {
        expensesRaw = snap.val() || {};
        try {
            renderDashboard();
            if (window.AsuforLoader) AsuforLoader.hide();
        } catch (err) {
            console.error('Rapports (rendu) :', err);
            if (window.AsuforLoader) AsuforLoader.fail('Erreur d\'affichage du tableau de bord (' + err.message + ').', { retry: () => loadAll() });
        }
    }, (err) => {
        console.error('Dépenses :', err.code, err.message);
        try {
            renderDashboard(); // le tableau de bord s'affiche même sans dépenses
            if (window.AsuforLoader) AsuforLoader.hide();
        } catch (renderErr) {
            console.error('Rapports (rendu) :', renderErr);
            if (window.AsuforLoader) AsuforLoader.fail('Erreur d\'affichage du tableau de bord (' + renderErr.message + ').', { retry: () => loadAll() });
        }
    });

    // Motivations des agents/bénéficiaires en temps réel (mutées par cette page)
    onValue(ref(db, P.motivations), (snap) => {
        motivationsRaw = snap.val() || {};
        try { renderDashboard(); } catch (err) { console.error('Rapports (rendu) :', err); }
    }, (err) => {
        console.error('Motivations :', err.code, err.message);
        try { renderDashboard(); } catch (renderErr) { console.error('Rapports (rendu) :', renderErr); }
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
