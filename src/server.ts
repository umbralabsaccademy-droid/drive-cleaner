/**
 * Local web server: scan & assisted-cleanup dashboard.
 *
 * Technical choices:
 * - Pure `node:http`, zero dependencies: compatible with the SEA executable.
 * - Real-time progress via SSE; on connect the client receives a full
 *   snapshot (reloading the page mid-scan loses nothing).
 * - TWO interfaces in one page: "simple" (general public, default) and
 *   "expert" (the technical UI), switchable — plus a FR/EN language switch
 *   (auto-detected from the browser, persisted).
 * - Cleanup goes through the RECYCLE BIN (see cleaner.ts) and can only target
 *   items from the last scan (server-side id validation: a client can never
 *   get an arbitrary path deleted).
 * - "Open X" endpoints (admin PowerShell, Recycle Bin, Windows Settings) are
 *   protected by a custom header → CORS preflight that a third-party website
 *   cannot pass.
 * - `--auto-exit`: the server stops on its own 5 min after the last tab
 *   closes (launched as an app window, it must not outlive it forever).
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

/** Starts the server; the promise rejects if the port is taken (EADDRINUSE). */
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

  // --- Cleanup (recycle bin) ---
  const startClean = (ids: number[]): { ok: boolean; reason?: string } => {
    if (state.clean.status === 'running' || state.status === 'running') return { ok: false, reason: 'busy' };
    const actionables = state.summary?.actionables ?? [];
    // Strict validation: only ids from the last scan, only cleanable items
    const targets: CleanTarget[] = [];
    for (const id of ids) {
      const a = actionables.find((x) => x.id === id);
      if (a && a.deleteMode && a.deletePath) {
        targets.push({ id: a.id, path: a.deletePath, mode: a.deleteMode, sizeBytes: a.sizeBytes, label: a.friendlyLabel });
      }
    }
    if (targets.length === 0) return { ok: false, reason: 'no valid cleanable item' };

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
        // Append-only cleanup journal
        const entry = {
          date: new Date().toISOString(),
          freedBytes: state.clean.freedBytes,
          items: results.map((r) => ({ label: r.label, path: r.path, ok: r.ok, sizeBytes: r.freedBytes })),
        };
        try {
          await appendFile(path.join(baseOpts.outDir, JOURNAL_FILE), JSON.stringify(entry) + '\n', 'utf8');
        } catch { /* journal is non-blocking */ }
      })
      .catch((err) => {
        state.clean.status = 'done';
        state.clean.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error('Cleanup error:', state.clean.error);
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
      } catch { /* ignored */ }
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

  /** Launches a Windows utility (guarded by the anti-CSRF header upstream). */
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
    // Custom header required on every action: forces a CORS preflight
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
      } catch { /* invalid body: defaults */ }
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
      } catch { /* ignored */ }
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
      // Elevated relaunch of this same instance. Start-Process -Verb RunAs
      // BLOCKS until the user answers the UAC prompt:
      //  - refused → PowerShell errors → this instance STAYS ALIVE (the page
      //    keeps working, just without admin);
      //  - accepted → we free the port so the elevated instance can bind
      //    (which itself retries while the port is being released).
      // --auto-exit is essential: without it the elevated instance would
      // never die and would squat the port for every subsequent launch.
      // No --open: the requesting page polls and reloads itself.
      const isSea = !process.execPath.toLowerCase().endsWith('node.exe');
      const target = process.execPath;
      const argList = isSea
        ? `'--serve','--port','${port}','--auto-exit'`
        : `'${process.argv[1].replace(/'/g, "''")}','--serve','--port','${port}','--auto-exit'`;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Process '${target.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs`],
        { windowsHide: true, timeout: 120_000 },
        (err) => {
          if (err) {
            console.log('Elevated relaunch refused or failed — staying alive.');
            return;
          }
          setTimeout(() => {
            server.close();
            process.exit(0);
          }, 400);
        },
      );
      json(200, { ok: true });
      return;
    }
    if (url.pathname === '/api/diagnostic') {
      // Latest JSON report, served as a download (support / diagnostics)
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
      // Strict filename validation: no path traversal
      if (!/^appdata-report-[\w.:-]+\.(html|json)$/.test(name)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      try {
        const content = await readFile(path.join(baseOpts.outDir, name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml(baseOpts));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Auto-exit: window closed for > 5 min and nothing running
  if (baseOpts.autoExit) {
    setInterval(() => {
      const idle = sseClients.size === 0 && state.status !== 'running' && state.clean.status !== 'running';
      if (idle && Date.now() - lastClientSeen > 5 * 60_000) process.exit(0);
    }, 30_000).unref();
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`Dashboard: http://localhost:${port}`);
      console.log('(Ctrl+C to stop — the server only listens on 127.0.0.1)');
      resolve();
    });
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Dashboard page: single self-contained HTML document. All user-facing
 * strings live in the embedded FR/EN dictionary; the active language is
 * auto-detected from the browser and switchable (persisted in localStorage).
 */
function dashboardHtml(opts: ServerOptions): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drive Cleaner</title>
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
  #topbar { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 6px; }
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
  [hidden] { display: none !important; }
</style>
</head>
<body>

<!-- ===== First launch: explanation screens ===== -->
<div id="overlay" hidden>
  <div class="card">
    <div class="em" id="ob-emoji">🧹</div>
    <h2 style="margin-top:0" id="ob-title"></h2>
    <p class="muted" id="ob-text" style="font-size:14.5px"></p>
    <button class="big" id="ob-next" style="margin-top:8px"></button>
  </div>
</div>

<!-- ===== Mode + language selectors, visible in both interfaces ===== -->
<div id="topbar">
  <div class="seg" role="tablist" aria-label="Language">
    <button data-l="fr" id="seg-fr">FR</button>
    <button data-l="en" id="seg-en">EN</button>
  </div>
  <div class="seg" role="tablist" aria-label="Display mode">
    <button data-m="simple" id="seg-simple"></button>
    <button data-m="expert" id="seg-expert"></button>
  </div>
</div>

<!-- ===== SIMPLE MODE ===== -->
<div id="simple">
  <h1 id="s-title"></h1>
  <div class="sub" id="s-subtitle"></div>

  <div class="panel" id="s-idle">
    <p id="s-intro"></p>
    <button class="big" id="s-scan"></button>
    <p class="muted" id="s-last"></p>
  </div>

  <div class="panel" id="s-progress" hidden>
    <b id="s-phase"></b>
    <div class="bar-outer"><div class="bar-inner"></div></div>
    <span class="muted" id="s-progress-hint"></span>
  </div>

  <div id="s-results" hidden>
    <div class="panel">
      <div class="muted" id="s-recoverable"></div>
      <div class="bigsize" id="s-total">—</div>
      <div class="muted" id="s-photos"></div>
      <div id="s-items" style="margin-top:12px"></div>
      <div id="s-adminhint"></div>
      <button class="big green" id="s-clean" style="margin-top:16px"></button>
      <div class="muted" style="margin-top:8px" id="s-recoverhint"></div>
    </div>
    <div class="panel" id="s-apps" hidden>
      <h2 style="margin-top:0" id="s-apps-title"></h2>
      <p class="muted" id="s-apps-text"></p>
      <div id="s-apps-list"></div>
      <button class="sec" id="s-openapps" style="margin-top:10px"></button>
    </div>
  </div>

  <div class="panel" id="s-cleaning" hidden>
    <b id="s-cleanphase"></b>
    <div class="bar-outer"><div class="bar-inner"></div></div>
    <div id="s-cleanlog" class="muted"></div>
  </div>

  <div class="panel" id="s-done" hidden>
    <div style="font-size:34px">✅</div>
    <div class="bigsize" id="s-freed">—</div>
    <p id="s-done-text"></p>
    <p class="muted" id="s-done-hint"></p>
    <div class="row" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="sec" id="s-openbin"></button>
      <button class="sec" id="s-again"></button>
    </div>
    <div id="s-errors" class="warnbox" hidden></div>
  </div>
</div>

<!-- ===== EXPERT MODE ===== -->
<div id="expert" hidden>
  <h1 id="e-title"></h1>
  <div class="sub" id="e-subtitle"></div>

  <div class="panel">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="big" id="e-scan" style="padding:10px 22px;font-size:15px"></button>
      <label class="muted"><input type="checkbox" id="mod-dev" checked> <span id="l-mod-dev"></span></label>
      <label class="muted"><input type="checkbox" id="mod-system" checked> <span id="l-mod-system"></span></label>
      <label class="muted"><input type="checkbox" id="mod-apps" checked> <span id="l-mod-apps"></span></label>
      <button class="sec" id="e-psadmin"></button>
      <button class="sec" id="e-adminrelaunch"></button>
      <span id="e-status" class="muted"></span>
    </div>
    <div id="log" hidden></div>
  </div>

  <div class="panel" id="e-actions" hidden>
    <h2 style="margin-top:0" id="e-actions-title"></h2>
    <table><thead><tr><th></th><th id="th-item"></th><th id="th-size"></th><th id="th-cat"></th><th id="th-cmd"></th></tr></thead>
    <tbody id="e-list"></tbody></table>
    <button class="big green" id="e-clean" style="margin-top:12px;padding:10px 22px;font-size:15px"></button>
    <span class="muted" id="e-selinfo" style="margin-left:12px"></span>
  </div>

  <h2 id="e-reports-title"></h2>
  <div class="panel">
    <table><thead><tr><th id="th-report"></th><th id="th-date"></th><th id="th-rsize"></th><th id="th-data"></th></tr></thead>
    <tbody id="e-reports"></tbody></table>
  </div>

  <h2 id="e-journal-title"></h2>
  <div class="panel"><div id="e-journal" class="muted"></div></div>
</div>

<footer>
  <span id="f-left"></span>
  <span><a id="diag" href="/api/diagnostic"></a></span>
</footer>

<script>
// ===== i18n dictionary =====
const I18N = {
  fr: {
    sTitle: '🧹 Nettoyeur d\\'espace disque',
    sSubtitle: 'Libérez de la place en toute sécurité — tout ce qui est nettoyé va dans la Corbeille.',
    sIntro: 'Cliquez pour analyser votre ordinateur. <b>Rien n\\'est supprimé</b> pendant l\\'analyse : vous choisirez ensuite.',
    sScan: '🔍 Analyser mon ordinateur',
    sProgressHint: 'Cela prend généralement une à trois minutes. Vos fichiers ne sont pas modifiés.',
    sRecoverable: 'Espace récupérable sans risque',
    sClean: '🧹 Nettoyer (envoyer à la Corbeille)',
    sRecoverHint: 'Récupérable depuis la Corbeille pendant environ 30 jours.',
    sAppsTitle: '💡 Pour aller plus loin',
    sAppsText: 'Ces programmes semblent inutilisés depuis longtemps. Si vous ne les reconnaissez pas ou ne vous en servez plus, vous pouvez les désinstaller :',
    sOpenApps: 'Ouvrir « Applications installées » de Windows',
    sDoneText: 'récupérés ! Les fichiers sont dans la <b>Corbeille</b> : vous pouvez encore les restaurer en cas de doute.',
    sDoneHint: 'Ces fichiers se recréeront avec l\\'usage — c\\'est normal. Repassez dans quelques mois.',
    sOpenBin: 'Ouvrir la Corbeille',
    sAgain: 'Refaire une analyse',
    lastUse: 'Dernière utilisation :',
    lastClean: (d, s) => 'Dernier nettoyage : ' + d + ' — ' + s + ' libérés.',
    photos: (n) => '≈ ' + n + ' photos de smartphone',
    nothing: 'Rien à nettoyer : votre ordinateur est déjà propre ! 🎉',
    adminHint: '🔐 Certains fichiers de Windows ne sont accessibles qu\\'en mode administrateur. <a id="s-relaunch">Relancer en administrateur</a> (une confirmation Windows s\\'affichera).',
    confirmClean: (s) => 'Envoyer ' + s + ' de fichiers inutiles à la Corbeille ?\\n\\nVous pourrez les restaurer pendant environ 30 jours.',
    confirmCleanExpert: (n, s) => 'Envoyer ' + n + ' élément(s) (' + s + ') à la Corbeille ?',
    cleanErrors: (l) => 'Certains éléments n\\'ont pas pu être nettoyés (fichiers en cours d\\'utilisation) — fermez les applications concernées et réessayez : ' + l,
    relaunchMsg: 'L\\'outil va se relancer : acceptez la demande d\\'autorisation de Windows, puis la page se rouvrira toute seule.',
    relaunchWaitTitle: 'Relance en cours…',
    relaunchWaitText: 'Acceptez la demande d\\'autorisation de Windows (écran assombri). Cette page se reconnectera automatiquement — ne la fermez pas.',
    relaunchFail: 'La relance en administrateur semble avoir échoué ou été refusée. Relancez l\\'outil manuellement si besoin.',
    scanError: (e) => 'L\\'analyse a rencontré un problème : ' + e + '\\n\\nVous pouvez réessayer. Si cela persiste, utilisez « Exporter un diagnostic » en bas de page.',
    cleaning: 'Nettoyage en cours…',
    cleaningN: (d, t) => 'Nettoyage… (' + d + '/' + t + ')',
    phases: { appdata: 'Recherche des fichiers temporaires…', msix: 'Vérifications de sécurité…', system: 'Analyse des fichiers Windows…', application: 'Analyse des programmes installés…', report: 'Préparation des résultats…', developer: 'Analyse des dossiers de travail…', default: 'Analyse en cours…' },
    eTitle: '🔍 AppData Analyzer <span class="chip yellow">expert</span>',
    eSubtitle: (p, w) => 'Cible : ' + p + ' · Workspaces : ' + w + ' · analyse en lecture seule, nettoyage via Corbeille uniquement.',
    eScan: '▶ Lancer le scan',
    modDev: 'Caches dev', modSystem: 'Système', modApps: 'Applications',
    psAdmin: '🛡 PowerShell admin', adminRelaunch: '⬆ Relancer en admin',
    ready: 'Prêt.', scanning: 'Scan en cours…', done: 'Terminé ✓', errorPrefix: 'Erreur : ',
    eActionsTitle: '🧹 Nettoyage assisté (Corbeille)',
    thItem: 'Élément', thSize: 'Taille', thCat: 'Catégorie', thCmd: 'Détail / commande',
    eCleanSel: '🧹 Nettoyer la sélection',
    selInfo: (n, s) => n + ' élément(s), ' + s,
    eReportsTitle: '📚 Rapports', thReport: 'Rapport', thDate: 'Généré le', thRSize: 'Taille', thData: 'Données',
    noReports: 'Aucun rapport pour l\\'instant.',
    eJournalTitle: '🗒 Journal des nettoyages', noJournal: 'Aucun nettoyage pour l\\'instant.',
    journalLine: (d, s, n) => '• ' + d + ' — <b>' + s + '</b> libérés (' + n + ' élément(s))',
    fLeft: 'Analyse en lecture seule · nettoyage via la Corbeille uniquement · serveur local 127.0.0.1',
    diag: 'Exporter un diagnostic',
    segSimple: 'Simple', segExpert: '🛠 Expert',
    expertWarn: 'Le mode expert affiche des options avancées : éléments à supprimer avec précaution, commandes système, rapports techniques.\\n\\nSi vous n\\'êtes pas sûr, restez en mode Simple. Continuer ?',
    cat: { green: '🟢 Sans risque', yellow: '🟡 Précaution' },
    admin: 'admin', copy: 'copier', copied: 'copié ✓',
    obNext: 'Continuer', obStart: 'C\\'est parti !',
    ob: [
      ['🧹', 'Bienvenue !', 'Cet outil analyse votre ordinateur et trouve les fichiers inutiles qui prennent de la place, comme les fichiers temporaires et les restes de programmes désinstallés.'],
      ['🔒', 'Vos données sont protégées', 'Il ne touche jamais à vos documents, photos, mots de passe ou réglages. Seuls des fichiers sans danger, que Windows ou vos applications recréent tout seuls, sont proposés.'],
      ['♻️', 'Toujours réversible', 'Tout ce qui est nettoyé part dans la Corbeille. En cas de doute, vous pouvez tout restaurer pendant environ 30 jours.'],
      ['🛠', 'Pour les connaisseurs', 'Un mode Expert (bouton en haut à droite) donne accès au détail technique : rapports complets, commandes, éléments avancés. Pour l\\'usage courant, le mode Simple suffit.'],
    ],
    dateLocale: 'fr-FR',
  },
  en: {
    sTitle: '🧹 Drive Cleaner',
    sSubtitle: 'Free up space safely — everything cleaned goes to the Recycle Bin.',
    sIntro: 'Click to analyze your computer. <b>Nothing is deleted</b> during the analysis: you choose afterwards.',
    sScan: '🔍 Analyze my computer',
    sProgressHint: 'This usually takes one to three minutes. Your files are not modified.',
    sRecoverable: 'Space recoverable at no risk',
    sClean: '🧹 Clean up (send to Recycle Bin)',
    sRecoverHint: 'Recoverable from the Recycle Bin for about 30 days.',
    sAppsTitle: '💡 Going further',
    sAppsText: 'These programs look unused for a long time. If you don\\'t recognize them or no longer use them, you can uninstall them:',
    sOpenApps: 'Open Windows "Installed apps"',
    sDoneText: 'recovered! The files are in the <b>Recycle Bin</b>: you can still restore them if in doubt.',
    sDoneHint: 'These files will build up again with use — that\\'s normal. Come back in a few months.',
    sOpenBin: 'Open Recycle Bin',
    sAgain: 'Analyze again',
    lastUse: 'Last used:',
    lastClean: (d, s) => 'Last cleanup: ' + d + ' — ' + s + ' freed.',
    photos: (n) => '≈ ' + n + ' smartphone photos',
    nothing: 'Nothing to clean: your computer is already tidy! 🎉',
    adminHint: '🔐 Some Windows files are only accessible in administrator mode. <a id="s-relaunch">Relaunch as administrator</a> (a Windows confirmation will appear).',
    confirmClean: (s) => 'Send ' + s + ' of unneeded files to the Recycle Bin?\\n\\nYou can restore them for about 30 days.',
    confirmCleanExpert: (n, s) => 'Send ' + n + ' item(s) (' + s + ') to the Recycle Bin?',
    cleanErrors: (l) => 'Some items could not be cleaned (files in use) — close the related applications and try again: ' + l,
    relaunchMsg: 'The tool will relaunch: accept the Windows permission prompt, then the page will reopen on its own.',
    relaunchWaitTitle: 'Relaunching…',
    relaunchWaitText: 'Accept the Windows permission prompt (dimmed screen). This page will reconnect automatically — do not close it.',
    relaunchFail: 'The admin relaunch seems to have failed or been declined. Restart the tool manually if needed.',
    scanError: (e) => 'The analysis ran into a problem: ' + e + '\\n\\nYou can try again. If it persists, use "Export a diagnostic" at the bottom of the page.',
    cleaning: 'Cleaning…',
    cleaningN: (d, t) => 'Cleaning… (' + d + '/' + t + ')',
    phases: { appdata: 'Looking for temporary files…', msix: 'Safety checks…', system: 'Analyzing Windows files…', application: 'Analyzing installed programs…', report: 'Preparing the results…', developer: 'Analyzing work folders…', default: 'Analyzing…' },
    eTitle: '🔍 AppData Analyzer <span class="chip yellow">expert</span>',
    eSubtitle: (p, w) => 'Target: ' + p + ' · Workspaces: ' + w + ' · read-only analysis, cleanup via Recycle Bin only.',
    eScan: '▶ Run scan',
    modDev: 'Dev caches', modSystem: 'System', modApps: 'Applications',
    psAdmin: '🛡 Admin PowerShell', adminRelaunch: '⬆ Relaunch as admin',
    ready: 'Ready.', scanning: 'Scanning…', done: 'Done ✓', errorPrefix: 'Error: ',
    eActionsTitle: '🧹 Assisted cleanup (Recycle Bin)',
    thItem: 'Item', thSize: 'Size', thCat: 'Category', thCmd: 'Detail / command',
    eCleanSel: '🧹 Clean selection',
    selInfo: (n, s) => n + ' item(s), ' + s,
    eReportsTitle: '📚 Reports', thReport: 'Report', thDate: 'Generated', thRSize: 'Size', thData: 'Data',
    noReports: 'No report yet.',
    eJournalTitle: '🗒 Cleanup journal', noJournal: 'No cleanup yet.',
    journalLine: (d, s, n) => '• ' + d + ' — <b>' + s + '</b> freed (' + n + ' item(s))',
    fLeft: 'Read-only analysis · cleanup via Recycle Bin only · local server 127.0.0.1',
    diag: 'Export a diagnostic',
    segSimple: 'Simple', segExpert: '🛠 Expert',
    expertWarn: 'Expert mode shows advanced options: items to delete with caution, system commands, technical reports.\\n\\nIf unsure, stay in Simple mode. Continue?',
    cat: { green: '🟢 No risk', yellow: '🟡 Caution' },
    admin: 'admin', copy: 'copy', copied: 'copied ✓',
    obNext: 'Continue', obStart: 'Let\\'s go!',
    ob: [
      ['🧹', 'Welcome!', 'This tool analyzes your computer and finds the useless files taking up space, such as temporary files and leftovers from uninstalled programs.'],
      ['🔒', 'Your data is protected', 'It never touches your documents, photos, passwords or settings. Only safe files, which Windows or your applications recreate on their own, are offered.'],
      ['♻️', 'Always reversible', 'Everything cleaned goes to the Recycle Bin. If in doubt, you can restore everything for about 30 days.'],
      ['🛠', 'For power users', 'An Expert mode (button at the top right) gives access to technical detail: full reports, commands, advanced items. For everyday use, Simple mode is enough.'],
    ],
    dateLocale: 'en-US',
  },
};

const fmtFr = (b) => b >= 1024**3 ? (b/1024**3).toFixed(2).replace('.', ',') + ' Go'
             : b >= 1024**2 ? (b/1024**2).toFixed(0) + ' Mo' : (b/1024).toFixed(0) + ' Ko';
const fmtEn = (b) => b >= 1024**3 ? (b/1024**3).toFixed(2) + ' GB'
             : b >= 1024**2 ? (b/1024**2).toFixed(0) + ' MB' : (b/1024).toFixed(0) + ' KB';
const $ = (id) => document.getElementById(id);
const api = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-appdata-analyzer': '1' }, body: body ? JSON.stringify(body) : undefined });

// ===== Language (auto-detected, persisted) =====
let lang = localStorage.getItem('aa-lang') || ((navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en');
let T = I18N[lang];
const fmt = (b) => (lang === 'fr' ? fmtFr : fmtEn)(b);
const pick = (frV, enV) => (lang === 'en' && enV ? enV : frV);

const SERVER = { appData: '${esc(opts.appDataPath).replace(/\\/g, '\\\\')}', workspaces: '${esc(opts.workspacesPath).replace(/\\/g, '\\\\')}' };

function applyLang() {
  T = I18N[lang];
  document.documentElement.lang = lang;
  document.title = lang === 'fr' ? 'Nettoyeur d\\'espace disque' : 'Drive Cleaner';
  $('seg-fr').classList.toggle('active', lang === 'fr');
  $('seg-en').classList.toggle('active', lang === 'en');
  // Static texts
  $('s-title').textContent = T.sTitle;
  $('s-subtitle').textContent = T.sSubtitle;
  $('s-intro').innerHTML = T.sIntro;
  $('s-scan').textContent = T.sScan;
  $('s-progress-hint').textContent = T.sProgressHint;
  $('s-recoverable').textContent = T.sRecoverable;
  $('s-clean').textContent = T.sClean;
  $('s-recoverhint').textContent = T.sRecoverHint;
  $('s-apps-title').textContent = T.sAppsTitle;
  $('s-apps-text').textContent = T.sAppsText;
  $('s-openapps').textContent = T.sOpenApps;
  $('s-done-text').innerHTML = T.sDoneText;
  $('s-done-hint').textContent = T.sDoneHint;
  $('s-openbin').textContent = T.sOpenBin;
  $('s-again').textContent = T.sAgain;
  $('e-title').innerHTML = T.eTitle;
  $('e-subtitle').textContent = T.eSubtitle(SERVER.appData, SERVER.workspaces);
  $('e-scan').textContent = T.eScan;
  $('l-mod-dev').textContent = T.modDev;
  $('l-mod-system').textContent = T.modSystem;
  $('l-mod-apps').textContent = T.modApps;
  $('e-psadmin').textContent = T.psAdmin;
  $('e-adminrelaunch').textContent = T.adminRelaunch;
  $('e-actions-title').textContent = T.eActionsTitle;
  $('th-item').textContent = T.thItem; $('th-size').textContent = T.thSize;
  $('th-cat').textContent = T.thCat; $('th-cmd').textContent = T.thCmd;
  $('e-clean').textContent = T.eCleanSel;
  $('e-reports-title').textContent = T.eReportsTitle;
  $('th-report').textContent = T.thReport; $('th-date').textContent = T.thDate;
  $('th-rsize').textContent = T.thRSize; $('th-data').textContent = T.thData;
  $('e-journal-title').textContent = T.eJournalTitle;
  $('f-left').textContent = T.fLeft;
  $('diag').textContent = T.diag;
  $('seg-simple').textContent = T.segSimple;
  $('seg-expert').textContent = T.segExpert;
  // Re-render dynamic areas in the new language
  applyScanStatus(lastStatus, lastError);
  loadReports();
  loadJournal();
  if (!$('overlay').hidden) showOb();
}
$('seg-fr').addEventListener('click', () => { lang = 'fr'; localStorage.setItem('aa-lang', lang); applyLang(); });
$('seg-en').addEventListener('click', () => { lang = 'en'; localStorage.setItem('aa-lang', lang); applyLang(); });

// ===== Simple / expert mode (segmented selector) =====
let mode = localStorage.getItem('aa-mode') || 'simple';
function applyMode() {
  $('simple').hidden = mode !== 'simple';
  $('expert').hidden = mode !== 'expert';
  $('seg-simple').classList.toggle('active', mode === 'simple');
  $('seg-expert').classList.toggle('active', mode === 'expert');
}
function setMode(m) {
  // Novice guard: warning on the FIRST switch to expert, remembered afterwards
  if (m === 'expert' && !localStorage.getItem('aa-expert-ok')) {
    if (!confirm(T.expertWarn)) return;
    localStorage.setItem('aa-expert-ok', '1');
  }
  mode = m;
  localStorage.setItem('aa-mode', mode);
  applyMode();
}
$('seg-simple').addEventListener('click', () => setMode('simple'));
$('seg-expert').addEventListener('click', () => setMode('expert'));

// ===== Onboarding (first launch) =====
let obStep = 0;
function showOb() {
  const ob = T.ob[obStep];
  $('ob-emoji').textContent = ob[0];
  $('ob-title').textContent = ob[1];
  $('ob-text').textContent = ob[2];
  $('ob-next').textContent = obStep === T.ob.length - 1 ? T.obStart : T.obNext;
}
$('ob-next').addEventListener('click', () => {
  obStep++;
  if (obStep >= T.ob.length) { $('overlay').hidden = true; localStorage.setItem('aa-onboarded', '1'); }
  else showOb();
});

// ===== Shared state (SSE) =====
let summary = null;
let lastStatus = 'idle';
let lastError = null;
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
    $('s-cleanphase').textContent = T.cleaningN(ev.done, ev.total);
    const d = document.createElement('div');
    d.className = ev.result.ok ? 'ok' : 'ko';
    d.textContent = (ev.result.ok ? '✓ ' : '✗ ') + ev.result.label + (ev.result.ok ? ' — ' + fmt(ev.result.freedBytes) : ' (' + (ev.result.error || 'failed') + ')');
    $('s-cleanlog').appendChild(d);
  } else if (ev.kind === 'clean-status') {
    if (ev.status === 'running') { simpleShow('s-cleaning'); $('s-cleanphase').textContent = T.cleaning; $('s-cleanlog').innerHTML = ''; $('e-clean').disabled = true; }
    else if (ev.status === 'done') { showCleanDone(ev.freedBytes, ev.results || []); $('e-clean').disabled = false; loadJournal(); }
  }
};

// The pipeline emits English technical phases; keyword-map them per language
function simplifyPhase(t) {
  const s = t.toLowerCase();
  const P = T.phases;
  if (s.includes('appdata')) return P.appdata;
  if (s.includes('msix')) return P.msix;
  if (s.includes('system') || s.includes('système') || s.includes('systeme')) return P.system;
  if (s.includes('application')) return P.application;
  if (s.includes('report') || s.includes('rapport')) return P.report;
  if (s.includes('developer') || s.includes('développeur')) return P.developer;
  return P.default;
}
function addLog(l) {
  const div = document.createElement('div');
  div.className = l.type === 'item' ? 'item2' : l.type;
  div.textContent = (l.type === 'phase' ? '▸ ' : l.type === 'warn' ? '⚠ ' : '   ') + l.text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

// ===== Scan status → both interfaces =====
function simpleShow(id) {
  ['s-idle', 's-progress', 's-results', 's-cleaning', 's-done'].forEach((x) => ($(x).hidden = x !== id));
}
function applyScanStatus(status, error) {
  lastStatus = status;
  lastError = error;
  // expert
  $('e-status').textContent = status === 'running' ? T.scanning : status === 'done' ? T.done : status === 'error' ? T.errorPrefix + error : T.ready;
  $('e-scan').disabled = status === 'running';
  if (status === 'running') $('log').hidden = false;
  if (status === 'done' && summary) renderExpertActions();
  // simple
  if (status === 'running') { simpleShow('s-progress'); $('s-phase').textContent = T.phases.default; }
  else if (status === 'done' && summary) renderSimpleResults();
  else if (status === 'error') { simpleShow('s-idle'); alert(T.scanError(error)); }
}

// ===== Simple mode: results =====
let simpleChecked = new Set();
function simpleItems() { return (summary?.actionables || []).filter((a) => a.simple); }
function renderSimpleResults() {
  simpleShow('s-results');
  const items = simpleItems();
  simpleChecked = new Set(items.map((a) => a.id));
  drawSimpleItems(items);
  // unused programs (advice only)
  const apps = summary.unusedApps || [];
  $('s-apps').hidden = apps.length === 0;
  $('s-apps-list').innerHTML = apps.map((a) =>
    '<div class="item"><div class="t">' + a.name + '<div class="n">' + (a.lastUsed ? T.lastUse + ' ' + a.lastUsed : '') + '</div></div><div class="s">' + fmt(a.sizeBytes) + '</div></div>').join('');
  // admin
  $('s-adminhint').innerHTML = summary.admin ? '' : '<div class="hint">' + T.adminHint + '</div>';
  const rl = $('s-relaunch');
  if (rl) rl.addEventListener('click', relaunchAdmin);
}
function drawSimpleItems(items) {
  const total = items.filter((a) => simpleChecked.has(a.id)).reduce((s, a) => s + a.sizeBytes, 0);
  $('s-total').textContent = fmt(total);
  $('s-photos').textContent = total > 200 * 1024 * 1024 ? T.photos(Math.round(total / (4 * 1024 * 1024))) : '';
  $('s-clean').disabled = total === 0;
  $('s-items').innerHTML = items.map((a) =>
    '<div class="item"><input type="checkbox" data-id="' + a.id + '"' + (simpleChecked.has(a.id) ? ' checked' : '') + '>'
    + '<div class="t">' + pick(a.friendlyLabel, a.friendlyLabelEn) + '<div class="n">' + pick(a.friendlyNote, a.friendlyNoteEn) + '</div></div>'
    + '<div class="s">' + fmt(a.sizeBytes) + '</div></div>').join('')
    || '<p class="muted">' + T.nothing + '</p>';
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
  if (confirm(T.confirmClean(fmt(total)))) api('/api/clean', { ids });
});
function showCleanDone(freed, results) {
  simpleShow('s-done');
  $('s-freed').textContent = fmt(freed);
  const errs = (results || []).filter((r) => !r.ok && r.error !== 'déjà absent' && r.error !== 'already absent');
  $('s-errors').hidden = errs.length === 0;
  $('s-errors').textContent = errs.length ? T.cleanErrors(errs.map((r) => r.label).join(', ')) : '';
}
$('s-openbin').addEventListener('click', () => api('/api/open-recycle-bin'));
$('s-openapps').addEventListener('click', () => api('/api/open-apps-settings'));
async function relaunchAdmin() {
  alert(T.relaunchMsg);
  api('/api/relaunch-admin');
  // Waiting screen (reuses the onboarding overlay), then poll until the
  // server is back: covers slow UAC answers AND refusals (in which case the
  // old instance stays alive and the first poll succeeds immediately).
  $('ob-emoji').textContent = '🛡';
  $('ob-title').textContent = T.relaunchWaitTitle;
  $('ob-text').textContent = T.relaunchWaitText;
  $('ob-next').style.display = 'none';
  $('overlay').hidden = false;
  await new Promise((r) => setTimeout(r, 2500)); // let the exit/restart begin
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch { /* server not back yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  alert(T.relaunchFail);
  location.reload();
}

// ===== Expert mode =====
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
  $('e-list').innerHTML = items.map((a) =>
    '<tr><td>' + (a.deleteMode ? '<input type="checkbox" data-id="' + a.id + '"' + (expertChecked.has(a.id) ? ' checked' : '') + '>' : '') + '</td>'
    + '<td>' + a.label + (a.needsAdmin ? ' <span class="chip yellow">' + T.admin + '</span>' : '') + '</td>'
    + '<td class="size">' + fmt(a.sizeBytes) + '</td>'
    + '<td><span class="chip ' + a.category + '">' + T.cat[a.category] + '</span></td>'
    + '<td class="cmd">' + (a.command ? '<code title="' + a.command.replace(/"/g, '&quot;') + '">' + a.command.replace(/</g, '&lt;') + '</code> <button class="copy" data-cmd="' + a.command.replace(/"/g, '&quot;') + '">' + T.copy + '</button>' : '') + '</td></tr>').join('');
  const sel = items.filter((a) => expertChecked.has(a.id));
  $('e-selinfo').textContent = T.selInfo(sel.length, fmt(sel.reduce((s, a) => s + a.sizeBytes, 0)));
  $('e-clean').disabled = sel.length === 0;
  $('e-list').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.id);
    cb.checked ? expertChecked.add(id) : expertChecked.delete(id);
    drawExpert(items);
  }));
  $('e-list').querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.cmd).then(() => { b.textContent = T.copied; setTimeout(() => (b.textContent = T.copy), 1500); });
  }));
}
$('e-clean').addEventListener('click', () => {
  const sel = (summary.actionables || []).filter((a) => expertChecked.has(a.id));
  if (confirm(T.confirmCleanExpert(sel.length, fmt(sel.reduce((s, a) => s + a.sizeBytes, 0))))) {
    api('/api/clean', { ids: [...expertChecked] });
  }
});
$('e-psadmin').addEventListener('click', () => api('/api/open-powershell'));
$('e-adminrelaunch').addEventListener('click', relaunchAdmin);

// ===== Reports + journal =====
async function loadReports() {
  const reports = await (await fetch('/api/reports')).json();
  $('e-reports').innerHTML = reports.length
    ? reports.map((r) =>
        '<tr><td><a href="/reports/' + encodeURIComponent(r.file) + '" target="_blank">' + r.file + '</a></td>'
        + '<td class="size">' + new Date(r.mtime).toLocaleString(T.dateLocale) + '</td>'
        + '<td class="size">' + fmt(r.sizeBytes) + '</td>'
        + '<td><a href="/reports/' + encodeURIComponent(r.file.replace(/\\.html$/, '.json')) + '" target="_blank">JSON</a></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">' + T.noReports + '</td></tr>';
}
async function loadJournal() {
  const j = await (await fetch('/api/journal')).json();
  if (j.length) {
    $('e-journal').innerHTML = j.map((e) => T.journalLine(new Date(e.date).toLocaleString(T.dateLocale), fmt(e.freedBytes), e.items.filter((i) => i.ok).length)).join('<br>');
    $('s-last').textContent = T.lastClean(new Date(j[0].date).toLocaleDateString(T.dateLocale), fmt(j[0].freedBytes));
  } else {
    $('e-journal').textContent = T.noJournal;
  }
}

// ===== Init =====
applyMode();
applyLang();
if (!localStorage.getItem('aa-onboarded') && mode === 'simple') {
  $('overlay').hidden = false;
  showOb();
}
</script>
</body>
</html>`;
}
