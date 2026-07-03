/**
 * Module 1 — Applications installées et estimation de dernière utilisation.
 *
 * Sources (toutes en lecture seule) :
 * - Registre Uninstall (HKLM 64/32 bits + HKCU) : nom, éditeur, taille
 *   estimée, date d'installation — la même liste que « Programmes installés ».
 * - UserAssist (HKCU, noms encodés ROT13, FILETIME de dernier lancement à
 *   l'offset 60 du blob binaire) : dernière exécution via l'Explorateur.
 * - Prefetch (C:\Windows\Prefetch\*.pf, si lisible) : date de dernier
 *   lancement par nom d'exécutable.
 *
 * Choix techniques :
 * - Les lectures registre passent par PowerShell lancé en sous-processus avec
 *   sortie JSON : plus fiable que parser `reg query`, et le décodage ROT13 +
 *   FILETIME est trivial côté PowerShell.
 * - Le croisement nom d'app ↔ exécutable est HEURISTIQUE (tokens du
 *   DisplayName vs noms d'exe) : la date est donc une estimation, affichée
 *   comme telle. Absence de correspondance → « date inconnue », jamais une
 *   fausse certitude.
 */
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Finding, Section } from './types.ts';

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;
const MB = 1024 * 1024;

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 32 * MB },
      (_err, stdout) => resolve(stdout ?? ''),
    );
  });
}

interface InstalledApp {
  DisplayName: string;
  Publisher: string | null;
  DisplayVersion: string | null;
  EstimatedSize: number | null; // en Ko (convention registre)
  InstallDate: string | null;   // yyyyMMdd
  InstallLocation: string | null;
}

/** Liste « Programmes installés » depuis les trois ruches Uninstall. */
async function getInstalledApps(): Promise<InstalledApp[]> {
  const script = `
$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
         'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
         'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } |
  Select-Object DisplayName, Publisher, DisplayVersion, EstimatedSize, InstallDate, InstallLocation |
  ConvertTo-Json -Compress`;
  try {
    const raw = (await runPowerShell(script)).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** UserAssist : chemin/nom d'exécutable (décodé ROT13) → date de dernier lancement. */
async function getUserAssist(): Promise<Map<string, number>> {
  const script = `
$out = @{}
Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $countKey = $_.PSPath + '\\Count'
    $item = Get-Item $countKey -ErrorAction SilentlyContinue
    if (-not $item) { return }
    foreach ($prop in $item.Property) {
      # Décodage ROT13 du nom de valeur
      $decoded = -join ($prop.ToCharArray() | ForEach-Object {
        $c = [int]$_
        if (($c -ge 97 -and $c -le 109) -or ($c -ge 65 -and $c -le 77)) { [char]($c + 13) }
        elseif (($c -ge 110 -and $c -le 122) -or ($c -ge 78 -and $c -le 90)) { [char]($c - 13) }
        else { $_ }
      })
      $v = $item.GetValue($prop)
      if ($v -is [byte[]] -and $v.Length -ge 68) {
        $ft = [BitConverter]::ToInt64($v, 60)
        if ($ft -gt 0) {
          try { $out[$decoded] = [DateTime]::FromFileTimeUtc($ft).ToString('yyyy-MM-dd') } catch {}
        }
      }
    }
  }
$out | ConvertTo-Json -Compress`;
  const map = new Map<string, number>();
  try {
    const raw = (await runPowerShell(script)).trim();
    if (!raw || raw === 'null') return map;
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [name, dateStr] of Object.entries(obj)) {
      const t = Date.parse(dateStr);
      if (!Number.isNaN(t)) map.set(name.toLowerCase(), t);
    }
  } catch {
    /* UserAssist illisible : on continue sans */
  }
  return map;
}

/** Prefetch : nom d'exe (sans extension) → mtime du .pf le plus récent. */
async function getPrefetch(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const dir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Prefetch');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return map; // lecture refusée sans admin : source simplement absente
  }
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.pf')) continue;
    // Format : NOMEXE.EXE-HASH.pf
    const exe = n.slice(0, n.lastIndexOf('-')).toLowerCase().replace(/\.exe$/i, '');
    try {
      const st = await stat(path.join(dir, n));
      const prev = map.get(exe) ?? 0;
      if (st.mtimeMs > prev) map.set(exe, st.mtimeMs);
    } catch {
      /* ignoré */
    }
  }
  return map;
}

