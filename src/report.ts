/**
 * Analysis model construction and report generation.
 *
 * Technical choices:
 * - The HTML report is a SINGLE self-contained file (inline CSS + JS, data
 *   embedded as JSON): it opens with a double-click, no server needed, and
 *   stays archivable to compare two scans over time.
 * - 🟢/🟡 gains are computed WITHOUT double counting: a fully-🟢 folder counts
 *   as a whole; for a mixed folder only its 🟢/🟡 children count.
 * - Detected MSIX mirrors are excluded from the adjusted total and flagged.
 * - The report is bilingual (FR/EN): every data string carries both languages
 *   (note/noteEn…), the chrome uses an embedded dictionary, and a language
 *   switch is rendered top-right (auto-detected, persisted).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TopEntry, ChildEntry } from './scanner.ts';
import { classifyTop, classifyChild, type Classification, type Category } from './knowledge.ts';
import type { MsixMirror } from './dedupe.ts';
import type { Section } from './types.ts';
import type { Evolution } from './history.ts';

// ---------- Analysis model ----------

export interface AnalyzedChild extends ChildEntry {
  classification: Classification;
}

export interface AnalyzedEntry extends Omit<TopEntry, 'children'> {
  classification: Classification;
  children: AnalyzedChild[];
  /** Is this folder an MSIX mirror (already counted under Packages)? */
  isMsixMirror: boolean;
  /** Unused for more than 6 months? */
  isStale: boolean;
}

export interface TopAction {
  label: string;
  path: string;
  sizeBytes: number;
  category: Category;
  note: string;
  noteEn?: string;
  command?: string;
}

export interface Analysis {
  scanDate: string;
  appDataPath: string;
  rawTotalBytes: number;
  adjustedTotalBytes: number;
  greenGainBytes: number;
  yellowGainBytes: number;
  entries: AnalyzedEntry[];
  mirrors: MsixMirror[];
  topActions: TopAction[];
  staleApps: Array<{ root: string; name: string; sizeBytes: number; newest: string; app: string }>;
  /** Sections from the complementary modules (dev caches, system, apps). */
  sections: Section[];
  /** Delta against the previous scan, null on the first scan. */
  evolution: Evolution | null;
}

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;

/**
 * Turns the raw scan into the analysis model: classification of every folder
 * and child, 🟢/🟡 gains without double counting (MSIX mirrors deducted),
 * top actions, AppData folders unused for > 6 months.
 */
