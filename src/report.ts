/**
 * Construction du modèle d'analyse et génération du rapport.
 *
 * Choix techniques :
 * - Le rapport HTML est un fichier UNIQUE et autonome (CSS + JS inline, données
 *   embarquées en JSON) : il s'ouvre d'un double-clic, sans serveur, et reste
 *   archivable pour comparer deux scans dans le temps.
 * - Les gains 🟢/🟡 sont calculés SANS double compte : un dossier entièrement
 *   🟢 compte en bloc ; pour un dossier mixte, seuls ses enfants 🟢/🟡 comptent.
 * - Les miroirs MSIX détectés sont exclus du total ajusté et signalés.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TopEntry, ChildEntry } from './scanner.ts';
import { classifyTop, classifyChild, type Classification, type Category } from './knowledge.ts';
import type { MsixMirror } from './dedupe.ts';
import type { Section } from './types.ts';
import type { Evolution } from './history.ts';

// ---------- Modèle d'analyse ----------

export interface AnalyzedChild extends ChildEntry {
  classification: Classification;
}

export interface AnalyzedEntry extends Omit<TopEntry, 'children'> {
  classification: Classification;
  children: AnalyzedChild[];
  /** Ce dossier est-il un miroir MSIX (déjà compté sous Packages) ? */
  isMsixMirror: boolean;
  /** Inutilisé depuis plus de 6 mois ? */
  isStale: boolean;
}

export interface TopAction {
  label: string;
  path: string;
  sizeBytes: number;
  category: Category;
  note: string;
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
  /** Sections des modules complémentaires (caches dev, système, applications). */
  sections: Section[];
  /** Delta par rapport au scan précédent, null au premier scan. */
  evolution: Evolution | null;
}

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;

/**
 * Transforme le scan brut en modèle d'analyse : classification de chaque
 * dossier et enfant, gains 🟢/🟡 sans double compte (miroirs MSIX déduits),
 * top actions, applications AppData inutilisées > 6 mois.
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

  // Gains : dossier entier si sa catégorie couvre tout, sinon somme des enfants
  let greenGain = 0;
  let yellowGain = 0;
  const actions: TopAction[] = [];

  for (const e of analyzed) {
    // Miroirs MSIX : les gains sont comptés UNE fois via l'entrée Roaming
    // (le côté Packages est classé 🔴 et n'entre jamais dans les gains) ;
    // le total ajusté a déjà déduit le double comptage.
    if (e.classification.category === 'green') {
      greenGain += e.sizeBytes;
      actions.push({
        label: `${e.root}\\${e.name}`, path: e.path, sizeBytes: e.sizeBytes,
        category: 'green', note: e.classification.note, command: e.classification.command,
      });
    } else {
      for (const c of e.children) {
        if (c.classification.category === 'green') {
          greenGain += c.sizeBytes;
          if (c.sizeBytes > 10 * 1024 * 1024) {
            actions.push({
              label: `${e.root}\\${e.name}\\${c.name}`, path: c.path, sizeBytes: c.sizeBytes,
              category: 'green', note: c.classification.note, command: c.classification.command,
            });
          }
        } else if (c.classification.category === 'yellow' && c.classification.command) {
          // 🟡 actionnable identifié précisément (ex. vm_bundles)
          yellowGain += c.sizeBytes;
          actions.push({
            label: `${e.root}\\${e.name}\\${c.name}`, path: c.path, sizeBytes: c.sizeBytes,
            category: 'yellow', note: c.classification.note, command: c.classification.command,
          });
        }
      }
      if (e.classification.category === 'yellow' && e.classification.command) {
        // 🟡 actionnable au niveau 1 (ex. ms-playwright) : taille moins les enfants déjà comptés
        const counted = e.children
          .filter((c) => c.classification.category !== e.classification.category || c.classification.command)
          .reduce((s, c) => s + (c.classification.command ? c.sizeBytes : 0), 0);
        const remaining = e.sizeBytes - counted;
        if (remaining > 10 * 1024 * 1024) {
          yellowGain += remaining;
          actions.push({
            label: `${e.root}\\${e.name}`, path: e.path, sizeBytes: remaining,
            category: 'yellow', note: e.classification.note, command: e.classification.command,
          });
        }
      }
    }
  }

  // Les modules complémentaires contribuent aux gains et au top actions.
  // Exception : les applications (désinstallation = décision lourde) restent
  // hors des gains chiffrés pour ne pas gonfler artificiellement le résumé.
  for (const s of sections) {
    for (const f of s.findings) {
      if (s.id !== 'apps') {
        if (f.category === 'green') greenGain += f.sizeBytes;
        else if (f.category === 'yellow' && f.command) yellowGain += f.sizeBytes;
      }
      if (f.command && f.category !== 'red' && f.sizeBytes > 50 * 1024 * 1024) {
        actions.push({ label: f.label, path: f.path, sizeBytes: f.sizeBytes, category: f.category, note: f.note, command: f.command });
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

// ---------- Rendu HTML ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Génère le rapport HTML AUTONOME (CSS + JS inline, données JSON embarquées) :
 * il s'ouvre d'un double-clic sans serveur et reste archivable pour comparer
 * deux scans dans le temps. Le tri/filtre est fait côté client.
 */
