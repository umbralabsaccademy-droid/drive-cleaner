/**
 * Point d'entrée CLI.
 *
 * Modes :
 *   (double-clic, aucun argument)        → relance masquée en serveur + fenêtre d'application
 *   node src/cli.ts [options]            → scan unique en console
 *   node src/cli.ts --serve [--port N]   → tableau de bord web local
 *
 * Options : [--path <AppData>] [--out <dossier>] [--workspaces <dossier>]
 *           [--skip dev,system,apps,history] [--concurrency 32] [--open] [--auto-exit]
 *
 * Garantie : analyse STRICTEMENT EN LECTURE SEULE ; le nettoyage assisté
 * (déclenché par l'utilisateur dans l'interface) envoie à la Corbeille,
 * jamais de suppression définitive.
 */
import path from 'node:path';
import os from 'node:os';
import { exec, execFile, spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { runFullScan, fmt } from './pipeline.ts';
import { startServer, type ServerOptions } from './server.ts';

interface CliArgs extends ServerOptions {
  open: boolean;
  serve: boolean;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const home = os.homedir();
  const args: CliArgs = {
    appDataPath: path.join(home, 'AppData'),
    outDir: path.join(process.cwd(), 'reports'),
    workspacesPath: path.join(home, 'Documents', 'Workspaces'),
    skip: new Set<string>(),
    concurrency: 32,
    open: false,
    serve: false,
    autoExit: false,
    port: 7113,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--path': args.appDataPath = argv[++i] ?? args.appDataPath; break;
      case '--out': args.outDir = argv[++i] ?? args.outDir; break;
      case '--workspaces': args.workspacesPath = argv[++i] ?? args.workspacesPath; break;
      case '--skip': (argv[++i] ?? '').split(',').forEach((m) => args.skip.add(m.trim())); break;
      case '--concurrency': args.concurrency = Number(argv[++i]) || 32; break;
      case '--port': args.port = Number(argv[++i]) || 7113; break;
      case '--open': args.open = true; break;
      case '--serve': args.serve = true; break;
      case '--auto-exit': args.autoExit = true; break;
      case '--help':
      case '-h':
        console.log('Usage : appdata-analyzer [--serve] [--port 7113] [--path <AppData>] [--out <dossier>]');
        console.log('                         [--workspaces <dossier>] [--skip dev,system,apps,history]');
        console.log('                         [--concurrency N] [--open] [--auto-exit]');
        process.exit(0);
    }
  }
  return args;
}

/** Is a live dashboard answering on this URL? (distinguishes a real running
 *  instance from a port in the middle of being released) */
async function probeAlive(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(`${url}/api/state`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ouvre l'interface dans une FENÊTRE D'APPLICATION (sans barre d'adresse ni
 * onglets : ressemble à un vrai logiciel), avec le navigateur Chromium
 * disponible — le navigateur PAR DÉFAUT d'abord (Brave/Edge/Chrome), sinon
 * les autres. En dernier recours : onglet classique du navigateur par défaut.
 *
 * Choix techniques :
 * - PowerShell Start-Process et non `cmd start` : `start` échoue
 *   silencieusement quand le parent est un processus détaché sans console
 *   (cas du lancement par double-clic).
 * - Le chemin du navigateur est résolu via le registre « App Paths »
 *   (HKCU puis HKLM) : Edge peut être absent, Brave n'est pas dans le PATH.
 */
function openAppWindow(url: string): void {
  const ps = [
    // Navigateur par défaut (ProgId de l'association http)
    "$prog = (Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId",
    "$candidates = @()",
    "if ($prog -like 'Brave*') { $candidates += 'brave.exe' } elseif ($prog -like 'MSEdge*') { $candidates += 'msedge.exe' } elseif ($prog -like 'Chrome*') { $candidates += 'chrome.exe' }",
    "$candidates += 'msedge.exe','brave.exe','chrome.exe'",
    '$opened = $false',
    "foreach ($exe in ($candidates | Select-Object -Unique)) {",
    "  $p = $null",
    "  foreach ($root in 'HKCU','HKLM') { $k = $root + ':\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + $exe; if (Test-Path $k) { $v = (Get-ItemProperty $k).'(default)'; if ($v) { $p = $v; break } } }",
    "  if ($p -and (Test-Path $p)) { try { Start-Process $p -ArgumentList '--app=" + url + "' -ErrorAction Stop; $opened = $true; break } catch {} }",
    '}',
    "if (-not $opened) { Start-Process '" + url + "' }",
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true }, (err) => {
      if (err) exec(`start "" "${url}"`, { shell: 'cmd.exe' });
    });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  // Double-clic sur l'exe (aucun argument) : on se relance soi-même en
  // serveur MASQUÉ (windowsHide → pas de console visible) puis on sort.
  // Le serveur s'arrêtera seul 5 min après la fermeture de la fenêtre (--auto-exit).
  if (rawArgs.length === 0 && isSea()) {
    const child = spawn(process.execPath, ['--serve', '--open', '--auto-exit'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: path.dirname(process.execPath), // reports\ à côté de l'exe
    });
    child.unref();
    return;
  }
  // Sans argument via Node (dev) : tableau de bord classique
  if (rawArgs.length === 0) {
    args.serve = true;
    args.open = true;
  }

  if (args.serve) {
    const url = `http://localhost:${args.port}`;
    // The port may be held by a LIVE instance (→ open its window) or by a
    // DYING one (admin relaunch handover: the old instance frees the port a
    // moment after spawning us) — probe to tell them apart, retry on transient.
    for (let attempt = 0; ; attempt++) {
      try {
        await startServer(args, args.port);
        if (args.open) openAppWindow(url);
        return;
      } catch (err) {
        const busy = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (!busy) throw err;
        if (await probeAlive(url)) {
          console.log(`An instance is already listening on ${url} — opening the existing window.`);
          openAppWindow(url);
          return;
        }
        // Generous budget: an elevated SEA relaunch can be slowed for many
        // seconds by AV/SmartScreen reputation checks on the freshly-run
        // unsigned binary — must comfortably outlast that, and stay under
        // the frontend's ~92.5s polling window (see relaunchAdmin() in
        // server.ts) so a late success still gets picked up by the page.
        if (attempt >= 75) {
          console.error(`Port ${args.port} is busy but unresponsive — giving up. Close the stuck process or use --port.`);
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  console.log(`Read-only scan of: ${args.appDataPath}`);
  console.log('(no file will be modified or deleted)\n');

  const summary = await runFullScan(args, (ev) => {
    const prefix = ev.type === 'phase' ? '\n' : ev.type === 'warn' ? '   [!] ' : '   ';
    console.log(prefix + ev.text);
  });

  console.log(`\nScan finished in ${summary.seconds}s`);
  console.log(`   Adjusted AppData total : ${fmt(summary.adjustedTotalBytes)}`);
  console.log(`   Green gain (no risk)   : ${fmt(summary.greenGainBytes)}`);
  console.log(`   Yellow gain (caution)  : ${fmt(summary.yellowGainBytes)}`);
  console.log(`\nHTML report : ${summary.htmlPath}`);
  console.log(`JSON data   : ${summary.jsonPath}`);

  if (args.open) exec(`start "" "${summary.htmlPath}"`, { shell: 'cmd.exe' });
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