/** Tokens significatifs d'un nom d'application (pour le matching heuristique). */
const STOP_WORDS = new Set(['the', 'for', 'and', 'app', 'setup', 'x64', 'x86', 'edition', 'version', 'windows', 'microsoft', 'inc', 'llc', 'de', 'la']);
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Inventorie les applications installées (registre Uninstall) et estime leur
 * dernière utilisation (UserAssist + Prefetch). Ne produit que des CONSEILS
 * de désinstallation (commande winget affichée), jamais d'action automatique.
 */
export async function scanInstalledApps(): Promise<Section> {
  const [apps, userAssist, prefetch] = await Promise.all([getInstalledApps(), getUserAssist(), getPrefetch()]);
  const now = Date.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  if (prefetch.size === 0) {
    notes.push('Prefetch illisible sans droits admin : la dernière utilisation repose uniquement sur UserAssist (lancements via l\'Explorateur) — relancer en admin pour affiner.');
  }
  notes.push('La « dernière utilisation » est une estimation heuristique (UserAssist + Prefetch). Une date inconnue ne signifie pas que l\'application est inutilisée : vérifier avant de désinstaller.');

  for (const app of apps) {
    const sizeBytes = (app.EstimatedSize ?? 0) * 1024;
    if (sizeBytes < 50 * MB) continue; // en dessous, le gain ne justifie pas le bruit

    // Dernière utilisation : meilleure correspondance UserAssist/Prefetch
    const appTokens = tokens(app.DisplayName);
    let lastUsed = 0;
    for (const [uaPath, t] of userAssist) {
      if (appTokens.some((tok) => uaPath.includes(tok))) {
        if (t > lastUsed) lastUsed = t;
      } else if (app.InstallLocation && uaPath.includes(app.InstallLocation.toLowerCase())) {
        if (t > lastUsed) lastUsed = t;
      }
    }
    for (const [exe, t] of prefetch) {
      if (appTokens.some((tok) => exe.includes(tok) || tok.includes(exe))) {
        if (t > lastUsed) lastUsed = t;
      }
    }

    const stale = lastUsed > 0 && now - lastUsed > SIX_MONTHS_MS;
    const unknown = lastUsed === 0;
    const lastIso = lastUsed > 0 ? new Date(lastUsed).toISOString().slice(0, 10) : null;
    const installed = app.InstallDate && /^\d{8}$/.test(app.InstallDate)
      ? `${app.InstallDate.slice(0, 4)}-${app.InstallDate.slice(4, 6)}-${app.InstallDate.slice(6, 8)}`
      : null;

    findings.push({
      label: app.DisplayName + (app.Publisher ? ` — ${app.Publisher}` : ''),
      path: app.InstallLocation ?? '',
      sizeBytes,
      category: stale ? 'yellow' : unknown ? 'yellow' : 'red',
      dataType: installed ? `application (installée le ${installed})` : 'application',
      note: stale
        ? `Aucun lancement détecté depuis le ${lastIso} : candidate à la désinstallation.`
        : unknown
          ? 'Dernière utilisation inconnue (jamais lancée via l\'Explorateur ?) : vérifier avant de désinstaller.'
          : `Utilisée récemment (${lastIso}) : à conserver.`,
      command: stale || unknown ? `winget uninstall --name "${app.DisplayName}"` : undefined,
      lastActivity: lastIso,
    });
  }

  findings.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { id: 'apps', title: '📱 Applications installées (candidates à la désinstallation)', findings, notes };
}