export function analyze(
  entries: TopEntry[],
  mirrors: MsixMirror[],
  appDataPath: string,
  sections: Section[] = [],
  evolution: Evolution | null = null,
): Analysis {
  const now = Date.now();
  const mirrorNames = new Set(mirrors.map((m) => m.roamingName.toLowerCase()));

  const analyzed: AnalyzedEntry[] = entries.map((e) => {
    const classification = classifyTop(e.root, e.name, e.path);
    const children = e.children.map((c) => ({
      ...c,
      classification: classifyChild(classification, c.name, c.path),
    }));
    return {
      ...e,
      classification,
      children,
      isMsixMirror: e.root === 'Roaming' && mirrorNames.has(e.name.toLowerCase()),
      isStale: e.newestMtimeMs > 0 && now - e.newestMtimeMs > SIX_MONTHS_MS,
    };
  });

  const rawTotal = analyzed.reduce((s, e) => s + e.sizeBytes, 0);
  const duplicated = mirrors.reduce((s, m) => s + m.duplicatedBytes, 0);

  // Gains: whole folder when its category covers everything, else children sum
  let greenGain = 0;
  let yellowGain = 0;
  const actions: TopAction[] = [];

  for (const e of analyzed) {
    // MSIX mirrors: gains are counted ONCE through the Roaming entry
    // (the Packages side is 🔴 and never enters the gains);
    // the adjusted total already deducted the double count.
    if (e.classification.category === 'green') {
      greenGain += e.sizeBytes;
      actions.push({
        label: `${e.root}\\${e.name}`, path: e.path, sizeBytes: e.sizeBytes,
        category: 'green', note: e.classification.note, noteEn: e.classification.noteEn, command: e.classification.command,
      });
    } else {
      for (const c of e.children) {
        if (c.classification.category === 'green') {
          greenGain += c.sizeBytes;
          if (c.sizeBytes > 10 * 1024 * 1024) {
            actions.push({
              label: `${e.root}\\${e.name}\\${c.name}`, path: c.path, sizeBytes: c.sizeBytes,
              category: 'green', note: c.classification.note, noteEn: c.classification.noteEn, command: c.classification.command,
            });
          }
        } else if (c.classification.category === 'yellow' && c.classification.command) {
          // 🟡 precisely identified as actionable (e.g. vm_bundles)
          yellowGain += c.sizeBytes;
          actions.push({
            label: `${e.root}\\${e.name}\\${c.name}`, path: c.path, sizeBytes: c.sizeBytes,
            category: 'yellow', note: c.classification.note, noteEn: c.classification.noteEn, command: c.classification.command,
          });
        }
      }
      if (e.classification.category === 'yellow' && e.classification.command) {
        // 🟡 actionable at level 1 (e.g. ms-playwright): size minus already-counted children
        const counted = e.children
          .filter((c) => c.classification.category !== e.classification.category || c.classification.command)
          .reduce((s, c) => s + (c.classification.command ? c.sizeBytes : 0), 0);
        const remaining = e.sizeBytes - counted;
        if (remaining > 10 * 1024 * 1024) {
          yellowGain += remaining;
          actions.push({
            label: `${e.root}\\${e.name}`, path: e.path, sizeBytes: remaining,
            category: 'yellow', note: e.classification.note, noteEn: e.classification.noteEn, command: e.classification.command,
          });
        }
      }
    }
  }

  // Complementary modules contribute to gains and top actions.
  // Exception: applications (uninstalling is a heavy decision) stay out of
  // the numbered gains so the summary is not artificially inflated.
  for (const s of sections) {
    for (const f of s.findings) {
      if (s.id !== 'apps') {
        if (f.category === 'green') greenGain += f.sizeBytes;
        else if (f.category === 'yellow' && f.command) yellowGain += f.sizeBytes;
      }
      if (f.command && f.category !== 'red' && f.sizeBytes > 50 * 1024 * 1024) {
        actions.push({ label: f.label, path: f.path, sizeBytes: f.sizeBytes, category: f.category, note: f.note, noteEn: f.noteEn, command: f.command });
      }
    }
  }

  actions.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const staleApps = analyzed
    .filter((e) => e.isStale && !e.isMsixMirror && e.sizeBytes > 1024 * 1024)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((e) => ({
      root: e.root, name: e.name, sizeBytes: e.sizeBytes,
      newest: e.newestMtimeMs ? new Date(e.newestMtimeMs).toISOString().slice(0, 10) : '—',
      app: e.classification.app,
    }));

  return {
    scanDate: new Date().toISOString(),
    appDataPath,
    rawTotalBytes: rawTotal,
    adjustedTotalBytes: rawTotal - duplicated,
    greenGainBytes: greenGain,
    yellowGainBytes: yellowGain,
    entries: analyzed,
    mirrors,
    topActions: actions.slice(0, 10),
    staleApps,
    sections,
    evolution,
  };
}

// ---------- HTML rendering ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generates the SELF-CONTAINED HTML report (inline CSS + JS, embedded JSON
 * data): opens with a double-click, no server, archivable to compare scans.
 * Sorting/filtering and the FR/EN language switch run client-side.
 */