export function renderHtml(a: Analysis): string {
  // Données embarquées : le JS client fait le tri/filtre, aucun serveur requis
  const data = JSON.stringify(a).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>AppData Analyzer — rapport du ${esc(a.scanDate.slice(0, 10))}</title>
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
</style>
</head>
<body>
<h1>🔍 AppData Analyzer</h1>
<div class="sub" id="subtitle"></div>
<div style="margin:-8px 0 16px"><button class="copy" id="psadmin" style="font-size:13px;padding:6px 14px"
  title="Ouvre une console PowerShell élevée (invite UAC) pour coller les commandes de suppression">🛡 Ouvrir PowerShell en admin</button></div>
<div class="cards" id="cards"></div>
<div id="mirrors"></div>
<div id="evolution"></div>
<h2>🏆 Actions les plus rentables</h2>
<ol class="actions" id="topActions"></ol>
<h2>📦 Dossiers analysés</h2>
<div class="toolbar">
  <button data-f="all" class="active">Tous</button>
  <button data-f="green">🟢 Sans risque</button>
  <button data-f="yellow">🟡 Avec précaution</button>
  <button data-f="red">🔴 Ne pas toucher</button>
  <button data-f="stale">💤 Inutilisés &gt; 6 mois</button>
  <input id="search" placeholder="Filtrer par nom…">
</div>
<table id="tbl">
  <thead><tr>
    <th data-s="name">Dossier</th><th data-s="size">Taille</th><th></th>
    <th data-s="app">Application</th><th>Type</th><th data-s="cat">Catégorie</th>
    <th data-s="date">Dernière activité</th><th>Action recommandée</th>
  </tr></thead>
  <tbody></tbody>
</table>
<h2>💤 Dossiers AppData inutilisés depuis plus de 6 mois</h2>
<table id="staleTbl">
  <thead><tr><th>Dossier</th><th>Application</th><th>Taille</th><th>Dernière activité</th></tr></thead>
  <tbody></tbody>
</table>
<div id="sections"></div>
<footer>Rapport généré en <b>lecture seule</b> : aucun fichier n'a été modifié ni supprimé.
Les commandes affichées sont des suggestions à exécuter soi-même, dossier par dossier.</footer>

<script>
const DATA = ${data};
const fmt = (b) => {
  if (b >= 1024**3) return (b / 1024**3).toFixed(2) + ' Go';
  if (b >= 1024**2) return (b / 1024**2).toFixed(1) + ' Mo';
  return (b / 1024).toFixed(0) + ' Ko';
};
const CAT = { green: '🟢 Sans risque', yellow: '🟡 Précaution', red: '🔴 Ne pas toucher' };
const maxSize = Math.max(...DATA.entries.map(e => e.sizeBytes), 1);

document.getElementById('subtitle').textContent =
  DATA.appDataPath + ' — scanné le ' + new Date(DATA.scanDate).toLocaleString('fr-FR');

// Cartes de synthèse
const cards = [
  ['Taille totale (ajustée)', fmt(DATA.adjustedTotalBytes), ''],
  ['Gain 🟢 sans risque', fmt(DATA.greenGainBytes), 'g'],
  ['Gain 🟡 supplémentaire', fmt(DATA.yellowGainBytes), 'y'],
  ['Dossiers analysés', String(DATA.entries.length), ''],
];
document.getElementById('cards').innerHTML = cards
  .map(([l, v, c]) => '<div class="card ' + c + '"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>')
  .join('');

// Miroirs MSIX
if (DATA.mirrors.length) {
  document.getElementById('mirrors').innerHTML = '<div class="warn">⚠️ <b>Miroir(s) MSIX détecté(s)</b> — même contenu physique compté deux fois : '
    + DATA.mirrors.map(m => 'Roaming\\\\' + m.roamingName + ' ⇄ Packages\\\\' + m.packageName + ' (' + fmt(m.duplicatedBytes) + ')').join(' · ')
    + '. Le total ci-dessus est corrigé ; ne supprime ce contenu qu\\'une fois, via un seul des deux chemins.</div>';
}

// Top actions
// Échappe aussi les guillemets : les commandes en contiennent et sont insérées
// dans des attributs HTML (data-cmd, title) délimités par des guillemets doubles
const escH = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
document.getElementById('topActions').innerHTML = DATA.topActions.slice(0, 5).map(t =>
  '<li><b>' + escH(t.label) + '</b> — ' + fmt(t.sizeBytes) + ' <span class="chip ' + t.category + '">' + CAT[t.category] + '</span>'
  + '<div class="note">' + escH(t.note) + '</div>'
  + (t.command ? '<div class="cmd"><code title="' + escH(t.command) + '">' + escH(t.command) + '</code><button class="copy" data-cmd="' + escH(t.command) + '">copier</button></div>' : '')
  + '</li>').join('');

// Tableau principal
let filter = 'all', search = '', sortKey = 'size', sortDir = -1;
const tbody = document.querySelector('#tbl tbody');
const expanded = new Set();

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
      + (e.isStale ? '<span class="badge">💤 &gt; 6 mois</span>' : '')
      + (e.isMsixMirror ? '<span class="badge mirror">miroir MSIX</span>' : '') + '</td>'
      + '<td class="size">' + fmt(e.sizeBytes) + '</td>'
      + '<td style="width:90px"><div class="bar" style="width:' + Math.max(2, Math.round(88 * e.sizeBytes / maxSize)) + 'px"></div></td>'
      + '<td>' + escH(c.app) + '</td><td>' + escH(c.dataType) + '</td>'
      + '<td><span class="chip ' + c.category + '">' + CAT[c.category] + '</span></td>'
      + '<td class="size">' + date + '</td>'
      + '<td><div class="note">' + escH(c.note) + '</div>'
      + (c.command ? '<div class="cmd"><code title="' + escH(c.command) + '">' + escH(c.command) + '</code><button class="copy" data-cmd="' + escH(c.command) + '">copier</button></div>' : '')
      + '</td></tr>';
    if (expanded.has(id)) {
      for (const ch of e.children) {
        if (ch.sizeBytes < 1024 * 1024) continue; // enfants < 1 Mo : bruit
        const cc = ch.classification;
        const cdate = ch.newestMtimeMs ? new Date(ch.newestMtimeMs).toISOString().slice(0, 10) : '—';
        html += '<tr class="child"><td>' + escH(ch.name) + '</td>'
          + '<td class="size">' + fmt(ch.sizeBytes) + '</td><td></td>'
          + '<td></td><td>' + escH(cc.dataType) + '</td>'
          + '<td><span class="chip ' + cc.category + '">' + CAT[cc.category] + '</span></td>'
          + '<td class="size">' + cdate + '</td>'
          + '<td><div class="note">' + escH(cc.note) + '</div>'
          + (cc.command ? '<div class="cmd"><code title="' + escH(cc.command) + '">' + escH(cc.command) + '</code><button class="copy" data-cmd="' + escH(cc.command) + '">copier</button></div>' : '')
          + '</td></tr>';
      }
    }
  }
  tbody.innerHTML = html;
}

