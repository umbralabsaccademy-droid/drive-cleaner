/**
 * Module — Traces d'activité & confidentialité.
 *
 * Couvre ce qui trace l'usage du PC (pas l'espace disque) : Prefetch,
 * fichiers/Jump Lists récents, cache de miniatures, Timeline, presse-papiers,
 * et — côté navigateurs (Chrome, Edge, Firefox) — cookies, historique,
 * favicons, sites fréquents, sessions et stockage de site.
 *
 * Choix techniques :
 * - Les caches navigateur (Cache/Code Cache/GPUCache/cache2) sont déjà
 *   couverts par knowledge.ts au niveau du dossier : pas dupliqués ici.
 * - Mots de passe (Login Data) et formulaires/paiement (Web Data) sont
 *   listés mais SANS commande : ce n'est pas du traçage mais une donnée
 *   précieuse, jamais proposée à la suppression par cet outil.
 * - places.sqlite (Firefox) mélange historique ET favoris dans un seul
 *   fichier : catégorie 🔴, sans commande, avertissement explicite.
 * - Un navigateur détecté en cours d'exécution (tasklist) ajoute un
 *   avertissement dans les notes de section : ses fichiers seront verrouillés.
 * - Section id 'privacy' (≠ 'system') : exclue du mode simple (1 clic) par
 *   construction (voir actionables.ts), le nettoyage reste une action
 *   explicite en mode Expert.
 */
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { measureDir } from './scanner.ts';
import type { Finding, Section } from './types.ts';
import type { Category } from './knowledge.ts';

interface AreaBase {
  label: string;
  category: Category;
  dataType: string;
  dataTypeEn: string;
  note: string;
  noteEn: string;
  command?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Une image est-elle en cours d'exécution ? (tasklist, sans droits admin) */
function isProcessRunning(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${imageName}`, '/NH'],
      { windowsHide: true, timeout: 10_000 },
      (_err, stdout) => resolve((stdout ?? '').toLowerCase().includes(imageName.toLowerCase())),
    );
  });
}

/** Somme les fichiers d'un dossier (sans récursion) correspondant à un motif. */
async function sumMatching(dir: string, pattern: RegExp): Promise<{ sizeBytes: number; newestMtimeMs: number }> {
  const agg = { sizeBytes: 0, newestMtimeMs: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return agg; // absent, ou lecture refusée sans admin
  }
  for (const e of entries) {
    if (!e.isFile() || !pattern.test(e.name)) continue;
    try {
      const st = await stat(path.join(dir, e.name));
      agg.sizeBytes += st.size;
      if (st.mtimeMs > agg.newestMtimeMs) agg.newestMtimeMs = st.mtimeMs;
    } catch {
      /* ignoré */
    }
  }
  return agg;
}

async function pushFile(findings: Finding[], p: string, a: AreaBase): Promise<void> {
  try {
    const st = await stat(p);
    if (st.size === 0) return;
    findings.push({
      label: a.label, path: p, sizeBytes: st.size, category: a.category,
      dataType: a.dataType, dataTypeEn: a.dataTypeEn, note: a.note, noteEn: a.noteEn, command: a.command,
      lastActivity: new Date(st.mtimeMs).toISOString().slice(0, 10),
    });
  } catch {
    /* absent : rien à signaler */
  }
}

async function pushDir(findings: Finding[], p: string, a: AreaBase): Promise<void> {
  const st = await measureDir(p);
  if (st.sizeBytes === 0) return;
  findings.push({
    label: a.label, path: p, sizeBytes: st.sizeBytes, category: a.category,
    dataType: a.dataType, dataTypeEn: a.dataTypeEn, note: a.note, noteEn: a.noteEn, command: a.command,
    lastActivity: st.newestMtimeMs > 0 ? new Date(st.newestMtimeMs).toISOString().slice(0, 10) : null,
  });
}

async function pushGlob(findings: Finding[], dir: string, pattern: RegExp, a: AreaBase): Promise<void> {
  const agg = await sumMatching(dir, pattern);
  if (agg.sizeBytes === 0) return;
  findings.push({
    label: a.label, path: dir, sizeBytes: agg.sizeBytes, category: a.category,
    dataType: a.dataType, dataTypeEn: a.dataTypeEn, note: a.note, noteEn: a.noteEn, command: a.command,
    lastActivity: agg.newestMtimeMs > 0 ? new Date(agg.newestMtimeMs).toISOString().slice(0, 10) : null,
  });
}

/** Navigateurs à base Chromium (Chrome, Edge) : mêmes noms de fichiers de profil. */
async function scanChromium(
  label: string, root: string, processName: string,
  findings: Finding[], notes: string[], notesEn: string[],
): Promise<void> {
  if (!(await exists(root))) return;
  if (await isProcessRunning(processName)) {
    notes.push(`${label} est en cours d'exécution : ses fichiers de traçage (cookies, historique…) sont verrouillés et ne pourront pas être nettoyés tant qu'il n'est pas fermé.`);
    notesEn.push(`${label} is currently running: its tracking files (cookies, history…) are locked and cannot be cleaned until it is closed.`);
  }

