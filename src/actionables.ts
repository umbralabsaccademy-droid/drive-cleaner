/**
 * Transforme l'analyse en liste d'éléments ACTIONNABLES pour le nettoyage
 * assisté, avec les garde-fous du mode simple.
 *
 * Choix techniques :
 * - `deletePath`/`deleteMode` sont extraits des commandes générées par la base
 *   de connaissances (Remove-Item "<chemin>" ou Get-ChildItem "<chemin>" |…) :
 *   une seule source de vérité, pas de duplication des règles. Une commande
 *   non « pure suppression » (npm, nvm, winget, Optimize-VHD…) rend l'élément
 *   NON nettoyable par l'outil — affichée à titre indicatif seulement.
 * - `simple` (proposé aux novices) exige TOUT à la fois : catégorie 🟢, règle
 *   connue (pas d'heuristique sur un inconnu) et suppression pure. Les modules
 *   dev sont exclus du mode simple, le système n'y garde que ses 🟢.
 * - Libellés « grand public » générés depuis le type de données : pas de
 *   jargon (cache, MSIX, node_modules) dans le mode simple.
 */
import type { Analysis } from './report.ts';
import type { Category, Classification } from './knowledge.ts';

export interface Actionable {
  id: number;
  /** Libellé technique (mode expert). */
  label: string;
  /** Libellé grand public (mode simple). */
  friendlyLabel: string;
  friendlyNote: string;
  path: string;
  sizeBytes: number;
  category: Category;
  /** Mode de nettoyage : dossier entier, contenu seulement, ou non nettoyable. */
  deleteMode: 'dir' | 'contents' | null;
  deletePath: string | null;
  /** Proposé en mode simple (novices). */
  simple: boolean;
  /** Nécessite une élévation admin (zones système). */
  needsAdmin: boolean;
  command?: string;
}

const MB = 1024 * 1024;
const RM_CONTENTS_RE = /Get-ChildItem "([^"]+)" \| Remove-Item/;
const RM_DIR_RE = /Remove-Item(?: -Recurse)? -Force "([^"]+)"|Remove-Item "([^"]+)" -Recurse -Force/;

/** Remplace les $env:VAR des commandes par leur valeur réelle. */
function expandEnv(p: string): string {
  return p.replace(/\$env:(\w+)/gi, (_, name: string) => process.env[name] ?? `$env:${name}`);
}

function parseDelete(command?: string): { mode: 'dir' | 'contents'; target: string } | null {
  if (!command) return null;
  const c = command.match(RM_CONTENTS_RE);
  if (c) return { mode: 'contents', target: expandEnv(c[1]) };
  const d = command.match(RM_DIR_RE);
  if (d) return { mode: 'dir', target: expandEnv(d[1] ?? d[2]) };
  return null;
}

/** Libellé grand public à partir du type de données et de l'application. */
function friendly(app: string, dataType: string, autoRecreated: boolean): { label: string; note: string } {
  const t = dataType.toLowerCase();
  const recree = autoRecreated
    ? 'Sans danger : ils seront recréés automatiquement si besoin.'
    : 'Sans danger pour vos documents et réglages.';
  if (t.includes('installeurs de mise à jour')) {
    return { label: `Anciens fichiers de mise à jour — ${app}`, note: `Des copies d'installation déjà utilisées. ${recree}` };
  }
  if (t.includes('restes')) {
    return { label: `Restes d'un programme désinstallé — ${app}`, note: 'Ce programme n\'est plus installé : ces fichiers ne servent plus à rien.' };
  }
  if (t.includes('cache')) {
    return { label: `Fichiers temporaires — ${app}`, note: `${app} garde des copies pour aller plus vite ; il les refera tout seul. ${recree}` };
  }
  if (t.includes('dumps') || t.includes('rapports de crash') || t.includes('télémétrie') || t.includes('logs')) {
    return { label: `Rapports techniques — ${app}`, note: `Des fichiers de diagnostic qui ne servent plus. ${recree}` };
  }
  if (t.includes('windows update') || t.includes('mises à jour')) {
    return { label: 'Restes de mises à jour Windows', note: 'Les mises à jour sont déjà installées : ces copies ne servent plus.' };
  }
  if (t.includes('temporaires') || t.includes('fichiers supprimés')) {
    return { label: `Fichiers temporaires — ${app}`, note: `Des fichiers de travail provisoires. ${recree}` };
  }
  if (t.includes('cache')) {
    return { label: `Fichiers temporaires — ${app}`, note: `${app} garde des copies pour aller plus vite ; il les refera tout seul. ${recree}` };
  }
  return { label: `Fichiers de ${app}`, note: recree };
}

/**
 * Construit la liste triée (taille décroissante) des éléments actionnables
 * à partir de l'analyse : entrées AppData 🟢 entières, enfants actionnables
 * des dossiers mixtes, puis findings des modules complémentaires.
 */
export function buildActionables(a: Analysis): Actionable[] {
  const list: Actionable[] = [];
  let id = 0;

  const push = (label: string, path: string, sizeBytes: number, cls: Classification, opts: { simpleAllowed?: boolean; needsAdmin?: boolean } = {}): void => {
    if (sizeBytes < 5 * MB) return; // en dessous : bruit
    const del = parseDelete(cls.command);
    const f = friendly(cls.app, cls.dataType, cls.autoRecreated);
    list.push({
      id: id++,
      label,
      friendlyLabel: f.label,
      friendlyNote: f.note,
      path,
      sizeBytes,
      category: cls.category,
      deleteMode: del?.mode ?? null,
      deletePath: del?.target ?? null,
      simple: (opts.simpleAllowed ?? true) && cls.category === 'green' && del !== null && (cls.known ?? false) && !(opts.needsAdmin ?? false),
      needsAdmin: opts.needsAdmin ?? false,
      command: cls.command,
    });
  };

  // --- AppData : 🟢 entiers, puis enfants actionnables des dossiers mixtes ---
  for (const e of a.entries) {
    const cls = e.classification;
    if (cls.category === 'green') {
      push(`${e.root}\\${e.name}`, e.path, e.sizeBytes, cls);
    } else {
      for (const c of e.children) {
        const cc = c.classification;
        if ((cc.category === 'green' || cc.category === 'yellow') && cc.command) {
          push(`${e.root}\\${e.name}\\${c.name}`, c.path, c.sizeBytes, cc);
        }
      }
      if (cls.category === 'yellow' && cls.command) {
        push(`${e.root}\\${e.name}`, e.path, e.sizeBytes, cls);
      }
    }
  }

  // --- Modules complémentaires ---
  for (const s of a.sections) {
    for (const f of s.findings) {
      if (f.category === 'red' || !f.command) continue;
      const pseudo: Classification = {
        category: f.category, app: f.label, dataType: f.dataType,
        note: f.note, autoRecreated: true, command: f.command, known: true,
      };
      // dev : jamais en mode simple (un novice n'a rien à faire dans node_modules) ;
      // system : 🟢 éligibles mais souvent admin — signalé.
      const needsAdmin = s.id === 'system' && /admin/i.test(f.note + (f.command ?? ''));
      push(f.label, f.path, f.sizeBytes, pseudo, { simpleAllowed: s.id === 'system', needsAdmin });
    }
  }

  list.sort((x, y) => y.sizeBytes - x.sizeBytes);
  return list;
}
