/**
 * Serveur web local : tableau de bord de scan et de nettoyage assisté.
 *
 * Choix techniques :
 * - `node:http` pur, zéro dépendance : compatible avec l'exécutable SEA.
 * - Progression en temps réel via SSE ; à la connexion le client reçoit un
 *   snapshot complet (recharger la page en plein scan ne perd rien).
 * - DEUX interfaces dans la même page : « simple » (grand public, par défaut)
 *   et « expert » (l'interface technique historique), commutables.
 * - Le nettoyage passe par la CORBEILLE (voir cleaner.ts) et ne peut viser
 *   QUE des éléments issus du dernier scan (validation par id côté serveur :
 *   un client ne peut jamais faire supprimer un chemin arbitraire).
 * - Endpoints « ouvrir X » (PowerShell admin, Corbeille, Paramètres Windows) :
 *   protégés par un header custom → requête preflight CORS qu'un site web
 *   tiers ne peut pas franchir.
 * - `--auto-exit` : le serveur s'arrête seul après 5 min sans onglet ouvert
 *   (lancé en fenêtre d'application, il ne doit pas survivre indéfiniment).
 */
import http from 'node:http';
import { readdir, readFile, stat, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { runFullScan, type PipelineOptions, type ScanSummary } from './pipeline.ts';
import { cleanToRecycleBin, type CleanTarget, type CleanResult } from './cleaner.ts';

interface CleanState {
  status: 'idle' | 'running' | 'done';
  results: CleanResult[];
  freedBytes: number;
  error?: string;
}

interface ScanState {
  status: 'idle' | 'running' | 'done' | 'error';
  lines: Array<{ type: string; text: string }>;
  summary: ScanSummary | null;
  error: string | null;
  startedAt: string | null;
  clean: CleanState;
}

export interface ServerOptions extends PipelineOptions {
  autoExit?: boolean;
}

const JOURNAL_FILE = 'cleanup-log.jsonl';

/** Démarre le serveur ; la promesse est rejetée si le port est pris (EADDRINUSE). */
export function startServer(baseOpts: ServerOptions, port: number): Promise<void> {
  const state: ScanState = {
    status: 'idle', lines: [], summary: null, error: null, startedAt: null,
    clean: { status: 'idle', results: [], freedBytes: 0 },
  };
  const sseClients = new Set<http.ServerResponse>();
  let lastClientSeen = Date.now();

  const broadcast = (ev: object): void => {
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  const pushLine = (type: string, text: string): void => {
    state.lines.push({ type, text });
    broadcast({ kind: 'line', line: { type, text } });
  };

  // --- Scan ---
  const startScan = (extraSkip: string[]): boolean => {
    if (state.status === 'running' || state.clean.status === 'running') return false;
    state.status = 'running';
    state.lines = [];
    state.summary = null;
    state.error = null;
    state.startedAt = new Date().toISOString();
    state.clean = { status: 'idle', results: [], freedBytes: 0 };
    broadcast({ kind: 'status', status: 'running' });

    const opts: PipelineOptions = { ...baseOpts, skip: new Set([...baseOpts.skip, ...extraSkip]) };
    runFullScan(opts, (ev) => pushLine(ev.type, ev.text))
      .then((summary) => {
        state.status = 'done';
        state.summary = summary;
        broadcast({ kind: 'status', status: 'done', summary });
      })
      .catch((err) => {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
        broadcast({ kind: 'status', status: 'error', error: state.error });
      });
    return true;
  };

  // --- Nettoyage (corbeille) ---
  const startClean = (ids: number[]): { ok: boolean; reason?: string } => {
    if (state.clean.status === 'running' || state.status === 'running') return { ok: false, reason: 'occupé' };
    const actionables = state.summary?.actionables ?? [];
    // Validation stricte : uniquement des ids du dernier scan, nettoyables
    const targets: CleanTarget[] = [];
    for (const id of ids) {
      const a = actionables.find((x) => x.id === id);
      if (a && a.deleteMode && a.deletePath) {
        targets.push({ id: a.id, path: a.deletePath, mode: a.deleteMode, sizeBytes: a.sizeBytes, label: a.friendlyLabel });
      }
    }
    if (targets.length === 0) return { ok: false, reason: 'aucun élément nettoyable valide' };

    state.clean = { status: 'running', results: [], freedBytes: 0 };
    broadcast({ kind: 'clean-status', status: 'running', total: targets.length });

    cleanToRecycleBin(targets, (r) => {
      state.clean.results.push(r);
      state.clean.freedBytes += r.freedBytes;
      broadcast({ kind: 'clean-line', result: r, done: state.clean.results.length, total: targets.length });
    })
      .then(async (results) => {
        state.clean.status = 'done';
        broadcast({ kind: 'clean-status', status: 'done', freedBytes: state.clean.freedBytes, results });
        // Journal append-only des nettoyages
        const entry = {
          date: new Date().toISOString(),
          freedBytes: state.clean.freedBytes,
          items: results.map((r) => ({ label: r.label, path: r.path, ok: r.ok, sizeBytes: r.freedBytes })),
        };
        try {
          await appendFile(path.join(baseOpts.outDir, JOURNAL_FILE), JSON.stringify(entry) + '\n', 'utf8');
        } catch { /* journal non bloquant */ }
      })
      .catch((err) => {
        state.clean.status = 'done';
        state.clean.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error('Erreur de nettoyage :', state.clean.error);
        broadcast({ kind: 'clean-status', status: 'done', freedBytes: state.clean.freedBytes, error: state.clean.error });
      });
    return { ok: true };
  };

  const listReports = async (): Promise<Array<{ file: string; sizeBytes: number; mtime: string }>> => {
    let names: string[];
    try {
      names = await readdir(baseOpts.outDir);
    } catch {
      return [];
    }
    const reports: Array<{ file: string; sizeBytes: number; mtime: string }> = [];
    for (const n of names) {
      if (!/^appdata-report-.*\.html$/.test(n)) continue;
      try {
        const st = await stat(path.join(baseOpts.outDir, n));
        reports.push({ file: n, sizeBytes: st.size, mtime: st.mtime.toISOString() });
      } catch { /* ignoré */ }
    }
    reports.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return reports;
  };

  const readJournal = async (): Promise<object[]> => {
    try {
      const raw = await readFile(path.join(baseOpts.outDir, JOURNAL_FILE), 'utf8');
      return raw.trim().split('\n').filter(Boolean).slice(-10).reverse().map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  /** Lance un utilitaire Windows (protégé par header anti-CSRF en amont). */
  const startProgram = (cmd: string): void => {
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true });
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, obj: object): void => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    // Header custom exigé sur toute action : force un preflight CORS
    const guarded = (): boolean => {
      if (req.headers['x-appdata-analyzer'] === '1') return true;
      json(403, { ok: false });
      return false;
    };

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'snapshot', state })}\n\n`);
      sseClients.add(res);
      lastClientSeen = Date.now();
      req.on('close', () => {
        sseClients.delete(res);
        lastClientSeen = Date.now();
      });
      return;
    }
    if (url.pathname === '/api/state') return json(200, state);
    if (url.pathname === '/api/reports') return json(200, await listReports());
    if (url.pathname === '/api/journal') return json(200, await readJournal());

    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      let extraSkip: string[] = [];
      try {
        const parsed = JSON.parse(body || '{}');
        if (Array.isArray(parsed.skip)) extraSkip = parsed.skip.filter((s: unknown) => typeof s === 'string');
      } catch { /* corps invalide : défauts */ }
      const ok = startScan(extraSkip);
      return json(ok ? 202 : 409, { started: ok });
    }

    if (url.pathname === '/api/clean' && req.method === 'POST') {
      if (!guarded()) return;
      const body = await readBody(req);
      let ids: number[] = [];
      try {
        const parsed = JSON.parse(body || '{}');
        if (Array.isArray(parsed.ids)) ids = parsed.ids.filter((n: unknown) => Number.isInteger(n));
      } catch { /* ignoré */ }
      const r = startClean(ids);
      return json(r.ok ? 202 : 409, r);
    }

    if (url.pathname === '/api/open-powershell' && req.method === 'POST') {
      if (!guarded()) return;
      startProgram("Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command','Set-Location $env:USERPROFILE'");
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/open-recycle-bin' && req.method === 'POST') {
      if (!guarded()) return;
      startProgram("Start-Process 'shell:RecycleBinFolder'");
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/open-apps-settings' && req.method === 'POST') {
      if (!guarded()) return;
      startProgram("Start-Process 'ms-settings:appsfeatures'");
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/relaunch-admin' && req.method === 'POST') {
      if (!guarded()) return;
      // Relance élevée de la même instance : l'UAC s'affiche, l'ancienne
      // instance s'éteint pour libérer le port avant que l'élevée ne démarre.
      // --auto-exit indispensable : sans lui, l'instance élevée ne meurt
      // jamais et squatte le port pour tous les lancements suivants.
      const isSea = !process.execPath.toLowerCase().endsWith('node.exe');
      const target = process.execPath;
      const argList = isSea
        ? `'--serve','--port','${port}','--open','--auto-exit'`
        : `'${process.argv[1].replace(/'/g, "''")}','--serve','--port','${port}','--open','--auto-exit'`;
      startProgram(`Start-Process '${target.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs`);
      json(200, { ok: true });
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 800);
      return;
    }
    if (url.pathname === '/api/diagnostic') {
      // Dernier rapport JSON, servi en téléchargement (support / diagnostic)
      const reports = await listReports();
      const latest = reports[0]?.file.replace(/\.html$/, '.json');
      if (!latest) return json(404, { ok: false });
      try {
        const content = await readFile(path.join(baseOpts.outDir, latest));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="diagnostic-${latest}"`,
        });
        res.end(content);
      } catch {
        json(404, { ok: false });
      }
      return;
    }

    if (url.pathname.startsWith('/reports/')) {
      const name = decodeURIComponent(url.pathname.slice('/reports/'.length));
      if (!/^appdata-report-[\w.:-]+\.(html|json)$/.test(name)) {
        res.writeHead(404);
        res.end('Introuvable');
        return;
      }
      try {
        const content = await readFile(path.join(baseOpts.outDir, name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Introuvable');
      }
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml(baseOpts));
      return;
    }

    res.writeHead(404);
    res.end('Introuvable');
  });

  // Arrêt automatique : fenêtre fermée depuis > 5 min et rien en cours
  if (baseOpts.autoExit) {
    setInterval(() => {
      const idle = sseClients.size === 0 && state.status !== 'running' && state.clean.status !== 'running';
      if (idle && Date.now() - lastClientSeen > 5 * 60_000) process.exit(0);
    }, 30_000).unref();
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`Tableau de bord : http://localhost:${port}`);
      console.log('(Ctrl+C pour arreter — le serveur n\'ecoute que sur 127.0.0.1)');
      resolve();
    });
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dashboardHtml(opts: ServerOptions): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nettoyeur d'espace disque</title>
<style>
  :root {
    --bg: #12141a; --panel: #1c1f28; --panel2: #232734; --text: #e6e8ee; --muted: #9aa0b0;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --accent: #58a6ff; --border: #30363d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
         font: 15px/1.55 "Segoe UI", system-ui, sans-serif; max-width: 860px; margin-inline: auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 10px; color: var(--accent); }
  .sub { color: var(--muted); margin-bottom: 18px; font-size: 13px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  button.big { background: var(--accent); color: #0d1117; border: 0; border-radius: 10px;
               padding: 14px 30px; font-size: 17px; font-weight: 600; cursor: pointer; }
  button.big.green { background: var(--green); }
  button.big:disabled { background: var(--panel2); color: var(--muted); cursor: wait; }
  button.sec { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
               border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
  button.sec:hover { border-color: var(--accent); }
  .muted { color: var(--muted); font-size: 13px; }
  .bigsize { font-size: 30px; font-weight: 700; color: var(--green); }
  .bar-outer { height: 10px; background: var(--panel2); border-radius: 5px; overflow: hidden; margin: 14px 0 8px; }
  .bar-inner { height: 100%; width: 30%; background: var(--accent); border-radius: 5px; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
  .item { display: flex; align-items: flex-start; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--border); }
  .item:last-child { border-bottom: 0; }
  .item input { width: 18px; height: 18px; margin-top: 3px; accent-color: var(--green); }
  .item .t { flex: 1; }
  .item .n { color: var(--muted); font-size: 12.5px; }
  .item .s { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chip { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .chip.green { background: #1a2f22; color: var(--green); }
  .chip.yellow { background: #332a12; color: var(--yellow); }
  .ok { color: var(--green); } .ko { color: var(--red); }
  #log { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px;
         height: 260px; overflow-y: auto; font: 12px/1.6 Consolas, monospace; white-space: pre-wrap; margin-top: 12px; }
  #log .phase { color: var(--accent); font-weight: 600; }
  #log .warn { color: var(--yellow); }
  #log .item2 { color: var(--muted); }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  .size { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cmd code { background: #0d1117; border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px;
              font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              display: inline-block; vertical-align: middle; }
  .copy { background: var(--panel2); border: 1px solid var(--border); color: var(--muted); border-radius: 5px;
          cursor: pointer; font-size: 11px; padding: 2px 8px; }
  .hint { background: #1c2536; border: 1px solid var(--accent); border-radius: 8px; padding: 10px 14px; font-size: 13.5px; margin: 12px 0; }
  .warnbox { background: #2a1e10; border: 1px solid var(--yellow); border-radius: 8px; padding: 10px 14px; font-size: 13.5px; margin: 12px 0; }
  #topbar { display: flex; justify-content: flex-end; margin-bottom: 6px; }
  .seg { display: inline-flex; background: var(--panel2); border: 1px solid var(--border);
         border-radius: 9px; padding: 3px; gap: 3px; }
  .seg button { background: transparent; color: var(--muted); border: 0; border-radius: 7px;
                padding: 6px 16px; font-size: 13.5px; font-weight: 600; cursor: pointer; }
  .seg button.active { background: var(--accent); color: #0d1117; }
  .seg button:not(.active):hover { color: var(--text); }
  #overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center;
             justify-content: center; z-index: 10; }
  #overlay .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
                   padding: 30px; max-width: 440px; text-align: center; }
  #overlay .card .em { font-size: 40px; margin-bottom: 10px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 26px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  footer a { cursor: pointer; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<!-- ===== Premier lancement : 3 écrans d'explication ===== -->
<div id="overlay" hidden>
  <div class="card">
    <div class="em" id="ob-emoji">🧹</div>
    <h2 style="margin-top:0" id="ob-title"></h2>
    <p class="muted" id="ob-text" style="font-size:14.5px"></p>
    <button class="big" id="ob-next" style="margin-top:8px">Continuer</button>
  </div>
</div>

<!-- ===== Sélecteur de mode, visible dans les deux interfaces ===== -->
<div id="topbar">
  <div class="seg" role="tablist" aria-label="Mode d'affichage">
    <button data-m="simple" id="seg-simple">Simple</button>
    <button data-m="expert" id="seg-expert" title="Détail technique : rapports complets, commandes, éléments avancés">🛠 Expert</button>
  </div>
</div>

<!-- ===== MODE SIMPLE ===== -->
<div id="simple">
  <h1>🧹 Nettoyeur d'espace disque</h1>
  <div class="sub">Libérez de la place en toute sécurité — tout ce qui est nettoyé va dans la Corbeille.</div>

  <div class="panel" id="s-idle">
    <p>Cliquez pour analyser votre ordinateur. <b>Rien n'est supprimé</b> pendant l'analyse : vous choisirez ensuite.</p>
    <button class="big" id="s-scan">🔍 Analyser mon ordinateur</button>
    <p class="muted" id="s-last"></p>
  </div>

  <div class="panel" id="s-progress" hidden>
    <b id="s-phase">Analyse en cours…</b>
    <div class="bar-outer"><div class="bar-inner"></div></div>
    <span class="muted">Cela prend généralement une à trois minutes. Vos fichiers ne sont pas modifiés.</span>
  </div>

  <div id="s-results" hidden>
    <div class="panel">
      <div class="muted">Espace récupérable sans risque</div>
      <div class="bigsize" id="s-total">—</div>
      <div class="muted" id="s-photos"></div>
      <div id="s-items" style="margin-top:12px"></div>
      <div id="s-adminhint"></div>
      <button class="big green" id="s-clean" style="margin-top:16px">🧹 Nettoyer (envoyer à la Corbeille)</button>
      <div class="muted" style="margin-top:8px">Récupérable depuis la Corbeille pendant environ 30 jours.</div>
    </div>
    <div class="panel" id="s-apps" hidden>
      <h2 style="margin-top:0">💡 Pour aller plus loin</h2>
      <p class="muted">Ces programmes semblent inutilisés depuis longtemps. Si vous ne les reconnaissez pas ou ne vous en servez plus, vous pouvez les désinstaller :</p>
      <div id="s-apps-list"></div>
      <button class="sec" id="s-openapps" style="margin-top:10px">Ouvrir « Applications installées » de Windows</button>
    </div>
  </div>

  <div class="panel" id="s-cleaning" hidden>
    <b id="s-cleanphase">Nettoyage en cours…</b>
    <div class="bar-outer"><div class="bar-inner"></div></div>
    <div id="s-cleanlog" class="muted"></div>
  </div>

  <div class="panel" id="s-done" hidden>
    <div style="font-size:34px">✅</div>
    <div class="bigsize" id="s-freed">—</div>
    <p>récupérés ! Les fichiers sont dans la <b>Corbeille</b> : vous pouvez encore les restaurer en cas de doute.</p>
    <p class="muted">Ces fichiers se recréeront avec l'usage — c'est normal. Repassez dans quelques mois.</p>
    <div class="row" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="sec" id="s-openbin">Ouvrir la Corbeille</button>
      <button class="sec" id="s-again">Refaire une analyse</button>
    </div>
    <div id="s-errors" class="warnbox" hidden></div>
  </div>
</div>

<!-- ===== MODE EXPERT ===== -->
<div id="expert" hidden>
  <h1>🔍 AppData Analyzer <span class="chip yellow">expert</span></h1>
  <div class="sub">Cible : ${esc(opts.appDataPath)} · Workspaces : ${esc(opts.workspacesPath)} · analyse en lecture seule, nettoyage via Corbeille uniquement.</div>

  <div class="panel">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="big" id="e-scan" style="padding:10px 22px;font-size:15px">▶ Lancer le scan</button>
      <label class="muted"><input type="checkbox" id="mod-dev" checked> Caches dev</label>
      <label class="muted"><input type="checkbox" id="mod-system" checked> Système</label>
      <label class="muted"><input type="checkbox" id="mod-apps" checked> Applications</label>
      <button class="sec" id="e-psadmin" title="Console PowerShell élevée (UAC)">🛡 PowerShell admin</button>
      <button class="sec" id="e-adminrelaunch" title="Relance l'outil avec les droits admin (UAC)">⬆ Relancer en admin</button>
      <span id="e-status" class="muted">Prêt.</span>
    </div>
    <div id="log" hidden></div>
  </div>

  <div class="panel" id="e-actions" hidden>
    <h2 style="margin-top:0">🧹 Nettoyage assisté (Corbeille)</h2>
    <table><thead><tr><th></th><th>Élément</th><th>Taille</th><th>Catégorie</th><th>Détail / commande</th></tr></thead>
    <tbody id="e-list"></tbody></table>
    <button class="big green" id="e-clean" style="margin-top:12px;padding:10px 22px;font-size:15px">🧹 Nettoyer la sélection</button>
    <span class="muted" id="e-selinfo" style="margin-left:12px"></span>
  </div>

  <h2>📚 Rapports</h2>
  <div class="panel">
    <table><thead><tr><th>Rapport</th><th>Généré le</th><th>Taille</th><th>Données</th></tr></thead>
    <tbody id="e-reports"><tr><td colspan="4" class="muted">Chargement…</td></tr></tbody></table>
  </div>

  <h2>🗒 Journal des nettoyages</h2>
  <div class="panel"><div id="e-journal" class="muted">Aucun nettoyage pour l'instant.</div></div>
</div>

<footer>
  <span>Analyse en lecture seule · nettoyage via la Corbeille uniquement · serveur local 127.0.0.1</span>
  <span><a id="diag" href="/api/diagnostic">Exporter un diagnostic</a></span>
</footer>

<script>
const fmt = (b) => b >= 1024**3 ? (b/1024**3).toFixed(2).replace('.', ',') + ' Go'
             : b >= 1024**2 ? (b/1024**2).toFixed(0) + ' Mo' : (b/1024).toFixed(0) + ' Ko';
const $ = (id) => document.getElementById(id);
const api = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-appdata-analyzer': '1' }, body: body ? JSON.stringify(body) : undefined });

// ===== Mode simple / expert (sélecteur segmenté) =====
let mode = localStorage.getItem('aa-mode') || 'simple';
function applyMode() {
  $('simple').hidden = mode !== 'simple';
  $('expert').hidden = mode !== 'expert';
  $('seg-simple').classList.toggle('active', mode === 'simple');
  $('seg-expert').classList.toggle('active', mode === 'expert');
}
function setMode(m) {
  // Garde-fou novice : avertissement au PREMIER passage en expert, mémorisé ensuite
  if (m === 'expert' && !localStorage.getItem('aa-expert-ok')) {
    if (!confirm("Le mode expert affiche des options avancées : éléments à supprimer avec précaution, commandes système, rapports techniques.\\n\\nSi vous n'êtes pas sûr, restez en mode Simple. Continuer ?")) return;
    localStorage.setItem('aa-expert-ok', '1');
  }
  mode = m;
  localStorage.setItem('aa-mode', mode);
  applyMode();
}
$('seg-simple').addEventListener('click', () => setMode('simple'));
$('seg-expert').addEventListener('click', () => setMode('expert'));
applyMode();

// ===== Onboarding (premier lancement) =====
const OB = [
  ['🧹', 'Bienvenue !', "Cet outil analyse votre ordinateur et trouve les fichiers inutiles qui prennent de la place, comme les fichiers temporaires et les restes de programmes désinstallés."],
  ['🔒', 'Vos données sont protégées', "Il ne touche jamais à vos documents, photos, mots de passe ou réglages. Seuls des fichiers sans danger, que Windows ou vos applications recréent tout seuls, sont proposés."],
  ['♻️', 'Toujours réversible', "Tout ce qui est nettoyé part dans la Corbeille. En cas de doute, vous pouvez tout restaurer pendant environ 30 jours."],
  ['🛠', 'Pour les connaisseurs', "Un mode Expert (bouton en haut à droite) donne accès au détail technique : rapports complets, commandes, éléments avancés. Pour l'usage courant, le mode Simple suffit."],
];
let obStep = 0;
if (!localStorage.getItem('aa-onboarded') && mode === 'simple') {
  $('overlay').hidden = false;
  showOb();
}
function showOb() {
  $('ob-emoji').textContent = OB[obStep][0];
  $('ob-title').textContent = OB[obStep][1];
  $('ob-text').textContent = OB[obStep][2];
  $('ob-next').textContent = obStep === OB.length - 1 ? "C'est parti !" : 'Continuer';
}
$('ob-next').addEventListener('click', () => {
  obStep++;
  if (obStep >= OB.length) { $('overlay').hidden = true; localStorage.setItem('aa-onboarded', '1'); }
  else showOb();
});

// ===== État partagé (SSE) =====
let summary = null;
const es = new EventSource('/api/events');
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.kind === 'snapshot') {
    $('log').innerHTML = '';
    ev.state.lines.forEach(addLog);
    if (ev.state.lines.length) $('log').hidden = false;
    summary = ev.state.summary;
    applyScanStatus(ev.state.status, ev.state.error);
    if (ev.state.clean.status === 'running') simpleShow('s-cleaning');
    else if (ev.state.clean.status === 'done' && ev.state.status === 'done') showCleanDone(ev.state.clean.freedBytes, ev.state.clean.results);
  } else if (ev.kind === 'line') {
    addLog(ev.line);
    if (ev.line.type === 'phase') $('s-phase').textContent = simplifyPhase(ev.line.text);
  } else if (ev.kind === 'status') {
    if (ev.summary) summary = ev.summary;
    applyScanStatus(ev.status, ev.error);
  } else if (ev.kind === 'clean-line') {
    $('s-cleanphase').textContent = 'Nettoyage… (' + ev.done + '/' + ev.total + ')';
    const d = document.createElement('div');
    d.className = ev.result.ok ? 'ok' : 'ko';
    d.textContent = (ev.result.ok ? '✓ ' : '✗ ') + ev.result.label + (ev.result.ok ? ' — ' + fmt(ev.result.freedBytes) : ' (' + (ev.result.error || 'échec') + ')');
    $('s-cleanlog').appendChild(d);
  } else if (ev.kind === 'clean-status') {
    if (ev.status === 'running') { simpleShow('s-cleaning'); $('s-cleanlog').innerHTML = ''; $('e-clean').disabled = true; }
    else if (ev.status === 'done') { showCleanDone(ev.freedBytes, ev.results || []); $('e-clean').disabled = false; loadJournal(); }
  }
};

function simplifyPhase(t) {
  const s = t.toLowerCase();
  if (s.includes('appdata')) return 'Recherche des fichiers temporaires…';
  if (s.includes('msix')) return 'Vérifications de sécurité…';
  if (s.includes('système') || s.includes('systeme')) return 'Analyse des fichiers Windows…';
  if (s.includes('applications')) return 'Analyse des programmes installés…';
  if (s.includes('rapport')) return 'Préparation des résultats…';
  if (s.includes('développeur') || s.includes('developpeur')) return 'Analyse des dossiers de travail…';
  return 'Analyse en cours…';
}
function addLog(l) {
  const div = document.createElement('div');
  div.className = l.type === 'item' ? 'item2' : l.type;
  div.textContent = (l.type === 'phase' ? '▸ ' : l.type === 'warn' ? '⚠ ' : '   ') + l.text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

// ===== Statut scan → les deux interfaces =====
function simpleShow(id) {
  ['s-idle', 's-progress', 's-results', 's-cleaning', 's-done'].forEach((x) => ($(x).hidden = x !== id));
}
function applyScanStatus(status, error) {
  // expert
  $('e-status').textContent = status === 'running' ? 'Scan en cours…' : status === 'done' ? 'Terminé ✓' : status === 'error' ? 'Erreur : ' + error : 'Prêt.';
  $('e-scan').disabled = status === 'running';
  if (status === 'running') $('log').hidden = false;
  if (status === 'done' && summary) renderExpertActions();
  // simple
  if (status === 'running') simpleShow('s-progress');
  else if (status === 'done' && summary) renderSimpleResults();
  else if (status === 'error') { simpleShow('s-idle'); alert("L'analyse a rencontré un problème : " + error + "\\n\\nVous pouvez réessayer. Si cela persiste, utilisez « Exporter un diagnostic » en bas de page."); }
}

// ===== Mode simple : résultats =====
let simpleChecked = new Set();
function simpleItems() { return (summary?.actionables || []).filter((a) => a.simple); }
function renderSimpleResults() {
  simpleShow('s-results');
  const items = simpleItems();
  simpleChecked = new Set(items.map((a) => a.id));
  drawSimpleItems(items);
  // programmes inutilisés (conseil)
  const apps = summary.unusedApps || [];
  $('s-apps').hidden = apps.length === 0;
  $('s-apps-list').innerHTML = apps.map((a) =>
    '<div class="item"><div class="t">' + a.name + '<div class="n">' + (a.lastUsed ? 'Dernière utilisation : ' + a.lastUsed : '') + '</div></div><div class="s">' + fmt(a.sizeBytes) + '</div></div>').join('');
  // admin
  $('s-adminhint').innerHTML = summary.admin ? '' :
    '<div class="hint">🔐 Certains fichiers de Windows ne sont accessibles qu\\'en mode administrateur. <a id="s-relaunch">Relancer en administrateur</a> (une confirmation Windows s\\'affichera).</div>';
  const rl = $('s-relaunch');
  if (rl) rl.addEventListener('click', relaunchAdmin);
}
function drawSimpleItems(items) {
  const total = items.filter((a) => simpleChecked.has(a.id)).reduce((s, a) => s + a.sizeBytes, 0);
  $('s-total').textContent = fmt(total);
  $('s-photos').textContent = total > 200 * 1024 * 1024 ? '≈ ' + Math.round(total / (4 * 1024 * 1024)) + ' photos de smartphone' : '';
  $('s-clean').disabled = total === 0;
  $('s-items').innerHTML = items.map((a) =>
    '<div class="item"><input type="checkbox" data-id="' + a.id + '"' + (simpleChecked.has(a.id) ? ' checked' : '') + '>'
    + '<div class="t">' + a.friendlyLabel + '<div class="n">' + a.friendlyNote + '</div></div>'
    + '<div class="s">' + fmt(a.sizeBytes) + '</div></div>').join('')
    || '<p class="muted">Rien à nettoyer : votre ordinateur est déjà propre ! 🎉</p>';
  $('s-items').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.id);
    cb.checked ? simpleChecked.add(id) : simpleChecked.delete(id);
    drawSimpleItems(items);
  }));
}
$('s-scan').addEventListener('click', () => api('/api/scan', { skip: ['dev'] }));
$('s-again').addEventListener('click', () => api('/api/scan', { skip: ['dev'] }));
$('s-clean').addEventListener('click', () => {
  const ids = [...simpleChecked];
  const total = simpleItems().filter((a) => simpleChecked.has(a.id)).reduce((s, a) => s + a.sizeBytes, 0);
  if (confirm('Envoyer ' + fmt(total) + ' de fichiers inutiles à la Corbeille ?\\n\\nVous pourrez les restaurer pendant environ 30 jours.')) {
    api('/api/clean', { ids });
  }
});
function showCleanDone(freed, results) {
  simpleShow('s-done');
  $('s-freed').textContent = fmt(freed);
  const errs = (results || []).filter((r) => !r.ok && r.error !== 'déjà absent');
  $('s-errors').hidden = errs.length === 0;
  $('s-errors').textContent = errs.length ? 'Certains éléments n\\'ont pas pu être nettoyés (fichiers en cours d\\'utilisation) — fermez les applications concernées et réessayez : ' + errs.map((r) => r.label).join(', ') : '';
}
$('s-openbin').addEventListener('click', () => api('/api/open-recycle-bin'));
$('s-openapps').addEventListener('click', () => api('/api/open-apps-settings'));
function relaunchAdmin() {
  alert("L'outil va se relancer : acceptez la demande d'autorisation de Windows, puis la page se rouvrira toute seule.");
  api('/api/relaunch-admin');
  setTimeout(() => location.reload(), 6000);
}

// ===== Mode expert =====
let expertChecked = new Set();
$('e-scan').addEventListener('click', () => {
  const skip = [];
  if (!$('mod-dev').checked) skip.push('dev');
  if (!$('mod-system').checked) skip.push('system');
  if (!$('mod-apps').checked) skip.push('apps');
  api('/api/scan', { skip });
});
function renderExpertActions() {
  const items = summary.actionables || [];
  $('e-actions').hidden = items.length === 0;
  expertChecked = new Set(items.filter((a) => a.category === 'green' && a.deleteMode).map((a) => a.id));
  drawExpert(items);
}
function drawExpert(items) {
  const CAT = { green: '🟢 Sans risque', yellow: '🟡 Précaution' };
  $('e-list').innerHTML = items.map((a) =>
    '<tr><td>' + (a.deleteMode ? '<input type="checkbox" data-id="' + a.id + '"' + (expertChecked.has(a.id) ? ' checked' : '') + '>' : '') + '</td>'
    + '<td>' + a.label + (a.needsAdmin ? ' <span class="chip yellow">admin</span>' : '') + '</td>'
    + '<td class="size">' + fmt(a.sizeBytes) + '</td>'
    + '<td><span class="chip ' + a.category + '">' + CAT[a.category] + '</span></td>'
    + '<td class="cmd">' + (a.command ? '<code title="' + a.command.replace(/"/g, '&quot;') + '">' + a.command.replace(/</g, '&lt;') + '</code> <button class="copy" data-cmd="' + a.command.replace(/"/g, '&quot;') + '">copier</button>' : '') + '</td></tr>').join('');
  const sel = items.filter((a) => expertChecked.has(a.id));
  $('e-selinfo').textContent = sel.length + ' élément(s), ' + fmt(sel.reduce((s, a) => s + a.sizeBytes, 0));
  $('e-clean').disabled = sel.length === 0;
  $('e-list').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.id);
    cb.checked ? expertChecked.add(id) : expertChecked.delete(id);
    drawExpert(items);
  }));
  $('e-list').querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.cmd).then(() => { b.textContent = 'copié ✓'; setTimeout(() => (b.textContent = 'copier'), 1500); });
  }));
}
$('e-clean').addEventListener('click', () => {
  const sel = (summary.actionables || []).filter((a) => expertChecked.has(a.id));
  if (confirm('Envoyer ' + sel.length + ' élément(s) (' + fmt(sel.reduce((s, a) => s + a.sizeBytes, 0)) + ') à la Corbeille ?')) {
    api('/api/clean', { ids: [...expertChecked] });
  }
});
$('e-psadmin').addEventListener('click', () => api('/api/open-powershell'));
$('e-adminrelaunch').addEventListener('click', relaunchAdmin);

