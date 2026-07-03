/**
 * Module 3 — Caches développeur hors AppData.
 *
 * Cible : node_modules orphelins dans les workspaces, caches d'outils dans le
 * home (~/.gradle, ~/.m2, ~/.nuget…), images d'émulateur Android (AVD),
 * disques virtuels WSL/Docker (.vhdx) et dossiers .git volumineux.
 *
 * Choix techniques :
 * - Un node_modules est « orphelin » si le CODE du projet (hors node_modules,
 *   .git, dist…) n'a pas bougé depuis > 6 mois : regénérable par npm install,
 *   donc 🟢. Sinon 🟡 (projet actif, retéléchargement au prochain install).
 * - Les .vhdx ne rétrécissent JAMAIS seuls : on les signale avec la procédure
 *   de compactage officielle, jamais une suppression (ils contiennent les
 *   données Docker/WSL → 🔴 pour la suppression brute).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { measureDir } from './scanner.ts';
import type { Finding, Section } from './types.ts';

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;
const MB = 1024 * 1024;

function rmCmd(p: string): string {
  return `Remove-Item -Recurse -Force "${p}"`;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Trouve les dossiers node_modules et .git sous un workspace (BFS, profondeur limitée). */
async function findRepoDirs(rootPath: string, maxDepth: number): Promise<{ nodeModules: string[]; gits: string[] }> {
  const nodeModules: string[] = [];
  const gits: string[] = [];
  let level: string[] = [rootPath];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const name of await listDirs(dir)) {
        const full = path.join(dir, name);
        if (name === 'node_modules') {
          nodeModules.push(full); // on ne descend pas dedans
        } else if (name === '.git') {
          gits.push(full);
        } else if (!name.startsWith('.')) {
          next.push(full);
        }
      }
    }
    level = next;
  }
  return { nodeModules, gits };
}

/**
 * Date du fichier le plus récent du CODE d'un projet (hors dossiers
 * regénérables) — profondeur limitée : suffisant pour dater l'activité.
 */
const CODE_EXCLUDES = new Set(['node_modules', '.git', 'dist', 'build', '.expo', '.next', 'coverage', 'android', 'ios']);

async function projectNewestMtime(projectDir: string, maxDepth = 3): Promise<number> {
  let newest = 0;
  let level: string[] = [projectDir];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          try {
            const st = await stat(full);
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } catch {
            /* ignoré */
          }
        } else if (e.isDirectory() && !CODE_EXCLUDES.has(e.name.toLowerCase())) {
          next.push(full);
        }
      }
    }
    level = next;
  }
  return newest;
}

/** Cherche les fichiers .vhdx (disques virtuels WSL/Docker) sous un dossier. */
async function findVhdx(rootPath: string, maxDepth: number): Promise<Array<{ path: string; sizeBytes: number; mtimeMs: number }>> {
  const found: Array<{ path: string; sizeBytes: number; mtimeMs: number }> = [];
  let level: string[] = [rootPath];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name.toLowerCase().endsWith('.vhdx')) {
          try {
            const st = await stat(full);
            found.push({ path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
          } catch {
            /* ignoré */
          }
        } else if (e.isDirectory()) {
          next.push(full);
        }
      }
    }
    level = next;
  }
  return found;
}

/** Caches d'outils de dev dans le home : nom → métadonnées. */
const HOME_CACHES: Array<{ rel: string; app: string; note: string }> = [
  { rel: '.gradle\\caches', app: 'Gradle', note: 'Cache de build Android/Java. Retéléchargé au prochain build.' },
  { rel: '.m2\\repository', app: 'Maven', note: 'Dépôt local Maven. Retéléchargé au prochain build.' },
  { rel: '.nuget\\packages', app: 'NuGet', note: 'Cache global .NET. Retéléchargé au prochain restore.' },
  { rel: '.expo', app: 'Expo', note: 'Caches Expo (builds, devices). Recréé automatiquement.' },
  { rel: '.cargo\\registry', app: 'Rust (cargo)', note: 'Registre de crates. Retéléchargé au prochain build.' },
  { rel: '.ollama\\models', app: 'Ollama', note: 'Modèles IA locaux. Retéléchargeables (volumineux) via « ollama pull ».' },
];

/**
 * Scanne les caches de développement : node_modules des workspaces (orphelins
 * si le code n'a pas bougé depuis > 6 mois), caches d'outils du home, images
 * AVD, disques virtuels WSL/Docker et .git volumineux.
 */
