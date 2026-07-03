/**
 * Nettoyage assisté — envoi à la CORBEILLE, jamais de suppression définitive.
 *
 * Choix techniques :
 * - L'API .NET `Microsoft.VisualBasic.FileIO.FileSystem` (invoquée via
 *   PowerShell) est la seule voie standard pour envoyer un dossier à la
 *   corbeille sans dépendance : l'erreur d'un novice reste réversible ~30 jours.
 * - Deux modes : 'dir' (le dossier entier part à la corbeille) et 'contents'
 *   (chaque enfant individuellement — pour les dossiers à conserver comme
 *   Temp, où des fichiers verrouillés par des applis actives sont normaux et
 *   simplement ignorés).
 * - Exécution SÉQUENTIELLE : progression lisible, pas de contention disque.
 * - La validation de ce qui est nettoyable n'est PAS ici : le serveur ne passe
 *   que des cibles issues du dernier scan (jamais un chemin arbitraire du client).
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface CleanTarget {
  id: number;
  path: string;
  mode: 'dir' | 'contents';
  sizeBytes: number;
  label: string;
}

export interface CleanResult {
  id: number;
  path: string;
  label: string;
  ok: boolean;
  freedBytes: number;
  error?: string;
}

/** Échappement PowerShell : dans une chaîne à quotes simples, seul ' se double. */
function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

function runPs(script: string, timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs },
      (error, _stdout, stderr) => resolve({ ok: !error, err: (stderr || (error ? error.message : '')).trim().slice(0, 300) }),
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Envoie une cible à la corbeille. */
async function recycleOne(t: CleanTarget): Promise<CleanResult> {
  if (!(await exists(t.path))) {
    return { id: t.id, path: t.path, label: t.label, ok: true, freedBytes: 0, error: 'already absent' };
  }

  // Timeout proportionnel à la taille (l'envoi corbeille de gros dossiers est lent)
  const timeoutMs = Math.round(Math.min(15 * 60_000, 60_000 + (t.sizeBytes / (50 * 1024 * 1024)) * 60_000));

  let script: string;
  if (t.mode === 'dir') {
    script = `
Add-Type -AssemblyName Microsoft.VisualBasic
$p = ${psQuote(t.path)}
if (Test-Path -LiteralPath $p -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
}`;
  } else {
    // mode 'contents' : enfant par enfant, les éléments verrouillés sont ignorés
    script = `
Add-Type -AssemblyName Microsoft.VisualBasic
Get-ChildItem -LiteralPath ${psQuote(t.path)} -Force | ForEach-Object {
  try {
    if ($_.PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  } catch {}
}`;
  }

  const { ok, err } = await runPs(script, timeoutMs);
  // Vérification factuelle : en mode 'dir', le succès = le chemin n'existe plus
  const gone = t.mode === 'dir' ? !(await exists(t.path)) : true;
  const success = ok && gone;
  return {
    id: t.id,
    path: t.path,
    label: t.label,
    ok: success,
    freedBytes: success ? t.sizeBytes : 0,
    error: success ? undefined : err || 'folder still exists (locked files?)',
  };
}

/** Nettoie une liste de cibles, séquentiellement, avec progression. */
export async function cleanToRecycleBin(
  targets: CleanTarget[],
  emit: (r: CleanResult) => void,
): Promise<CleanResult[]> {
  const results: CleanResult[] = [];
  for (const t of targets) {
    const r = await recycleOne(t);
    results.push(r);
    emit(r);
  }
  return results;
}
