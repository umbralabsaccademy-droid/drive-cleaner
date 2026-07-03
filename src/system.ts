/**
 * Module 2 — System temporary/regenerable areas.
 *
 * Covers what the Windows "Disk Cleanup" tool does, but explains every item:
 * Windows Update leftovers, recycle bin, crash dumps, error reports, Delivery
 * Optimization cache, Windows.old, hiberfil.sys/pagefile.sys, restore points.
 *
 * Technical choices:
 * - Some areas require admin elevation: we detect it (`fltmc` fails cleanly
 *   without rights) and mark items "not measurable without admin" instead of
 *   failing the scan.
 * - Recommendations favour OFFICIAL tools (cleanmgr, powercfg,
 *   Clear-RecycleBin, dism) over brute Remove-Item when a service depends on
 *   the folder (e.g. SoftwareDistribution → stop wuauserv first).
 */
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { measureDir } from './scanner.ts';
import type { Finding, Section } from './types.ts';
import type { Category } from './knowledge.ts';

const MB = 1024 * 1024;

/** Is the process elevated (admin)? `fltmc` fails without elevation. */
export function isElevated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('fltmc.exe', [], { windowsHide: true, timeout: 10_000 }, (err) => resolve(!err));
  });
}

interface AreaDef {
  path: string;
  label: string;
  dataType: string;
  dataTypeEn: string;
  category: Category;
  note: string;
  noteEn: string;
  command?: string;
  /** Readable only as admin (otherwise partial/zero size). */
  needsAdmin?: boolean;
  /** Display threshold in bytes (default 10 MB). */
  minBytes?: number;
}

/**
 * Mesure les zones temporaires/regénérables du système (Windows Update,
 * corbeille, dumps, WER, hiberfil…). Les zones réservées à l'admin sont
 * signalées comme non mesurables plutôt que de faire échouer le scan.
 */