// ===== Rapports + journal =====
async function loadReports() {
  const reports = await (await fetch('/api/reports')).json();
  $('e-reports').innerHTML = reports.length
    ? reports.map((r) =>
        '<tr><td><a href="/reports/' + encodeURIComponent(r.file) + '" target="_blank">' + r.file + '</a></td>'
        + '<td class="size">' + new Date(r.mtime).toLocaleString('fr-FR') + '</td>'
        + '<td class="size">' + fmt(r.sizeBytes) + '</td>'
        + '<td><a href="/reports/' + encodeURIComponent(r.file.replace(/\\.html$/, '.json')) + '" target="_blank">JSON</a></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">Aucun rapport pour l\\'instant.</td></tr>';
}
async function loadJournal() {
  const j = await (await fetch('/api/journal')).json();
  if (j.length) {
    $('e-journal').innerHTML = j.map((e) => '• ' + new Date(e.date).toLocaleString('fr-FR') + ' — <b>' + fmt(e.freedBytes) + '</b> libérés (' + e.items.filter((i) => i.ok).length + ' élément(s))').join('<br>');
    $('s-last').textContent = 'Dernier nettoyage : ' + new Date(j[0].date).toLocaleDateString('fr-FR') + ' — ' + fmt(j[0].freedBytes) + ' libérés.';
  }
}
loadReports();
loadJournal();
</script>
</body>
</html>`;
}
