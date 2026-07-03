/**
 * Scanner lecture seule du dossier AppData.
 *
 * Choix techniques :
 * - `readdir` + `stat` asynchrones avec un pool de répertoires concurrents :
 *   la concurrence vient du parallélisme entre répertoires (IO-bound), sans
 *   worker_threads — suffisant pour saturer le disque et bien plus simple.
 * - Les liens symboliques ET jonctions NTFS sont ignorés (libuv les expose
 *   comme symlinks dans les Dirent) pour éviter tout double comptage.
 * - Chaque erreur d'accès (fichier verrouillé, ACL) est ignorée fichier par
 *   fichier : le scan ne s'arrête jamais, il sous-compte au pire de quelques Ko.
 * - On mémorise la date du fichier LE PLUS RÉCENT de chaque dossier : c'est le
 *   critère « application inutilisée depuis > 6 mois » (la date du dossier
 *   lui-même n'est pas fiable pour ça).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface DirStats {
  sizeBytes: number;
  newestMtimeMs: number;
  fileCount: number;
}

export interface ChildEntry {
  name: string;
  path: string;
  sizeBytes: number;
  newestMtimeMs: number;
  fileCount: number;
}

export interface TopEntry {
  /** 'Local' | 'LocalLow' | 'Roaming' */
  root: string;
  name: string;
  path: string;
  sizeBytes: number;
  newestMtimeMs: number;
  fileCount: number;
  children: ChildEntry[];
}

export interface ScanOptions {
  /** Nombre de répertoires lus en parallèle (défaut 32). */
  concurrency?: number;
  /** Callback de progression, appelé après chaque dossier de niveau 1. */
  onProgress?: (entry: TopEntry) => void;
}

/** Mesure récursivement un dossier (taille, date la plus récente, nb fichiers). */
export async function measureDir(dirPath: string, concurrency = 32): Promise<DirStats> {
  const agg: DirStats = { sizeBytes: 0, newestMtimeMs: 0, fileCount: 0 };
  const queue: string[] = [dirPath];
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const dir = queue.pop() as string;
        active++;
        processDir(dir)
          .catch(() => {})
          .finally(() => {
            active--;
            pump();
          });
      }
    };

    const processDir = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // dossier inaccessible : on l'ignore
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        // Jonctions et symlinks : Dirent LINK → ni isDirectory() ni isFile(), donc ignorés
        if (e.isDirectory()) {
          queue.push(full);
        } else if (e.isFile()) {
          try {
            const st = await stat(full);
            agg.sizeBytes += st.size;
            agg.fileCount++;
            if (st.mtimeMs > agg.newestMtimeMs) agg.newestMtimeMs = st.mtimeMs;
          } catch {
            /* fichier verrouillé/inaccessible : ignoré */
          }
        }
      }
    };

    pump();
  });

  return agg;
}

/** Liste les sous-dossiers directs (hors symlinks/jonctions) d'un dossier. */
async function listSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Taille des fichiers posés directement dans un dossier (sans récursion). */
async function measureLooseFiles(dirPath: string): Promise<DirStats> {
  const agg: DirStats = { sizeBytes: 0, newestMtimeMs: 0, fileCount: 0 };
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = await stat(path.join(dirPath, e.name));
        agg.sizeBytes += st.size;
        agg.fileCount++;
        if (st.mtimeMs > agg.newestMtimeMs) agg.newestMtimeMs = st.mtimeMs;
      } catch {
        /* ignoré */
      }
    }
  } catch {
    /* ignoré */
  }
  return agg;
}

/**
 * Scanne les trois branches d'AppData et retourne les dossiers de niveau 1
 * avec le détail de leurs enfants de niveau 2.
 *
 * Un seul parcours du disque : les tailles de niveau 2 sont calculées puis
 * agrégées pour obtenir le niveau 1 (pas de double énumération).
 */
export async function scanAppData(appDataPath: string, opts: ScanOptions = {}): Promise<TopEntry[]> {
  const concurrency = opts.concurrency ?? 32;
  const roots = ['Local', 'LocalLow', 'Roaming'];
  const results: TopEntry[] = [];

  for (const root of roots) {
    const rootPath = path.join(appDataPath, root);
    for (const l1Name of await listSubdirs(rootPath)) {
      const l1Path = path.join(rootPath, l1Name);
      const loose = await measureLooseFiles(l1Path);
      let sizeBytes = loose.sizeBytes;
      let newest = loose.newestMtimeMs;
      let fileCount = loose.fileCount;
      const children: ChildEntry[] = [];

      for (const l2Name of await listSubdirs(l1Path)) {
        const l2Path = path.join(l1Path, l2Name);
        const st = await measureDir(l2Path, concurrency);
        sizeBytes += st.sizeBytes;
        fileCount += st.fileCount;
        if (st.newestMtimeMs > newest) newest = st.newestMtimeMs;
        children.push({
          name: l2Name,
          path: l2Path,
          sizeBytes: st.sizeBytes,
          newestMtimeMs: st.newestMtimeMs,
          fileCount: st.fileCount,
        });
      }

      children.sort((a, b) => b.sizeBytes - a.sizeBytes);
      const entry: TopEntry = { root, name: l1Name, path: l1Path, sizeBytes, newestMtimeMs: newest, fileCount, children };
      results.push(entry);
      opts.onProgress?.(entry);
    }
  }

  results.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return results;
}