  const profiles = (await listSubdirs(root)).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
  for (const profile of profiles) {
    const base = path.join(root, profile);
    const tag = profile === 'Default' ? '' : ` (${profile})`;
    const lbl = (dt: string): string => `${label}${tag} — ${dt}`;

    // Chrome récent a déplacé Cookies sous Network\ ; on prend celui qui existe.
    const cookiesNew = path.join(base, 'Network', 'Cookies');
    const cookiesOld = path.join(base, 'Cookies');
    const cookiesPath = (await exists(cookiesNew)) ? cookiesNew : cookiesOld;
    await pushFile(findings, cookiesPath, {
      label: lbl('Cookies'), category: 'yellow',
      dataType: 'cookies (sessions, traceurs)', dataTypeEn: 'cookies (sessions, trackers)',
      note: 'Ferme vos sessions ouvertes sur les sites (reconnexion nécessaire). Ne touche pas aux favoris ni aux mots de passe.',
      noteEn: 'Signs you out of open sessions on websites (you will need to log back in). Does not affect bookmarks or passwords.',
      command: `Remove-Item "${cookiesPath}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushFile(findings, path.join(base, 'History'), {
      label: lbl('Historique de navigation'), category: 'yellow',
      dataType: 'historique de navigation', dataTypeEn: 'browsing history',
      note: 'Supprime l\'historique des URL visitées, des recherches et des téléchargements. Sans effet sur les favoris.',
      noteEn: 'Deletes the history of visited URLs, searches, and downloads. Does not affect bookmarks.',
      command: `Remove-Item "${path.join(base, 'History')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushFile(findings, path.join(base, 'Favicons'), {
      label: lbl('Icônes des sites visités'), category: 'yellow',
      dataType: 'favicons (liées à l\'historique)', dataTypeEn: 'favicons (tied to history)',
      note: 'Icônes des sites visités, corrélées à l\'historique de navigation.',
      noteEn: 'Icons of visited sites, correlated with browsing history.',
      command: `Remove-Item "${path.join(base, 'Favicons')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushFile(findings, path.join(base, 'Top Sites'), {
      label: lbl('Sites fréquents'), category: 'green',
      dataType: 'sites les plus visités', dataTypeEn: 'most-visited sites',
      note: 'Liste des raccourcis vers vos sites les plus visités (page nouvel onglet).',
      noteEn: 'List of shortcuts to your most-visited sites (new-tab page).',
      command: `Remove-Item "${path.join(base, 'Top Sites')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushDir(findings, path.join(base, 'Sessions'), {
      label: lbl('Onglets/sessions restaurables'), category: 'yellow',
      dataType: 'restauration de session (onglets ouverts)', dataTypeEn: 'session restore data (open tabs)',
      note: 'Permet de restaurer les onglets après un crash ; contient les URL des onglets ouverts.',
      noteEn: 'Lets tabs be restored after a crash; contains the URLs of open tabs.',
      command: `Get-ChildItem "${path.join(base, 'Sessions')}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    await pushDir(findings, path.join(base, 'Local Storage'), {
      label: lbl('Stockage local des sites'), category: 'yellow',
      dataType: 'données posées par les sites (localStorage)', dataTypeEn: 'site-set data (localStorage)',
      note: 'Équivalent moderne des cookies, posé directement par les sites visités.',
      noteEn: 'Modern equivalent of cookies, set directly by the sites you visit.',
      command: `Get-ChildItem "${path.join(base, 'Local Storage')}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    // Sensibles : jamais de commande, jamais proposés au nettoyage.
    await pushFile(findings, path.join(base, 'Web Data'), {
      label: lbl('Formulaires & moyens de paiement enregistrés'), category: 'red',
      dataType: 'autofill / paiement', dataTypeEn: 'autofill / payment',
      note: 'Contient les formulaires et cartes enregistrées : ce n\'est pas du traçage mais une donnée utile. Non proposé à la suppression par cet outil — à gérer depuis les réglages du navigateur.',
      noteEn: 'Contains saved forms and cards: not tracking data but a useful record. Not offered for deletion by this tool — manage it from the browser\'s own settings.',
    });
    await pushFile(findings, path.join(base, 'Login Data'), {
      label: lbl('Mots de passe enregistrés'), category: 'red',
      dataType: 'identifiants enregistrés', dataTypeEn: 'saved credentials',
      note: 'Coffre de mots de passe : donnée précieuse, pas du traçage. Non proposé à la suppression par cet outil.',
      noteEn: 'Password vault: valuable data, not tracking. Not offered for deletion by this tool.',
    });
  }
}

async function scanFirefox(findings: Finding[], notes: string[], notesEn: string[]): Promise<void> {
  const root = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'Profiles');
  if (!(await exists(root))) return;
  if (await isProcessRunning('firefox.exe')) {
    notes.push('Firefox est en cours d\'exécution : ses fichiers de traçage (cookies, historique…) sont verrouillés et ne pourront pas être nettoyés tant qu\'il n\'est pas fermé.');
    notesEn.push('Firefox is currently running: its tracking files (cookies, history…) are locked and cannot be cleaned until it is closed.');
  }

  for (const profile of await listSubdirs(root)) {
    const base = path.join(root, profile);
    const lbl = (dt: string): string => `Firefox (${profile}) — ${dt}`;

    await pushFile(findings, path.join(base, 'cookies.sqlite'), {
      label: lbl('Cookies'), category: 'yellow',
      dataType: 'cookies (sessions, traceurs)', dataTypeEn: 'cookies (sessions, trackers)',
      note: 'Ferme vos sessions ouvertes sur les sites (reconnexion nécessaire).',
      noteEn: 'Signs you out of open sessions on websites (you will need to log back in).',
      command: `Remove-Item "${path.join(base, 'cookies.sqlite')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushFile(findings, path.join(base, 'formhistory.sqlite'), {
      label: lbl('Historique de formulaires'), category: 'yellow',
      dataType: 'saisies de formulaires', dataTypeEn: 'form entries',
      note: 'Valeurs déjà saisies dans des formulaires (autocomplétion).',
      noteEn: 'Values previously typed into forms (autocomplete).',
      command: `Remove-Item "${path.join(base, 'formhistory.sqlite')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushFile(findings, path.join(base, 'sessionstore.jsonlz4'), {
      label: lbl('Session (onglets ouverts)'), category: 'yellow',
      dataType: 'restauration de session', dataTypeEn: 'session restore data',
      note: 'Liste des onglets ouverts, utilisée pour restaurer la session après fermeture.',
      noteEn: 'List of open tabs, used to restore the session after closing.',
      command: `Remove-Item "${path.join(base, 'sessionstore.jsonlz4')}" -Force -ErrorAction SilentlyContinue`,
    });

    await pushDir(findings, path.join(base, 'storage'), {
      label: lbl('Stockage local des sites'), category: 'yellow',
      dataType: 'données posées par les sites (localStorage/IndexedDB)', dataTypeEn: 'site-set data (localStorage/IndexedDB)',
      note: 'Équivalent moderne des cookies, posé directement par les sites visités.',
      noteEn: 'Modern equivalent of cookies, set directly by the sites you visit.',
      command: `Get-ChildItem "${path.join(base, 'storage')}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    // Sensible : mélange historique + favoris dans un seul fichier, jamais de commande.
    await pushFile(findings, path.join(base, 'places.sqlite'), {
      label: lbl('Historique de navigation'), category: 'red',
      dataType: 'historique + favoris (fichier unique)', dataTypeEn: 'history + bookmarks (single file)',
      note: '⚠️ Ce fichier mélange l\'historique de navigation ET les favoris : le supprimer efface aussi vos favoris. Utiliser plutôt Firefox → Historique → « Effacer l\'historique récent » (choisir « Tout »), ou exporter les favoris avant toute action manuelle.',
      noteEn: '⚠️ This file combines browsing history AND bookmarks: deleting it also erases your bookmarks. Use Firefox → History → "Clear Recent History" instead (choose "Everything"), or export your bookmarks first if you plan any manual action.',
    });
  }
}

/**
 * Mesure les traces d'activité/confidentialité : zones système (Prefetch,
 * fichiers récents, Jump Lists, miniatures, Timeline, presse-papiers) et
 * navigateurs (Chrome, Edge, Firefox — cookies, historique, sessions…).
 */
export async function scanPrivacy(): Promise<Section> {
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const roamingAppData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');

  const findings: Finding[] = [];
  const notes: string[] = [];
  const notesEn: string[] = [];

  const prefetchDir = path.join(windir, 'Prefetch');
  const prefetch = await sumMatching(prefetchDir, /\.pf$/i);
  if (prefetch.sizeBytes > 0) {
    findings.push({
      label: 'Prefetch (historique de lancement des programmes)', path: prefetchDir, sizeBytes: prefetch.sizeBytes,
      category: 'yellow', dataType: 'historique d\'exécution', dataTypeEn: 'program execution history',
      note: 'Chaque fichier .pf révèle le nom d\'un programme lancé récemment (et quand). Accélère aussi son prochain démarrage ; Windows les régénère automatiquement.',
      noteEn: 'Each .pf file reveals the name of a recently launched program (and when). Also speeds up its next startup; Windows regenerates them automatically.',
      command: `Get-ChildItem "${prefetchDir}\\*.pf" -Force | Remove-Item -Force -ErrorAction SilentlyContinue  # en admin`,
      lastActivity: prefetch.newestMtimeMs > 0 ? new Date(prefetch.newestMtimeMs).toISOString().slice(0, 10) : null,
    });
  } else {
    notes.push('Prefetch non mesurable (vide, ou lecture refusée sans droits admin — relancer le scan en administrateur).');
    notesEn.push('Prefetch not measurable (empty, or read denied without admin rights — rerun the scan as administrator).');
  }

  const recentDir = path.join(roamingAppData, 'Microsoft', 'Windows', 'Recent');
  await pushGlob(findings, recentDir, /\.lnk$/i, {
    label: 'Fichiers récents (raccourcis)', category: 'green',
    dataType: 'liste de fichiers récemment ouverts', dataTypeEn: 'recently opened files list',
    note: 'Raccourcis vers les derniers fichiers/dossiers ouverts (menu Démarrer, barre d\'adresse). Purement pratique, recréé à l\'usage.',
    noteEn: 'Shortcuts to the last opened files/folders (Start menu, address bar). Purely for convenience, recreated as you use your PC.',
    command: `Get-ChildItem "${recentDir}\\*.lnk" -Force | Remove-Item -Force -ErrorAction SilentlyContinue`,
  });

  await pushDir(findings, path.join(recentDir, 'AutomaticDestinations'), {
    label: 'Jump Lists automatiques (documents récents par appli)', category: 'yellow',
    dataType: 'historique de documents récents par application', dataTypeEn: 'per-application recent-document history',
    note: 'Historique des documents récents affiché au clic droit sur une icône de la barre des tâches. Recréé à l\'usage.',
    noteEn: 'History of recent documents shown when right-clicking a taskbar icon. Recreated as you use your PC.',
    command: `Get-ChildItem "${path.join(recentDir, 'AutomaticDestinations')}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
  });
  await pushDir(findings, path.join(recentDir, 'CustomDestinations'), {
    label: 'Jump Lists épinglées (barre des tâches)', category: 'yellow',
    dataType: 'historique de documents récents par application', dataTypeEn: 'per-application recent-document history',
    note: 'Historique des documents récents affiché au clic droit sur une icône de la barre des tâches. Recréé à l\'usage.',
    noteEn: 'History of recent documents shown when right-clicking a taskbar icon. Recreated as you use your PC.',
    command: `Get-ChildItem "${path.join(recentDir, 'CustomDestinations')}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
  });

  const explorerDir = path.join(localAppData, 'Microsoft', 'Windows', 'Explorer');
  await pushGlob(findings, explorerDir, /^(thumbcache|iconcache)_.*\.db$/i, {
    label: 'Cache de miniatures', category: 'yellow',
    dataType: 'miniatures d\'images/vidéos/documents', dataTypeEn: 'image/video/document thumbnails',
    note: 'Miniatures des fichiers consultés dans l\'Explorateur — peuvent subsister même après suppression ou déplacement du fichier original. Windows les régénère au survol.',
    noteEn: 'Thumbnails of files browsed in Explorer — can persist even after the original file is deleted or moved. Windows regenerates them on demand.',
    command: `Get-ChildItem "${explorerDir}\\thumbcache_*.db","${explorerDir}\\iconcache_*.db" -Force | Remove-Item -Force -ErrorAction SilentlyContinue`,
  });

  const timelineDir = path.join(localAppData, 'ConnectedDevicesPlatform');
  await pushDir(findings, timelineDir, {
    label: 'Historique d\'activité (Timeline)', category: 'yellow',
    dataType: 'activité par application/document (synchronisation Timeline)', dataTypeEn: 'per-app/document activity (Timeline sync)',
    note: 'Historique de ce qui a été ouvert et quand, utilisé par la Timeline/Activités Windows. Désactivable dans Confidentialité → Historique des activités.',
    noteEn: 'History of what was opened and when, used by the Windows Timeline/Activity feed. Can be disabled in Privacy → Activity History.',
    command: `Remove-Item "${timelineDir}\\*" -Recurse -Force -ErrorAction SilentlyContinue`,
  });

  const clipboardDir = path.join(localAppData, 'Microsoft', 'Windows', 'Clipboard');
  await pushDir(findings, clipboardDir, {
    label: 'Historique du presse-papiers', category: 'green',
    dataType: 'contenus copiés récemment', dataTypeEn: 'recently copied content',
    note: 'Historique du presse-papiers (Win+V), si la fonctionnalité a été activée. Sans impact si non utilisée.',
    noteEn: 'Clipboard history (Win+V), if the feature was ever enabled. No impact if unused.',
    command: `Remove-Item "${clipboardDir}\\*" -Recurse -Force -ErrorAction SilentlyContinue`,
  });

  await scanChromium('Chrome', path.join(localAppData, 'Google', 'Chrome', 'User Data'), 'chrome.exe', findings, notes, notesEn);
  await scanChromium('Edge', path.join(localAppData, 'Microsoft', 'Edge', 'User Data'), 'msedge.exe', findings, notes, notesEn);
  await scanFirefox(findings, notes, notesEn);

  notes.push('Journaux d\'événements Windows (connexions, services…) et historiques du registre (recherches Explorer, commande Exécuter, UserAssist) ne sont pas nettoyés par cet outil : trop sensibles pour une suppression de fichier. Utiliser l\'Observateur d\'événements (« Effacer le journal ») ou les réglages officiels de confidentialité.');
  notesEn.push('Windows event logs (logons, services…) and registry-based histories (Explorer search, Run command, UserAssist) are not cleaned by this tool: too sensitive for a raw file deletion. Use Event Viewer ("Clear Log") or the official privacy settings instead.');

  findings.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    id: 'privacy',
    title: '🕵️ Traces d\'activité & confidentialité',
    titleEn: '🕵️ Activity & privacy traces',
    findings, notes, notesEn,
  };
}
