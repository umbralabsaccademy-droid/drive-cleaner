/**
 * Détection des « miroirs » MSIX : les applications packagées (Store/MSIX)
 * voient leur %APPDATA% redirigé vers Local\Packages\<pkg>\LocalCache\Roaming.
 * Selon le mode d'installation, le même contenu PHYSIQUE peut apparaître à la
 * fois sous Roaming\<App> et sous Packages\<pkg>\LocalCache\Roaming\<App> —
 * il serait alors compté deux fois dans le total.
 *
 * Choix technique : on compare l'identité physique d'un fichier échantillon
 * via son numéro d'inode NTFS (`stat({ bigint: true }).ino`) — équivalent de
 * `fsutil hardlink list`, mais sans processus externe. Même ino + même volume
 * = même fichier sur disque = miroir confirmé.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TopEntry } from './scanner.ts';

export interface MsixMirror {
  /** Nom du dossier côté Roaming (ex. « Claude »). */
  roamingName: string;
  /** Nom du package côté Local\Packages (ex. « Claude_pzs8sxrjxfjjc »). */
  packageName: string;
  /** Taille comptée en double (octets) — celle du dossier Roaming. */
  duplicatedBytes: number;
}

/** Premier fichier trouvé en profondeur limitée (échantillon d'identité). */
async function firstFile(dir: string, maxDepth: number): Promise<string | null> {
  if (maxDepth < 0) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await firstFile(path.join(dir, e.name), maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Deux chemins pointent-ils vers le même fichier physique (inode NTFS) ? */
async function samePhysicalFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0n;
  } catch {
    return false;
  }
}

/**
 * Croise les dossiers Roaming\* avec Local\Packages\*\LocalCache\Roaming\*
 * et confirme les miroirs par identité physique d'un fichier échantillon.
 */
export async function findMsixMirrors(appDataPath: string, entries: TopEntry[]): Promise<MsixMirror[]> {
  const packagesPath = path.join(appDataPath, 'Local', 'Packages');
  let packageNames: string[];
  try {
    packageNames = (await readdir(packagesPath, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const roamingEntries = new Map(
    entries.filter((e) => e.root === 'Roaming').map((e) => [e.name.toLowerCase(), e]),
  );

  const mirrors: MsixMirror[] = [];
  for (const pkg of packageNames) {
    const redirected = path.join(packagesPath, pkg, 'LocalCache', 'Roaming');
    let candidates: string[];
    try {
      candidates = (await readdir(redirected, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // pas de redirection pour ce package
    }
    for (const name of candidates) {
      const roamingEntry = roamingEntries.get(name.toLowerCase());
      if (!roamingEntry) continue;
      const sampleA = await firstFile(roamingEntry.path, 4);
      if (!sampleA) continue;
      // Reconstruit le chemin équivalent côté Packages pour le même fichier
      const relative = path.relative(roamingEntry.path, sampleA);
      const sampleB = path.join(redirected, name, relative);
      if (await samePhysicalFile(sampleA, sampleB)) {
        mirrors.push({ roamingName: roamingEntry.name, packageName: pkg, duplicatedBytes: roamingEntry.sizeBytes });
      }
    }
  }
  return mirrors;
}