// PowerShell admin : ne fonctionne que si le rapport est servi par le tableau
// de bord (même origine que l'API) — ouvert depuis le disque, on explique quoi faire.
document.getElementById('psadmin').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/open-powershell', { method: 'POST', headers: { 'x-appdata-analyzer': '1' } });
    if (!r.ok) throw new Error();
  } catch {
    alert("Disponible uniquement quand le rapport est ouvert via le tableau de bord (lance l'outil puis ouvre le rapport depuis la liste).\\n\\nAlternative manuelle : clic droit sur PowerShell → « Exécuter en tant qu'administrateur ».");
  }
});

// Interactions : filtres, recherche, tri, expansion, copie
document.querySelectorAll('.toolbar button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.toolbar button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); filter = b.dataset.f; render();
}));
document.getElementById('search').addEventListener('input', (ev) => { search = ev.target.value.toLowerCase(); render(); });
document.querySelectorAll('#tbl th[data-s]').forEach(th => th.addEventListener('click', () => {
  if (sortKey === th.dataset.s) sortDir *= -1; else { sortKey = th.dataset.s; sortDir = -1; }
  render();
}));
document.body.addEventListener('click', (ev) => {
  const copy = ev.target.closest('.copy');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.cmd).then(() => {
      copy.textContent = 'copié ✓'; setTimeout(() => (copy.textContent = 'copier'), 1500);
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

// Applis inutilisées
document.querySelector('#staleTbl tbody').innerHTML = DATA.staleApps.map(s =>
  '<tr><td>' + escH(s.root + '\\\\' + s.name) + '</td><td>' + escH(s.app) + '</td>'
  + '<td class="size">' + fmt(s.sizeBytes) + '</td><td class="size">' + s.newest + '</td></tr>').join('')
  || '<tr><td colspan="4">Aucune.</td></tr>';

// Évolution depuis le scan précédent (module 5)
if (DATA.evolution) {
  const ev = DATA.evolution;
  const sign = (d) => (d >= 0 ? '+' : '−') + fmt(Math.abs(d));
  const KIND = { grown: '📈 a grossi', shrunk: '📉 a diminué', new: '🆕 nouveau', removed: '🗑️ supprimé' };
  document.getElementById('evolution').innerHTML =
    '<h2>📈 Évolution depuis le scan du ' + new Date(ev.previousDate).toLocaleString('fr-FR') + '</h2>'
    + '<div class="warn" style="border-color:var(--accent);background:var(--panel)">Total AppData : <b>' + sign(ev.totalDeltaBytes) + '</b>'
    + (ev.changes.length
      ? '<table style="margin-top:10px"><thead><tr><th>Dossier</th><th>Variation</th><th>Type</th></tr></thead><tbody>'
        + ev.changes.map(c => '<tr><td>' + escH(c.key) + '</td><td class="size">' + sign(c.deltaBytes) + '</td><td>' + KIND[c.kind] + '</td></tr>').join('')
        + '</tbody></table>'
      : '<div class="note" style="margin-top:6px">Aucune variation supérieure à 50 Mo.</div>')
    + '</div>';
}

// Sections des modules complémentaires (caches dev, système, applications)
document.getElementById('sections').innerHTML = (DATA.sections || []).map(sec => {
  const rows = sec.findings.map(f =>
    '<tr><td><b>' + escH(f.label) + '</b></td>'
    + '<td class="size">' + fmt(f.sizeBytes) + '</td>'
    + '<td><span class="chip ' + f.category + '">' + CAT[f.category] + '</span></td>'
    + '<td class="size">' + (f.lastActivity || '—') + '</td>'
    + '<td><div class="note">' + escH(f.note) + '</div>'
    + (f.command ? '<div class="cmd"><code title="' + escH(f.command) + '">' + escH(f.command) + '</code><button class="copy" data-cmd="' + escH(f.command) + '">copier</button></div>' : '')
    + '</td></tr>').join('');
  return '<h2>' + escH(sec.title) + '</h2>'
    + (sec.notes.length ? '<div class="warn">' + sec.notes.map(escH).join('<br>') + '</div>' : '')
    + (rows
      ? '<table><thead><tr><th>Élément</th><th>Taille</th><th>Catégorie</th><th>Dernière activité</th><th>Recommandation</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="note">Rien de significatif détecté.</div>');
}).join('');

render();
</script>
</body>
</html>`;
}

/** Écrit report.html + report.json dans le dossier de sortie. */
export async function writeReport(a: Analysis, outDir: string): Promise<{ html: string; json: string }> {
  await mkdir(outDir, { recursive: true });
  // Horodatage LOCAL à la seconde : plusieurs scans le même jour coexistent
  // au lieu de s'écraser, et la liste des rapports reste triable par nom.
  const d = new Date(a.scanDate);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const htmlPath = path.join(outDir, `appdata-report-${stamp}.html`);
  const jsonPath = path.join(outDir, `appdata-report-${stamp}.json`);
  await writeFile(htmlPath, renderHtml(a), 'utf8');
  await writeFile(jsonPath, JSON.stringify(a, null, 2), 'utf8');
  return { html: htmlPath, json: jsonPath };
}
