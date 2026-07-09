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
  /** Versions anglaises des libellés grand public. */
  friendlyLabelEn: string;
  friendlyNoteEn: string;
  /** Notes techniques (mode expert), FR + EN. */
  note: string;
  noteEn: string;
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
  /** Issu du module traces d'activité/confidentialité (regroupement UI). */
  privacy: boolean;
  /** À quoi sert ce fichier (pédagogie, distinct de friendlyNote/note qui portent la conséquence). */
  purpose?: string;
  purposeEn?: string;
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

/** Libellés grand public (FR + EN) à partir du type de données et de l'application. */
function friendly(app: string, dataType: string, autoRecreated: boolean): { label: string; note: string; labelEn: string; noteEn: string } {
  const t = dataType.toLowerCase();
  const recree = autoRecreated
    ? 'Sans danger : ils seront recréés automatiquement si besoin.'
    : 'Sans danger pour vos documents et réglages.';
  const safeEn = autoRecreated
    ? 'Safe: they will be recreated automatically if needed.'
    : 'Safe for your documents and settings.';
  if (t.includes('installeurs de mise à jour')) {
    return {
      label: `Anciens fichiers de mise à jour — ${app}`, note: `Des copies d'installation déjà utilisées. ${recree}`,
      labelEn: `Old update files — ${app}`, noteEn: `Installer copies that were already used. ${safeEn}`,
    };
  }
  if (t.includes('restes')) {
    return {
      label: `Restes d'un programme désinstallé — ${app}`, note: 'Ce programme n\'est plus installé : ces fichiers ne servent plus à rien.',
      labelEn: `Leftovers from an uninstalled program — ${app}`, noteEn: 'This program is no longer installed: these files serve no purpose anymore.',
    };
  }
  if (t.includes('cache')) {
    return {
      label: `Fichiers temporaires — ${app}`, note: `${app} garde des copies pour aller plus vite ; il les refera tout seul. ${recree}`,
      labelEn: `Temporary files — ${app}`, noteEn: `${app} keeps copies to run faster; it will rebuild them on its own. ${safeEn}`,
    };
  }
  if (t.includes('dumps') || t.includes('rapports de crash') || t.includes('télémétrie') || t.includes('logs')) {
    return {
      label: `Rapports techniques — ${app}`, note: `Des fichiers de diagnostic qui ne servent plus. ${recree}`,
      labelEn: `Technical reports — ${app}`, noteEn: `Diagnostic files that are no longer needed. ${safeEn}`,
    };
  }
  if (t.includes('windows update') || t.includes('mises à jour')) {
    return {
      label: 'Restes de mises à jour Windows', note: 'Les mises à jour sont déjà installées : ces copies ne servent plus.',
      labelEn: 'Windows Update leftovers', noteEn: 'The updates are already installed: these copies are no longer needed.',
    };
  }
  if (t.includes('temporaires') || t.includes('fichiers supprimés')) {
    return {
      label: `Fichiers temporaires — ${app}`, note: `Des fichiers de travail provisoires. ${recree}`,
      labelEn: `Temporary files — ${app}`, noteEn: `Short-lived working files. ${safeEn}`,
    };
  }
  return { label: `Fichiers de ${app}`, note: recree, labelEn: `${app} files`, noteEn: safeEn };
}

/**
 * Libellés grand public pour les traces d'activité/confidentialité :
 * contrairement à `friendly()`, on assume ici le compromis réel (déconnexion
 * de sites, historique effacé) plutôt que le réflexe « sans danger ».
 */