export function renderHtml(a: Analysis): string {
  // Embedded data: the client JS does sorting/filtering, no server required
  const data = JSON.stringify(a).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<link rel="icon" href="/favicon.ico">
<title>AppData Analyzer — ${esc(a.scanDate.slice(0, 10))}</title>
<style>
  :root {
    --bg: #12141a; --panel: #1c1f28; --panel2: #232734; --text: #e6e8ee; --muted: #9aa0b0;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --accent: #58a6ff; --border: #30363d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
         font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; color: var(--accent); }
  .sub { color: var(--muted); margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 18px; min-width: 170px; }
  .card .v { font-size: 22px; font-weight: 600; }
  .card .l { color: var(--muted); font-size: 12px; }
  .card.g .v { color: var(--green); } .card.y .v { color: var(--yellow); }
  .toolbar { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
                    border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .toolbar button.active { border-color: var(--accent); color: var(--accent); }
  .toolbar input { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
                   border-radius: 6px; padding: 6px 10px; width: 220px; }
  #langbar { float: right; display: inline-flex; background: var(--panel2); border: 1px solid var(--border);
             border-radius: 8px; padding: 2px; gap: 2px; }
  #langbar button { background: transparent; color: var(--muted); border: 0; border-radius: 6px;
                    padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
  #langbar button.active { background: var(--accent); color: #0d1117; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: var(--panel2); cursor: pointer; user-select: none; white-space: nowrap; }
  tr.top:hover { background: var(--panel2); }
  tr.top { cursor: pointer; }
  tr.child td { background: #171a22; color: var(--muted); font-size: 13px; }
  tr.child td:first-child { padding-left: 34px; }
  .chip { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .chip.green { background: #1a2f22; color: var(--green); }
  .chip.yellow { background: #332a12; color: var(--yellow); }
  .chip.red { background: #35191c; color: var(--red); }
  .bar { height: 6px; border-radius: 3px; background: var(--accent); min-width: 2px; opacity: .75; }
  .size { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .badge { font-size: 11px; border: 1px solid var(--yellow); color: var(--yellow);
           border-radius: 4px; padding: 0 5px; margin-left: 6px; }
  .badge.mirror { border-color: var(--accent); color: var(--accent); }
  .note { color: var(--muted); font-size: 12px; max-width: 460px; }
  .cmd { display: flex; align-items: center; gap: 6px; }
  .cmd code { background: #0d1117; border: 1px solid var(--border); border-radius: 5px;
              padding: 2px 7px; font-size: 11px; max-width: 340px; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
  .copy { background: var(--panel2); border: 1px solid var(--border); color: var(--muted);
          border-radius: 5px; cursor: pointer; font-size: 11px; padding: 2px 8px; flex: none; }
  .copy:hover { color: var(--text); border-color: var(--accent); }
  .warn { background: #2a1e10; border: 1px solid var(--yellow); border-radius: 8px;
          padding: 10px 14px; margin: 14px 0; font-size: 13px; }
  ol.actions li { margin-bottom: 8px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 28px; }
  footer a { color: var(--muted); } footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div id="langbar"><button data-l="fr" id="lg-fr">FR</button><button data-l="en" id="lg-en">EN</button></div>
<h1>🔍 AppData Analyzer</h1>
<div class="sub" id="subtitle"></div>
<div style="margin:-8px 0 16px"><button class="copy" id="psadmin" style="font-size:13px;padding:6px 14px"></button></div>
<div class="cards" id="cards"></div>
<div id="mirrors"></div>
<div id="evolution"></div>
<h2 id="h-actions"></h2>
<ol class="actions" id="topActions"></ol>
<h2 id="h-folders"></h2>
<div class="toolbar">
  <button data-f="all" class="active" id="fl-all"></button>
  <button data-f="green" id="fl-green"></button>
  <button data-f="yellow" id="fl-yellow"></button>
  <button data-f="red" id="fl-red"></button>
  <button data-f="stale" id="fl-stale"></button>
  <input id="search">
</div>
<table id="tbl">
  <thead><tr>
    <th data-s="name" id="th-name"></th><th data-s="size" id="th-size"></th><th></th>
    <th data-s="app" id="th-app"></th><th id="th-type"></th><th data-s="cat" id="th-cat"></th>
    <th data-s="date" id="th-date"></th><th id="th-action"></th>
  </tr></thead>
  <tbody></tbody>
</table>
<h2 id="h-stale"></h2>
<table id="staleTbl">
  <thead><tr><th id="th-sfolder"></th><th id="th-sapp"></th><th id="th-ssize"></th><th id="th-sdate"></th></tr></thead>
  <tbody></tbody>
</table>
<div id="sections"></div>
<footer id="foot"></footer>

<script>
const DATA = ${data};

// ===== i18n =====
const I18N = {
  fr: {
    subtitle: (p, d) => p + ' — scanné le ' + d,
    psadmin: '🛡 Ouvrir PowerShell en admin',
    psadminFail: "Disponible uniquement quand le rapport est ouvert via le tableau de bord (lance l'outil puis ouvre le rapport depuis la liste).\\n\\nAlternative manuelle : clic droit sur PowerShell → « Exécuter en tant qu'administrateur ».",
    cards: ['Taille totale (ajustée)', 'Gain 🟢 sans risque', 'Gain 🟡 supplémentaire', 'Dossiers analysés'],
    mirrors: (list) => '⚠️ <b>Miroir(s) MSIX détecté(s)</b> — même contenu physique compté deux fois : ' + list + '. Le total ci-dessus est corrigé ; ne supprime ce contenu qu\\'une fois, via un seul des deux chemins.',
    hActions: '🏆 Actions les plus rentables',
    hFolders: '📦 Dossiers analysés',
    filters: { all: 'Tous', green: '🟢 Sans risque', yellow: '🟡 Avec précaution', red: '🔴 Ne pas toucher', stale: '💤 Inutilisés > 6 mois' },
    search: 'Filtrer par nom…',
    th: { name: 'Dossier', size: 'Taille', app: 'Application', type: 'Type', cat: 'Catégorie', date: 'Dernière activité', action: 'Action recommandée' },
    cat: { green: '🟢 Sans risque', yellow: '🟡 Précaution', red: '🔴 Ne pas toucher' },
    stale6: '💤 > 6 mois', mirror: 'miroir MSIX',
    hStale: '💤 Dossiers AppData inutilisés depuis plus de 6 mois',
    thStale: { folder: 'Dossier', app: 'Application', size: 'Taille', date: 'Dernière activité' },
    none: 'Aucune.', nothing: 'Rien de significatif détecté.',
    hEvolution: (d) => '📈 Évolution depuis le scan du ' + d,
    total: 'Total AppData : ', noChange: 'Aucune variation supérieure à 50 Mo.',
    thEvo: { folder: 'Dossier', delta: 'Variation', kind: 'Type' },
    kind: { grown: '📈 a grossi', shrunk: '📉 a diminué', new: '🆕 nouveau', removed: '🗑️ supprimé' },
    copy: 'copier', copied: 'copié ✓',
    footer: 'Rapport généré en <b>lecture seule</b> : aucun fichier n\\'a été modifié ni supprimé. Les commandes affichées sont des suggestions à exécuter soi-même, dossier par dossier.',
    dateLocale: 'fr-FR',
    fmt: (b) => b >= 1024**3 ? (b/1024**3).toFixed(2) + ' Go' : b >= 1024**2 ? (b/1024**2).toFixed(1) + ' Mo' : (b/1024).toFixed(0) + ' Ko',
  },
  en: {
    subtitle: (p, d) => p + ' — scanned on ' + d,
    psadmin: '🛡 Open admin PowerShell',
    psadminFail: 'Only available when the report is opened through the dashboard (launch the tool, then open the report from the list).\\n\\nManual alternative: right-click PowerShell → "Run as administrator".',
    cards: ['Total size (adjusted)', '🟢 No-risk gain', '🟡 Additional gain', 'Folders analyzed'],
    mirrors: (list) => '⚠️ <b>MSIX mirror(s) detected</b> — same physical content counted twice: ' + list + '. The total above is corrected; delete this content only once, through a single path.',
    hActions: '🏆 Most profitable actions',
    hFolders: '📦 Analyzed folders',
    filters: { all: 'All', green: '🟢 No risk', yellow: '🟡 With caution', red: '🔴 Do not touch', stale: '💤 Unused > 6 months' },
    search: 'Filter by name…',
    th: { name: 'Folder', size: 'Size', app: 'Application', type: 'Type', cat: 'Category', date: 'Last activity', action: 'Recommended action' },
    cat: { green: '🟢 No risk', yellow: '🟡 Caution', red: '🔴 Do not touch' },
    stale6: '💤 > 6 months', mirror: 'MSIX mirror',
    hStale: '💤 AppData folders unused for more than 6 months',
    thStale: { folder: 'Folder', app: 'Application', size: 'Size', date: 'Last activity' },
    none: 'None.', nothing: 'Nothing significant detected.',
    hEvolution: (d) => '📈 Change since the scan of ' + d,
    total: 'AppData total: ', noChange: 'No change above 50 MB.',
    thEvo: { folder: 'Folder', delta: 'Change', kind: 'Kind' },
    kind: { grown: '📈 grew', shrunk: '📉 shrank', new: '🆕 new', removed: '🗑️ removed' },
    copy: 'copy', copied: 'copied ✓',
    footer: 'Report generated in <b>read-only</b> mode: no file was modified or deleted. The commands shown are suggestions to run yourself, folder by folder.',
    dateLocale: 'en-US',
    fmt: (b) => b >= 1024**3 ? (b/1024**3).toFixed(2) + ' GB' : b >= 1024**2 ? (b/1024**2).toFixed(1) + ' MB' : (b/1024).toFixed(0) + ' KB',
  },
};
let lang = localStorage.getItem('aa-lang') || ((navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en');
let T = I18N[lang];
const FOOT_LINKS = '<br><a href="https://www.academy.umbra-labs.dev/" target="_blank" rel="noopener">Umbra Labs</a> · <a href="https://x.com/xumbralabs" target="_blank" rel="noopener">@xumbralabs</a>';
const $id = (i) => document.getElementById(i);
const fmt = (b) => T.fmt(b);
const pick = (fr, en) => (lang === 'en' && en ? en : fr);
const escH = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const maxSize = Math.max(...DATA.entries.map(e => e.sizeBytes), 1);

let filter = 'all', search = '', sortKey = 'size', sortDir = -1;
const tbody = document.querySelector('#tbl tbody');
const expanded = new Set();

function applyLang() {
  T = I18N[lang];
  document.documentElement.lang = lang;
  $id('lg-fr').classList.toggle('active', lang === 'fr');
  $id('lg-en').classList.toggle('active', lang === 'en');
  $id('subtitle').textContent = T.subtitle(DATA.appDataPath, new Date(DATA.scanDate).toLocaleString(T.dateLocale));
  $id('psadmin').textContent = T.psadmin;
  $id('h-actions').textContent = T.hActions;
  $id('h-folders').textContent = T.hFolders;
  $id('fl-all').textContent = T.filters.all;
  $id('fl-green').textContent = T.filters.green;
  $id('fl-yellow').textContent = T.filters.yellow;
  $id('fl-red').textContent = T.filters.red;
  $id('fl-stale').textContent = T.filters.stale;
  $id('search').placeholder = T.search;
  $id('th-name').textContent = T.th.name; $id('th-size').textContent = T.th.size;
  $id('th-app').textContent = T.th.app; $id('th-type').textContent = T.th.type;
  $id('th-cat').textContent = T.th.cat; $id('th-date').textContent = T.th.date;
  $id('th-action').textContent = T.th.action;
  $id('h-stale').textContent = T.hStale;
  $id('th-sfolder').textContent = T.thStale.folder; $id('th-sapp').textContent = T.thStale.app;
  $id('th-ssize').textContent = T.thStale.size; $id('th-sdate').textContent = T.thStale.date;
  $id('foot').innerHTML = T.footer + FOOT_LINKS;
  renderCards(); renderMirrors(); renderEvolution(); renderTopActions(); renderStale(); renderSections(); render();
}
$id('lg-fr').addEventListener('click', () => { lang = 'fr'; try { localStorage.setItem('aa-lang', lang); } catch {} applyLang(); });
$id('lg-en').addEventListener('click', () => { lang = 'en'; try { localStorage.setItem('aa-lang', lang); } catch {} applyLang(); });

function renderCards() {
  const cards = [
    [T.cards[0], fmt(DATA.adjustedTotalBytes), ''],
    [T.cards[1], fmt(DATA.greenGainBytes), 'g'],
    [T.cards[2], fmt(DATA.yellowGainBytes), 'y'],
    [T.cards[3], String(DATA.entries.length), ''],
  ];
  $id('cards').innerHTML = cards
    .map(([l, v, c]) => '<div class="card ' + c + '"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>')
    .join('');
}

function renderMirrors() {
  $id('mirrors').innerHTML = DATA.mirrors.length
    ? '<div class="warn">' + T.mirrors(DATA.mirrors.map(m => 'Roaming\\\\' + m.roamingName + ' ⇄ Packages\\\\' + m.packageName + ' (' + fmt(m.duplicatedBytes) + ')').join(' · ')) + '</div>'
    : '';
}

function renderEvolution() {
  if (!DATA.evolution) { $id('evolution').innerHTML = ''; return; }
  const ev = DATA.evolution;
  const sign = (d) => (d >= 0 ? '+' : '−') + fmt(Math.abs(d));
  $id('evolution').innerHTML =
    '<h2>' + T.hEvolution(new Date(ev.previousDate).toLocaleString(T.dateLocale)) + '</h2>'
    + '<div class="warn" style="border-color:var(--accent);background:var(--panel)">' + T.total + '<b>' + sign(ev.totalDeltaBytes) + '</b>'
    + (ev.changes.length
      ? '<table style="margin-top:10px"><thead><tr><th>' + T.thEvo.folder + '</th><th>' + T.thEvo.delta + '</th><th>' + T.thEvo.kind + '</th></tr></thead><tbody>'
        + ev.changes.map(c => '<tr><td>' + escH(c.key) + '</td><td class="size">' + sign(c.deltaBytes) + '</td><td>' + T.kind[c.kind] + '</td></tr>').join('')
        + '</tbody></table>'
      : '<div class="note" style="margin-top:6px">' + T.noChange + '</div>')
    + '</div>';
}

function cmdHtml(command) {
  return command
    ? '<div class="cmd"><code title="' + escH(command) + '">' + escH(command) + '</code><button class="copy" data-cmd="' + escH(command) + '">' + T.copy + '</button></div>'
    : '';
}

function renderTopActions() {
  $id('topActions').innerHTML = DATA.topActions.slice(0, 5).map(t =>
    '<li><b>' + escH(t.label) + '</b> — ' + fmt(t.sizeBytes) + ' <span class="chip ' + t.category + '">' + T.cat[t.category] + '</span>'
    + '<div class="note">' + escH(pick(t.note, t.noteEn)) + '</div>'
    + cmdHtml(t.command)
    + '</li>').join('');
}

function rowMatches(e) {
  if (filter === 'stale' && !e.isStale) return false;
  if (['green','yellow','red'].includes(filter) && e.classification.category !== filter) return false;
  if (search && !(e.root + '\\\\' + e.name).toLowerCase().includes(search)) return false;
  return true;
}

function render() {
  const sorted = [...DATA.entries].sort((a, b) => {
    const v = { size: a.sizeBytes - b.sizeBytes, name: (a.root + a.name).localeCompare(b.root + b.name),
      app: a.classification.app.localeCompare(b.classification.app),
      cat: a.classification.category.localeCompare(b.classification.category),
      date: a.newestMtimeMs - b.newestMtimeMs }[sortKey];
    return v * sortDir;
  });
  let html = '';
  for (const e of sorted) {
    if (!rowMatches(e)) continue;
    const c = e.classification;
    const id = e.root + '|' + e.name;
    const date = e.newestMtimeMs ? new Date(e.newestMtimeMs).toISOString().slice(0, 10) : '—';
    html += '<tr class="top" data-id="' + escH(id) + '"><td>' + (e.children.length ? (expanded.has(id) ? '▾ ' : '▸ ') : '&nbsp;&nbsp; ')
      + '<b>' + escH(e.root + '\\\\' + e.name) + '</b>'
      + (e.isStale ? '<span class="badge">' + T.stale6 + '</span>' : '')
      + (e.isMsixMirror ? '<span class="badge mirror">' + T.mirror + '</span>' : '') + '</td>'
      + '<td class="size">' + fmt(e.sizeBytes) + '</td>'
      + '<td style="width:90px"><div class="bar" style="width:' + Math.max(2, Math.round(88 * e.sizeBytes / maxSize)) + 'px"></div></td>'
      + '<td>' + escH(c.app) + '</td><td>' + escH(pick(c.dataType, c.dataTypeEn)) + '</td>'
      + '<td><span class="chip ' + c.category + '">' + T.cat[c.category] + '</span></td>'
      + '<td class="size">' + date + '</td>'
      + '<td><div class="note">' + escH(pick(c.note, c.noteEn)) + '</div>' + cmdHtml(c.command) + '</td></tr>';
    if (expanded.has(id)) {
      for (const ch of e.children) {
        if (ch.sizeBytes < 1024 * 1024) continue; // children < 1 MB: noise
        const cc = ch.classification;
        const cdate = ch.newestMtimeMs ? new Date(ch.newestMtimeMs).toISOString().slice(0, 10) : '—';
        html += '<tr class="child"><td>' + escH(ch.name) + '</td>'
          + '<td class="size">' + fmt(ch.sizeBytes) + '</td><td></td>'
          + '<td></td><td>' + escH(pick(cc.dataType, cc.dataTypeEn)) + '</td>'
          + '<td><span class="chip ' + cc.category + '">' + T.cat[cc.category] + '</span></td>'
          + '<td class="size">' + cdate + '</td>'
          + '<td><div class="note">' + escH(pick(cc.note, cc.noteEn)) + '</div>' + cmdHtml(cc.command) + '</td></tr>';
      }
    }
  }
  tbody.innerHTML = html;
}

function renderStale() {
  document.querySelector('#staleTbl tbody').innerHTML = DATA.staleApps.map(s =>
    '<tr><td>' + escH(s.root + '\\\\' + s.name) + '</td><td>' + escH(s.app) + '</td>'
    + '<td class="size">' + fmt(s.sizeBytes) + '</td><td class="size">' + s.newest + '</td></tr>').join('')
    || '<tr><td colspan="4">' + T.none + '</td></tr>';
}

function renderSections() {
  $id('sections').innerHTML = (DATA.sections || []).map(sec => {
    const rows = sec.findings.map(f =>
      '<tr><td><b>' + escH(f.label) + '</b></td>'
      + '<td class="size">' + fmt(f.sizeBytes) + '</td>'
      + '<td><span class="chip ' + f.category + '">' + T.cat[f.category] + '</span></td>'
      + '<td class="size">' + (f.lastActivity || '—') + '</td>'
      + '<td><div class="note">' + escH(pick(f.note, f.noteEn)) + '</div>' + cmdHtml(f.command) + '</td></tr>').join('');
    const notes = lang === 'en' && sec.notesEn && sec.notesEn.length ? sec.notesEn : sec.notes;
    return '<h2>' + escH(pick(sec.title, sec.titleEn)) + '</h2>'
      + (notes.length ? '<div class="warn">' + notes.map(escH).join('<br>') + '</div>' : '')
      + (rows
        ? '<table><thead><tr><th>' + T.th.name + '</th><th>' + T.th.size + '</th><th>' + T.th.cat + '</th><th>' + T.th.date + '</th><th>' + T.th.action + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="note">' + T.nothing + '</div>');
  }).join('');
}

// Admin PowerShell: only works when the report is served by the dashboard
// (same origin as the API) — opened from disk, we explain what to do.
$id('psadmin').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/open-powershell', { method: 'POST', headers: { 'x-appdata-analyzer': '1' } });
    if (!r.ok) throw new Error();
  } catch {
    alert(T.psadminFail);
  }
});

// Interactions: filters, search, sort, expand, copy
document.querySelectorAll('.toolbar button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.toolbar button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); filter = b.dataset.f; render();
}));
$id('search').addEventListener('input', (ev) => { search = ev.target.value.toLowerCase(); render(); });
document.querySelectorAll('#tbl th[data-s]').forEach(th => th.addEventListener('click', () => {
  if (sortKey === th.dataset.s) sortDir *= -1; else { sortKey = th.dataset.s; sortDir = -1; }
  render();
}));
document.body.addEventListener('click', (ev) => {
  const copy = ev.target.closest('.copy');
  if (copy && copy.dataset.cmd) {
    navigator.clipboard.writeText(copy.dataset.cmd).then(() => {
      copy.textContent = T.copied; setTimeout(() => (copy.textContent = T.copy), 1500);
    });
    ev.stopPropagation(); return;
  }
  const row = ev.target.closest('tr.top');
  if (row) {
    const id = row.dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  }
});

applyLang();
</script>
</body>
</html>`;
}

/** Writes report.html + report.json into the output folder. */
export async function writeReport(a: Analysis, outDir: string): Promise<{ html: string; json: string }> {
  await mkdir(outDir, { recursive: true });
  // LOCAL timestamp down to the second: multiple scans on the same day
  // coexist instead of overwriting, and the report list stays name-sortable.
  const d = new Date(a.scanDate);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const htmlPath = path.join(outDir, `appdata-report-${stamp}.html`);
  const jsonPath = path.join(outDir, `appdata-report-${stamp}.json`);
  await writeFile(htmlPath, renderHtml(a), 'utf8');
  await writeFile(jsonPath, JSON.stringify(a, null, 2), 'utf8');
  return { html: htmlPath, json: jsonPath };
}