export async function scanDevCaches(homeDir: string, workspacesPath: string): Promise<Section> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const now = Date.now();
  const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);

  // --- node_modules et .git des workspaces ---
  if (await exists(workspacesPath)) {
    const { nodeModules, gits } = await findRepoDirs(workspacesPath, 4);

    for (const nm of nodeModules) {
      const st = await measureDir(nm);
      if (st.sizeBytes < 50 * MB) continue;
      const projectDir = path.dirname(nm);
      const codeNewest = await projectNewestMtime(projectDir);
      const staleProject = codeNewest > 0 && now - codeNewest > SIX_MONTHS_MS;
      findings.push({
        label: path.relative(path.dirname(workspacesPath), nm),
        path: nm,
        sizeBytes: st.sizeBytes,
        category: staleProject ? 'green' : 'yellow',
        dataType: 'dépendances npm',
        note: staleProject
          ? `Projet inactif depuis ${iso(codeNewest)} : node_modules regénérable par « npm install » si le projet reprend.`
          : 'Projet actif : supprimable mais « npm install » sera nécessaire au prochain travail dessus.',
        command: rmCmd(nm),
        lastActivity: iso(codeNewest),
      });
    }

    for (const git of gits) {
      const st = await measureDir(git);
      if (st.sizeBytes < 200 * MB) continue;
      const repo = path.dirname(git);
      findings.push({
        label: path.relative(path.dirname(workspacesPath), git),
        path: git,
        sizeBytes: st.sizeBytes,
        category: 'yellow',
        dataType: 'historique Git',
        note: 'Dépôt volumineux : « git gc » compacte l\'historique sans perte. Ne jamais supprimer le dossier .git lui-même.',
        command: `git -C "${repo}" gc --aggressive --prune=now`,
        lastActivity: iso(st.newestMtimeMs),
      });
    }
  } else {
    notes.push(`Dossier workspaces introuvable : ${workspacesPath} (option --workspaces pour le changer).`);
  }

  // --- caches d'outils dans le home ---
  for (const c of HOME_CACHES) {
    const p = path.join(homeDir, c.rel);
    if (!(await exists(p))) continue;
    const st = await measureDir(p);
    if (st.sizeBytes < 20 * MB) continue;
    findings.push({
      label: `~\\${c.rel}`,
      path: p,
      sizeBytes: st.sizeBytes,
      category: 'green',
      dataType: 'cache d\'outil',
      note: c.note,
      command: rmCmd(p),
      lastActivity: iso(st.newestMtimeMs),
    });
  }

  // --- images d'émulateur Android (une entrée par AVD : choix ciblé possible) ---
  const avdRoot = path.join(homeDir, '.android', 'avd');
  for (const name of await listDirs(avdRoot)) {
    if (!name.endsWith('.avd')) continue;
    const p = path.join(avdRoot, name);
    const st = await measureDir(p);
    if (st.sizeBytes < 100 * MB) continue;
    findings.push({
      label: `AVD ${name.replace(/\.avd$/, '')}`,
      path: p,
      sizeBytes: st.sizeBytes,
      category: 'yellow',
      dataType: 'image d\'émulateur Android',
      note: 'Supprimer via le Device Manager d\'Android Studio (pas à la main : un fichier .ini l\'accompagne). L\'émulateur devra être recréé.',
      lastActivity: iso(st.newestMtimeMs),
    });
  }

  // --- disques virtuels WSL / Docker ---
  const localAppData = path.join(homeDir, 'AppData', 'Local');
  const vhdxSpots = [
    path.join(localAppData, 'Docker', 'wsl'),
    path.join(localAppData, 'wsl'),
    path.join(localAppData, 'Packages'),
  ];
  for (const spot of vhdxSpots) {
    // Packages : profondeur 3 pour atteindre <pkg>\LocalState\ext4.vhdx
    for (const v of await findVhdx(spot, 3)) {
      if (v.sizeBytes < 500 * MB) continue;
      findings.push({
        label: path.basename(path.dirname(v.path)) + '\\' + path.basename(v.path),
        path: v.path,
        sizeBytes: v.sizeBytes,
        category: 'red',
        dataType: 'disque virtuel WSL/Docker',
        note: 'Contient les données de la distro/des conteneurs — ne pas supprimer. Un .vhdx ne rétrécit jamais seul : nettoyer dedans (« docker system prune -a ») puis compacter avec « wsl --shutdown » et Optimize-VHD (ou diskpart).',
        command: `wsl --shutdown; Optimize-VHD -Path "${v.path}" -Mode Full  # nécessite Hyper-V ; sinon diskpart /compact`,
        lastActivity: iso(v.mtimeMs),
      });
    }
  }

  findings.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { id: 'dev', title: '🧰 Caches développeur (hors AppData)', findings, notes };
}