function friendlyPrivacy(dataType: string): { label: string; note: string; labelEn: string; noteEn: string } | null {
  const t = dataType.toLowerCase();
  if (t.includes('cookies')) {
    return {
      label: 'Cookies (sessions des sites)', labelEn: 'Cookies (site sessions)',
      note: '⚠️ Vous serez déconnecté(e) des sites où vous étiez connecté(e) : reconnexion nécessaire partout.',
      noteEn: '⚠️ You will be signed out of websites you were logged into: you\'ll need to log back in everywhere.',
    };
  }
  if (t.includes('historique de navigation') || t.includes('browsing history')) {
    return {
      label: 'Historique de navigation', labelEn: 'Browsing history',
      note: 'Efface les adresses visitées, recherches et téléchargements. Récupérable depuis la Corbeille pendant ~30 jours.',
      noteEn: 'Clears visited addresses, searches and downloads. Recoverable from the Recycle Bin for about 30 days.',
    };
  }
  if (t.includes('favicon')) {
    return {
      label: 'Icônes des sites visités', labelEn: 'Visited-site icons',
      note: 'Corrélées à l\'historique de navigation ; se rechargent à la prochaine visite.',
      noteEn: 'Correlated with browsing history; reload themselves on the next visit.',
    };
  }
  if (t.includes('sites les plus visités') || t.includes('most-visited')) {
    return {
      label: 'Raccourcis vers vos sites fréquents', labelEn: 'Shortcuts to your frequent sites',
      note: 'Juste la page « nouvel onglet » ; sans conséquence sur vos comptes.',
      noteEn: 'Just the "new tab" page; no effect on your accounts.',
    };
  }
  if (t.includes('restauration de session') || t.includes('session restore')) {
    return {
      label: 'Onglets ouverts (restauration de session)', labelEn: 'Open tabs (session restore)',
      note: 'Les onglets actuellement ouverts ne pourront pas être restaurés après un prochain plantage du navigateur.',
      noteEn: 'Currently open tabs will not be restorable after the browser\'s next crash.',
    };
  }
  if (t.includes('données posées par les sites') || t.includes('site-set data')) {
    return {
      label: 'Stockage local des sites', labelEn: 'Site local storage',
      note: 'Équivalent des cookies posé par le site lui-même : certains sites vous redemanderont de vous reconnecter.',
      noteEn: 'Cookie-like data set by the site itself: some sites will ask you to log back in.',
    };
  }
  if (t.includes('historique d\'exécution') || t.includes('execution history')) {
    return {
      label: 'Historique de lancement des programmes (Prefetch)', labelEn: 'Program launch history (Prefetch)',
      note: 'Windows le régénère tout seul ; léger ralentissement au prochain lancement des programmes concernés.',
      noteEn: 'Windows regenerates it on its own; a slight slowdown on the next launch of the programs involved.',
    };
  }
  if (t.includes('fichiers et documents récemment ouverts') || t.includes('recently opened files & documents')) {
    return {
      label: 'Fichiers récents & Jump Lists', labelEn: 'Recent files & Jump Lists',
      note: 'Vide le menu « Récents » (Démarrer/Explorateur) et les listes de documents récents affichées au clic droit sur une icône de la barre des tâches ; se reconstruit à l\'usage.',
      noteEn: 'Clears the "Recent" list (Start/Explorer) and the recent-document lists shown when right-clicking a taskbar icon; rebuilds itself as you use your PC.',
    };
  }
  if (t.includes('miniatures') || t.includes('thumbnails')) {
    return {
      label: 'Cache de miniatures', labelEn: 'Thumbnail cache',
      note: 'Les vignettes réapparaîtront à la prochaine consultation des dossiers concernés.',
      noteEn: 'Thumbnails will reappear the next time you browse the folders concerned.',
    };
  }
  if (t.includes('timeline')) {
    return {
      label: 'Historique d\'activité (Timeline)', labelEn: 'Activity history (Timeline)',
      note: 'Efface l\'historique de ce que vous avez ouvert et quand.',
      noteEn: 'Clears the history of what you opened and when.',
    };
  }
  if (t.includes('presse-papiers') || t.includes('copied content')) {
    return {
      label: 'Historique du presse-papiers', labelEn: 'Clipboard history',
      note: 'Efface l\'historique du presse-papiers (Win+V), y compris les éléments épinglés.',
      noteEn: 'Clears clipboard history (Win+V), including pinned items.',
    };
  }
  if (t.includes('saisies de formulaires') || t.includes('form entries')) {
    return {
      label: 'Historique de formulaires', labelEn: 'Form entry history',
      note: 'Efface l\'auto-complétion des formulaires déjà remplis (pas les mots de passe).',
      noteEn: 'Clears autocomplete suggestions from previously filled forms (not passwords).',
    };
  }
  return null;
}

/**
 * Construit la liste triée (taille décroissante) des éléments actionnables
 * à partir de l'analyse : entrées AppData 🟢 entières, enfants actionnables
 * des dossiers mixtes, puis findings des modules complémentaires.
 */
export function buildActionables(a: Analysis): Actionable[] {
  const list: Actionable[] = [];
  let id = 0;

  const push = (label: string, path: string, sizeBytes: number, cls: Classification, opts: { simpleAllowed?: boolean; needsAdmin?: boolean; simpleCategories?: Category[]; privacy?: boolean; minBytes?: number; purpose?: string; purposeEn?: string } = {}): void => {
    // En dessous : bruit. Les traces de confidentialité comptent quelle que soit
    // leur taille (l'enjeu n'est pas l'espace disque) : seuil très bas, pas 5 Mo.
    if (sizeBytes < (opts.minBytes ?? 5 * MB)) return;
    const del = parseDelete(cls.command);
    const f = (opts.privacy ? friendlyPrivacy(cls.dataType) : null) ?? friendly(cls.app, cls.dataType, cls.autoRecreated);
    const simpleCats = opts.simpleCategories ?? ['green'];
    list.push({
      id: id++,
      label,
      friendlyLabel: f.label,
      friendlyNote: f.note,
      friendlyLabelEn: f.labelEn,
      friendlyNoteEn: f.noteEn,
      note: cls.note,
      noteEn: cls.noteEn ?? cls.note,
      path,
      sizeBytes,
      category: cls.category,
      deleteMode: del?.mode ?? null,
      deletePath: del?.target ?? null,
      simple: (opts.simpleAllowed ?? true) && simpleCats.includes(cls.category) && del !== null && (cls.known ?? false) && !(opts.needsAdmin ?? false),
      needsAdmin: opts.needsAdmin ?? false,
      privacy: opts.privacy ?? false,
      purpose: opts.purpose,
      purposeEn: opts.purposeEn,
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
        category: f.category, app: f.label, dataType: f.dataType, dataTypeEn: f.dataTypeEn,
        note: f.note, noteEn: f.noteEn, autoRecreated: true, command: f.command, known: true,
      };
      // dev : jamais en mode simple (un novice n'a rien à faire dans node_modules) ;
      // system : 🟢 éligibles mais souvent admin — signalé ;
      // privacy : 🟢/🟡 éligibles (avec avertissement dédié), aussi souvent admin (Prefetch).
      const isPrivacy = s.id === 'privacy';
      const isSystem = s.id === 'system';
      const needsAdmin = (isSystem || isPrivacy) && /admin/i.test(f.note + (f.command ?? ''));
      push(f.label, f.path, f.sizeBytes, pseudo, {
        simpleAllowed: isSystem || isPrivacy,
        needsAdmin,
        simpleCategories: isPrivacy ? ['green', 'yellow'] : ['green'],
        privacy: isPrivacy,
        minBytes: isPrivacy ? 1024 : undefined,
        purpose: f.purpose,
        purposeEn: f.purposeEn,
      });
    }
  }

  list.sort((x, y) => y.sizeBytes - x.sizeBytes);
  return list;
}
