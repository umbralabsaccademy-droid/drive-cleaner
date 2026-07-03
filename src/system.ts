/**
 * Module 2 — Zones temporaires et regénérables du système.
 *
 * Couvre ce que fait l'outil « Nettoyage de disque » de Windows, mais en
 * expliquant chaque poste : restes de Windows Update, corbeille, dumps de
 * crash, rapports d'erreurs, cache d'Optimisation de la distribution,
 * Windows.old, hiberfil.sys/pagefile.sys, points de restauration.
 *
 * Choix techniques :
 * - Certaines zones exigent une élévation admin : on détecte le niveau
 *   d'élévation (via `fltmc`, qui échoue proprement sans droits) et on marque
 *   « inaccessible sans admin » plutôt que d'échouer.
 * - Les recommandations privilégient les OUTILS OFFICIELS (cleanmgr, powercfg,
 *   Clear-RecycleBin, dism) plutôt qu'un Remove-Item brutal quand un service
 *   dépend du dossier (ex. SoftwareDistribution → arrêter wuauserv d'abord).
 */
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { measureDir } from './scanner.ts';
import type { Finding, Section } from './types.ts';
import type { Category } from './knowledge.ts';

const MB = 1024 * 1024;

/** Le processus est-il élevé (admin) ? `fltmc` échoue sans élévation. */
export function isElevated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('fltmc.exe', [], { windowsHide: true, timeout: 10_000 }, (err) => resolve(!err));
  });
}