export async function scanSystem(): Promise<Section> {
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const sysDrive = process.env.SystemDrive ?? 'C:';
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const admin = await isElevated();

  const areas: AreaDef[] = [
    {
      path: path.join(windir, 'Temp'), label: 'Windows\\Temp',
      dataType: 'temporaires', dataTypeEn: 'temporary files', category: 'green',
      note: 'Temporaires système. Vider le contenu (les fichiers en cours d\'usage resteront verrouillés, c\'est normal).',
      noteEn: 'System temp files. Delete the contents (in-use files will stay locked, that\'s normal).',
      command: `Get-ChildItem "${path.join(windir, 'Temp')}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      needsAdmin: true,
    },
    {
      path: path.join(windir, 'SoftwareDistribution', 'Download'), label: 'SoftwareDistribution\\Download',
      dataType: 'téléchargements Windows Update', dataTypeEn: 'Windows Update downloads', category: 'green',
      note: 'Paquets de mises à jour déjà installées. Arrêter le service Windows Update avant, il retélécharge au besoin.',
      noteEn: 'Packages of already-installed updates. Stop the Windows Update service first; it re-downloads as needed.',
      command: `Stop-Service wuauserv; Remove-Item "${path.join(windir, 'SoftwareDistribution', 'Download')}\\*" -Recurse -Force; Start-Service wuauserv`,
      needsAdmin: true,
    },
    {
      path: path.join(windir, 'Minidump'), label: 'Windows\\Minidump',
      dataType: 'dumps de crash', dataTypeEn: 'crash dumps', category: 'green',
      note: 'Mini-dumps d\'écrans bleus. Utiles uniquement pour diagnostiquer un crash passé.',
      noteEn: 'Blue-screen minidumps. Only useful to diagnose a past crash.',
      command: `Remove-Item "${path.join(windir, 'Minidump')}\\*" -Force`, needsAdmin: true,
    },
    {
      path: path.join(programData, 'Microsoft', 'Windows', 'WER'), label: 'Rapports d\'erreurs (WER)',
      dataType: 'rapports de crash', dataTypeEn: 'error reports', category: 'green',
      note: 'Rapports d\'erreurs Windows en attente/archivés. Recréés au prochain plantage.',
      noteEn: 'Queued/archived Windows error reports. Recreated on the next crash.',
      command: 'cleanmgr  # cocher « Fichiers de rapport d\'erreurs Windows »', needsAdmin: true,
    },
    {
      path: path.join(windir, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache'),
      label: 'Optimisation de la distribution',
      dataType: 'cache de mises à jour P2P', dataTypeEn: 'P2P update cache', category: 'green',
      note: 'Cache de partage des mises à jour entre PC. Vidage propre via la commande dédiée.',
      noteEn: 'Cache used to share updates between PCs. Clean it with the dedicated command.',
      command: 'Delete-DeliveryOptimizationCache -Force', needsAdmin: true,
    },
    {
      path: path.join(sysDrive, '\\', 'Windows.old'), label: 'Windows.old',
      dataType: 'ancienne installation Windows', dataTypeEn: 'previous Windows installation', category: 'green',
      note: 'Ancienne installation conservée après une mise à niveau (rollback possible tant qu\'il existe). Supprimer via l\'outil officiel uniquement.',
      noteEn: 'Previous installation kept after an upgrade (rollback possible while it exists). Remove with the official tool only.',
      command: 'cleanmgr  # cocher « Installation(s) de Windows précédente(s) »', needsAdmin: true,
    },
    {
      path: path.join(sysDrive, '\\', '$Recycle.Bin'), label: 'Corbeille (tous volumes)',
      dataType: 'fichiers supprimés', dataTypeEn: 'deleted files', category: 'yellow',
      note: 'Vider la corbeille rend la récupération des fichiers supprimés impossible.',
      noteEn: 'Emptying the recycle bin makes deleted files unrecoverable.',
      command: 'Clear-RecycleBin -Force', needsAdmin: true, minBytes: 1 * MB,
    },
  ];

  const findings: Finding[] = [];
  const notes: string[] = [];
  const notesEn: string[] = [];

  for (const a of areas) {
    const st = await measureDir(a.path);
    const min = a.minBytes ?? 10 * MB;
    if (st.sizeBytes === 0 && st.fileCount === 0) {
      // Either empty/absent, or unreadable without admin: only report the latter
      if (a.needsAdmin && !admin) {
        notes.push(`« ${a.label} » non mesurable sans droits admin — relancer le scan en administrateur pour la taille exacte.`);
        notesEn.push(`"${a.label}" cannot be measured without admin rights — rerun the scan as administrator for the exact size.`);
      }
      continue;
    }
    if (st.sizeBytes < min) continue;
    findings.push({
      label: a.label, path: a.path, sizeBytes: st.sizeBytes, category: a.category,
      dataType: a.dataType, dataTypeEn: a.dataTypeEn,
      note: a.note + (a.needsAdmin ? ' (commande à lancer en admin)' : ''),
      noteEn: a.noteEn + (a.needsAdmin ? ' (run the command as admin)' : ''),
      command: a.command,
      lastActivity: st.newestMtimeMs > 0 ? new Date(st.newestMtimeMs).toISOString().slice(0, 10) : null,
    });
  }

  // --- Single system files (no direct deletion: official setting instead) ---
  const singleFiles: Array<{ p: string; label: string; category: Category; dataType: string; dataTypeEn: string; note: string; noteEn: string; command?: string }> = [
    {
      p: path.join(sysDrive, '\\', 'hiberfil.sys'), label: 'hiberfil.sys (veille prolongée)', category: 'yellow',
      dataType: 'fichier système', dataTypeEn: 'system file',
      note: 'Désactiver la veille prolongée récupère cet espace (≈ 40 % de la RAM). Conséquence : plus d\'hibernation ni de « démarrage rapide ».',
      noteEn: 'Disabling hibernation reclaims this space (≈ 40% of RAM). Consequence: no more hibernation or "fast startup".',
      command: 'powercfg /h off  # en admin ; réversible avec powercfg /h on',
    },
    {
      p: path.join(sysDrive, '\\', 'pagefile.sys'), label: 'pagefile.sys (mémoire virtuelle)', category: 'red',
      dataType: 'fichier système', dataTypeEn: 'system file',
      note: 'Nécessaire au système. Ne pas supprimer ; taille gérée automatiquement par Windows.',
      noteEn: 'Required by the system. Do not delete; Windows manages its size automatically.',
    },
    {
      p: path.join(windir, 'MEMORY.DMP'), label: 'MEMORY.DMP (dump complet)', category: 'green',
      dataType: 'dump de crash', dataTypeEn: 'crash dump',
      note: 'Image mémoire du dernier écran bleu. Supprimable si le crash est résolu.',
      noteEn: 'Memory image of the last blue screen. Removable once the crash is resolved.',
      command: `Remove-Item "${path.join(windir, 'MEMORY.DMP')}" -Force  # en admin`,
    },
  ];
  for (const f of singleFiles) {
    try {
      const st = await stat(f.p);
      if (st.size < 10 * MB) continue;
      findings.push({
        label: f.label, path: f.p, sizeBytes: st.size, category: f.category,
        dataType: f.dataType, dataTypeEn: f.dataTypeEn,
        note: f.note, noteEn: f.noteEn, command: f.command,
        lastActivity: new Date(st.mtimeMs).toISOString().slice(0, 10),
      });
    } catch {
      /* absent: nothing to report */
    }
  }

  // --- Restore points (VSS): measured via vssadmin, admin required ---
  if (admin) {
    const vss = await new Promise<string>((resolve) => {
      execFile('vssadmin', ['list', 'shadowstorage'], { windowsHide: true, timeout: 30_000 }, (_e, stdout) => resolve(stdout ?? ''));
    });
    const m = vss.match(/(?:Used|Utilisé)[^:]*:\s*([\d.,]+)\s*(GB|MB|Go|Mo)/i);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      const bytes = /g/i.test(m[2]) ? val * 1024 * MB : val * MB;
      findings.push({
        label: 'Points de restauration (VSS)', path: sysDrive + '\\System Volume Information', sizeBytes: Math.round(bytes),
        category: 'yellow', dataType: 'restauration système', dataTypeEn: 'system restore',
        note: 'Supprimer les anciens points garde la protection mais libère l\'espace. Conséquence : impossible de restaurer à une date antérieure.',
        noteEn: 'Deleting old points keeps the protection but frees the space. Consequence: you can no longer restore to an earlier date.',
        command: 'vssadmin delete shadows /for=C: /oldest  # ou régler le quota dans Protection du système',
      });
    }
  } else {
    notes.push('Points de restauration (VSS) et WinSxS non analysés : relancer en admin pour les mesurer.');
    notesEn.push('Restore points (VSS) and WinSxS not analyzed: rerun as admin to measure them.');
  }

  notes.push('WinSxS (magasin de composants Windows) : analyse officielle avec « dism /Online /Cleanup-Image /AnalyzeComponentStore » puis nettoyage avec « /StartComponentCleanup » (admin, plusieurs minutes) — jamais de suppression manuelle dans WinSxS.');
  notesEn.push('WinSxS (Windows component store): official analysis with "dism /Online /Cleanup-Image /AnalyzeComponentStore" then cleanup with "/StartComponentCleanup" (admin, several minutes) — never delete manually inside WinSxS.');

  findings.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    id: 'system',
    title: '🪟 Zones système (hors profil)',
    titleEn: '🪟 System areas (outside the profile)',
    findings, notes, notesEn,
  };
}