interface AreaDef {
  path: string;
  label: string;
  dataType: string;
  category: Category;
  note: string;
  command?: string;
  /** Zone lisible uniquement en admin (sinon taille partielle/nulle). */
  needsAdmin?: boolean;
  /** Seuil d'affichage en octets (défaut 10 Mo). */
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
      path: path.join(windir, 'Temp'), label: 'Windows\\Temp', dataType: 'temporaires', category: 'green',
      note: 'Temporaires système. Vider le contenu (les fichiers en cours d\'usage resteront verrouillés, c\'est normal).',
      command: `Get-ChildItem "${path.join(windir, 'Temp')}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      needsAdmin: true,
    },
    {
      path: path.join(windir, 'SoftwareDistribution', 'Download'), label: 'SoftwareDistribution\\Download',
      dataType: 'téléchargements Windows Update', category: 'green',
      note: 'Paquets de mises à jour déjà installées. Arrêter le service Windows Update avant, il retélécharge au besoin.',
      command: `Stop-Service wuauserv; Remove-Item "${path.join(windir, 'SoftwareDistribution', 'Download')}\\*" -Recurse -Force; Start-Service wuauserv`,
      needsAdmin: true,
    },
    {
      path: path.join(windir, 'Minidump'), label: 'Windows\\Minidump', dataType: 'dumps de crash', category: 'green',
      note: 'Mini-dumps d\'écrans bleus. Utiles uniquement pour diagnostiquer un crash passé.',
      command: `Remove-Item "${path.join(windir, 'Minidump')}\\*" -Force`, needsAdmin: true,
    },
    {
      path: path.join(programData, 'Microsoft', 'Windows', 'WER'), label: 'Rapports d\'erreurs (WER)',
      dataType: 'rapports de crash', category: 'green',
      note: 'Rapports d\'erreurs Windows en attente/archivés. Recréés au prochain plantage.',
      command: 'cleanmgr  # cocher « Fichiers de rapport d\'erreurs Windows »', needsAdmin: true,
    },
    {
      path: path.join(windir, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache'),
      label: 'Optimisation de la distribution', dataType: 'cache de mises à jour P2P', category: 'green',
      note: 'Cache de partage des mises à jour entre PC. Vidage propre via la commande dédiée.',
      command: 'Delete-DeliveryOptimizationCache -Force', needsAdmin: true,
    },
    {
      path: path.join(sysDrive, '\\', 'Windows.old'), label: 'Windows.old', dataType: 'ancienne installation Windows',
      category: 'green',
      note: 'Ancienne installation conservée après une mise à niveau (rollback possible tant qu\'il existe). Supprimer via l\'outil officiel uniquement.',
      command: 'cleanmgr  # cocher « Installation(s) de Windows précédente(s) »', needsAdmin: true,
    },
    {
      path: path.join(sysDrive, '\\', '$Recycle.Bin'), label: 'Corbeille (tous volumes)', dataType: 'fichiers supprimés',
      category: 'yellow',
      note: 'Vider la corbeille rend la récupération des fichiers supprimés impossible.',
      command: 'Clear-RecycleBin -Force', needsAdmin: true, minBytes: 1 * MB,
    },
  ];

  const findings: Finding[] = [];
  const notes: string[] = [];

  for (const a of areas) {
    const st = await measureDir(a.path);
    const min = a.minBytes ?? 10 * MB;
    if (st.sizeBytes === 0 && st.fileCount === 0) {
      // Soit vide/absent, soit illisible sans admin : ne signaler que le second cas
      if (a.needsAdmin && !admin) notes.push(`« ${a.label} » non mesurable sans droits admin — relancer le scan en administrateur pour la taille exacte.`);
      continue;
    }
    if (st.sizeBytes < min) continue;
    findings.push({
      label: a.label, path: a.path, sizeBytes: st.sizeBytes, category: a.category,
      dataType: a.dataType, note: a.note + (a.needsAdmin ? ' (commande à lancer en admin)' : ''),
      command: a.command,
      lastActivity: st.newestMtimeMs > 0 ? new Date(st.newestMtimeMs).toISOString().slice(0, 10) : null,
    });
  }

  // --- fichiers système uniques (pas de suppression directe : réglage officiel) ---
  const singleFiles: Array<{ p: string; label: string; category: Category; dataType: string; note: string; command?: string }> = [
    {
      p: path.join(sysDrive, '\\', 'hiberfil.sys'), label: 'hiberfil.sys (veille prolongée)', category: 'yellow',
      dataType: 'fichier système', note: 'Désactiver la veille prolongée récupère cet espace (≈ 40 % de la RAM). Conséquence : plus d\'hibernation ni de « démarrage rapide ».',
      command: 'powercfg /h off  # en admin ; réversible avec powercfg /h on',
    },
    {
      p: path.join(sysDrive, '\\', 'pagefile.sys'), label: 'pagefile.sys (mémoire virtuelle)', category: 'red',
      dataType: 'fichier système', note: 'Nécessaire au système. Ne pas supprimer ; taille gérée automatiquement par Windows.',
    },
    {
      p: path.join(windir, 'MEMORY.DMP'), label: 'MEMORY.DMP (dump complet)', category: 'green',
      dataType: 'dump de crash', note: 'Image mémoire du dernier écran bleu. Supprimable si le crash est résolu.',
      command: `Remove-Item "${path.join(windir, 'MEMORY.DMP')}" -Force  # en admin`,
    },
  ];
  for (const f of singleFiles) {
    try {
      const st = await stat(f.p);
      if (st.size < 10 * MB) continue;
      findings.push({
        label: f.label, path: f.p, sizeBytes: st.size, category: f.category, dataType: f.dataType,
        note: f.note, command: f.command, lastActivity: new Date(st.mtimeMs).toISOString().slice(0, 10),
      });
    } catch {
      /* absent : rien à signaler */
    }
  }

  // --- points de restauration (VSS) : mesure via vssadmin, admin requis ---
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
        category: 'yellow', dataType: 'restauration système',
        note: 'Supprimer les anciens points garde la protection mais libère l\'espace. Conséquence : impossible de restaurer à une date antérieure.',
        command: 'vssadmin delete shadows /for=C: /oldest  # ou régler le quota dans Protection du système',
      });
    }
  } else {
    notes.push('Points de restauration (VSS) et WinSxS non analysés : relancer en admin pour les mesurer.');
  }

  notes.push('WinSxS (magasin de composants Windows) : analyse officielle avec « dism /Online /Cleanup-Image /AnalyzeComponentStore » puis nettoyage avec « /StartComponentCleanup » (admin, plusieurs minutes) — jamais de suppression manuelle dans WinSxS.');

  findings.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { id: 'system', title: '🪟 Zones système (hors profil)', findings, notes };
}
