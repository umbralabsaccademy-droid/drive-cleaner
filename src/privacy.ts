/**
 * Module — Traces d'activité & confidentialité.
 *
 * Couvre ce qui trace l'usage du PC (pas l'espace disque) : Prefetch,
 * fichiers récents/Jump Lists, cache de miniatures, Timeline, presse-papiers,
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
 * - Toutes les autres commandes suivent EXACTEMENT les deux formes que
 *   `actionables.ts` sait analyser (`parseDelete`) : `Remove-Item -Recurse
 *   -Force "chemin"` (fichier/dossier entier) ou `Get-ChildItem "dossier" |
 *   Remove-Item -Recurse -Force …` (contenu d'un dossier à conserver) — un
 *   dossier/fichier mesuré sans respecter cette forme resterait affiché
 *   mais jamais nettoyable par l'outil (que ce soit en mode Simple ou
 *   Expert), donc pas de wildcard dans les chemins.
 * - Un navigateur détecté en cours d'exécution (tasklist) ajoute un
 *   avertissement dans les notes de section : ses fichiers seront verrouillés.
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
  /** À quoi sert ce fichier (pédagogie), distinct de la conséquence d'une suppression. */
  purpose: string;
  purposeEn: string;
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

async function pushFile(findings: Finding[], p: string, a: AreaBase): Promise<void> {
  try {
    const st = await stat(p);
    if (st.size === 0) return;
    findings.push({
      label: a.label, path: p, sizeBytes: st.size, category: a.category,
      dataType: a.dataType, dataTypeEn: a.dataTypeEn,
      purpose: a.purpose, purposeEn: a.purposeEn, note: a.note, noteEn: a.noteEn, command: a.command,
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
    dataType: a.dataType, dataTypeEn: a.dataTypeEn,
    purpose: a.purpose, purposeEn: a.purposeEn, note: a.note, noteEn: a.noteEn, command: a.command,
    lastActivity: st.newestMtimeMs > 0 ? new Date(st.newestMtimeMs).toISOString().slice(0, 10) : null,
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
      purpose: 'Un site dépose ce fichier pour vous reconnaître d\'une visite à l\'autre — rester connecté, mémoriser un panier — mais aussi, très souvent, pour suivre votre navigation à des fins publicitaires.',
      purposeEn: 'A site sets this file to recognize you across visits — staying logged in, remembering a cart — but also, very often, to track your browsing for advertising purposes.',
      note: 'Ferme vos sessions ouvertes sur les sites (reconnexion nécessaire). Ne touche pas aux favoris ni aux mots de passe.',
      noteEn: 'Signs you out of open sessions on websites (you will need to log back in). Does not affect bookmarks or passwords.',
      command: `Remove-Item -Recurse -Force "${cookiesPath}"`,
    });

    await pushFile(findings, path.join(base, 'History'), {
      label: lbl('Historique de navigation'), category: 'yellow',
      dataType: 'historique de navigation', dataTypeEn: 'browsing history',
      purpose: 'Liste chronologique des pages visitées, utilisée pour l\'auto-complétion de la barre d\'adresse et les suggestions.',
      purposeEn: 'Chronological list of visited pages, used for address-bar autocomplete and suggestions.',
      note: 'Supprime l\'historique des URL visitées, des recherches et des téléchargements. Sans effet sur les favoris.',
      noteEn: 'Deletes the history of visited URLs, searches, and downloads. Does not affect bookmarks.',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'History')}"`,
    });

    await pushFile(findings, path.join(base, 'Favicons'), {
      label: lbl('Icônes des sites visités'), category: 'yellow',
      dataType: 'favicons (liées à l\'historique)', dataTypeEn: 'favicons (tied to history)',
      purpose: 'Icônes des sites visités, stockées à part — une base qui recoupe elle aussi votre historique.',
      purposeEn: 'Icons of visited sites, stored separately — a database that also cross-references your history.',
      note: 'Icônes des sites visités, corrélées à l\'historique de navigation.',
      noteEn: 'Icons of visited sites, correlated with browsing history.',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'Favicons')}"`,
    });

    await pushFile(findings, path.join(base, 'Top Sites'), {
      label: lbl('Sites fréquents'), category: 'green',
      dataType: 'sites les plus visités', dataTypeEn: 'most-visited sites',
      purpose: 'Raccourcis générés automatiquement vers vos sites les plus visités (page nouvel onglet).',
      purposeEn: 'Shortcuts automatically generated to your most-visited sites (new-tab page).',
      note: 'Liste des raccourcis vers vos sites les plus visités (page nouvel onglet).',
      noteEn: 'List of shortcuts to your most-visited sites (new-tab page).',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'Top Sites')}"`,
    });

    await pushDir(findings, path.join(base, 'Sessions'), {
      label: lbl('Onglets/sessions restaurables'), category: 'yellow',
      dataType: 'restauration de session (onglets ouverts)', dataTypeEn: 'session restore data (open tabs)',
      purpose: 'Sauvegarde technique des onglets ouverts, pour pouvoir les rouvrir après un plantage ou un redémarrage du navigateur.',
      purposeEn: 'Technical backup of open tabs, so they can be reopened after a crash or browser restart.',
      note: 'Permet de restaurer les onglets après un crash ; contient les URL des onglets ouverts.',
      noteEn: 'Lets tabs be restored after a crash; contains the URLs of open tabs.',
      command: `Get-ChildItem "${path.join(base, 'Sessions')}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    await pushDir(findings, path.join(base, 'Local Storage'), {
      label: lbl('Stockage local des sites'), category: 'yellow',
      dataType: 'données posées par les sites (localStorage)', dataTypeEn: 'site-set data (localStorage)',
      purpose: 'Espace que chaque site utilise pour garder des données côté client — préférences, paniers, mais parfois aussi des identifiants de suivi propriétaires, hors du contrôle du réglage « cookies » classique.',
      purposeEn: 'Space each site uses to keep client-side data — preferences, carts, but sometimes also proprietary tracking identifiers, outside the reach of the regular "cookies" setting.',
      note: 'Équivalent moderne des cookies, posé directement par les sites visités.',
      noteEn: 'Modern equivalent of cookies, set directly by the sites you visit.',
      command: `Get-ChildItem "${path.join(base, 'Local Storage')}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    // Sensibles : jamais de commande, jamais proposés au nettoyage.
    await pushFile(findings, path.join(base, 'Web Data'), {
      label: lbl('Formulaires & moyens de paiement enregistrés'), category: 'red',
      dataType: 'autofill / paiement', dataTypeEn: 'autofill / payment',
      purpose: 'Saisies automatiques : adresses, coordonnées, parfois moyens de paiement enregistrés dans le navigateur.',
      purposeEn: 'Autofill data: addresses, contact details, sometimes payment methods saved in the browser.',
      note: 'Contient les formulaires et cartes enregistrées : ce n\'est pas du traçage mais une donnée utile. Non proposé à la suppression par cet outil — à gérer depuis les réglages du navigateur.',
      noteEn: 'Contains saved forms and cards: not tracking data but a useful record. Not offered for deletion by this tool — manage it from the browser\'s own settings.',
    });
    await pushFile(findings, path.join(base, 'Login Data'), {
      label: lbl('Mots de passe enregistrés'), category: 'red',
      dataType: 'identifiants enregistrés', dataTypeEn: 'saved credentials',
      purpose: 'Coffre local des identifiants et mots de passe enregistrés pour la connexion automatique aux sites.',
      purposeEn: 'Local vault of usernames and passwords saved for automatic sign-in on websites.',
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
      purpose: 'Un site dépose ce fichier pour vous reconnaître d\'une visite à l\'autre — rester connecté, mémoriser un panier — mais aussi, très souvent, pour suivre votre navigation à des fins publicitaires.',
      purposeEn: 'A site sets this file to recognize you across visits — staying logged in, remembering a cart — but also, very often, to track your browsing for advertising purposes.',
      note: 'Ferme vos sessions ouvertes sur les sites (reconnexion nécessaire).',
      noteEn: 'Signs you out of open sessions on websites (you will need to log back in).',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'cookies.sqlite')}"`,
    });

    await pushFile(findings, path.join(base, 'formhistory.sqlite'), {
      label: lbl('Historique de formulaires'), category: 'yellow',
      dataType: 'saisies de formulaires', dataTypeEn: 'form entries',
      purpose: 'Valeurs déjà saisies dans des formulaires web, réutilisées pour l\'auto-complétion.',
      purposeEn: 'Values previously typed into web forms, reused for autocomplete.',
      note: 'Valeurs déjà saisies dans des formulaires (autocomplétion).',
      noteEn: 'Values previously typed into forms (autocomplete).',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'formhistory.sqlite')}"`,
    });

    await pushFile(findings, path.join(base, 'sessionstore.jsonlz4'), {
      label: lbl('Session (onglets ouverts)'), category: 'yellow',
      dataType: 'restauration de session', dataTypeEn: 'session restore data',
      purpose: 'Sauvegarde technique des onglets ouverts, pour pouvoir les rouvrir après un plantage ou un redémarrage du navigateur.',
      purposeEn: 'Technical backup of open tabs, so they can be reopened after a crash or browser restart.',
      note: 'Liste des onglets ouverts, utilisée pour restaurer la session après fermeture.',
      noteEn: 'List of open tabs, used to restore the session after closing.',
      command: `Remove-Item -Recurse -Force "${path.join(base, 'sessionstore.jsonlz4')}"`,
    });

    await pushDir(findings, path.join(base, 'storage'), {
      label: lbl('Stockage local des sites'), category: 'yellow',
      dataType: 'données posées par les sites (localStorage/IndexedDB)', dataTypeEn: 'site-set data (localStorage/IndexedDB)',
      purpose: 'Espace que chaque site utilise pour garder des données côté client — préférences, paniers, mais parfois aussi des identifiants de suivi propriétaires, hors du contrôle du réglage « cookies » classique.',
      purposeEn: 'Space each site uses to keep client-side data — preferences, carts, but sometimes also proprietary tracking identifiers, outside the reach of the regular "cookies" setting.',
      note: 'Équivalent moderne des cookies, posé directement par les sites visités.',
      noteEn: 'Modern equivalent of cookies, set directly by the sites you visit.',
      command: `Get-ChildItem "${path.join(base, 'storage')}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    });

    // Sensible : mélange historique + favoris dans un seul fichier, jamais de commande.
    await pushFile(findings, path.join(base, 'places.sqlite'), {
      label: lbl('Historique de navigation'), category: 'red',
      dataType: 'historique + favoris (fichier unique)', dataTypeEn: 'history + bookmarks (single file)',
      purpose: 'Base unique qui combine l\'historique de navigation ET les favoris Firefox.',
      purposeEn: 'Single database that combines Firefox browsing history AND bookmarks.',
      note: '⚠️ Ce fichier mélange l\'historique de navigation ET les favoris : le supprimer efface aussi vos favoris. Utiliser plutôt Firefox → Historique → « Effacer l\'historique récent » (choisir « Tout »), ou exporter les favoris avant toute action manuelle.',
      noteEn: '⚠️ This file combines browsing history AND bookmarks: deleting it also erases your bookmarks. Use Firefox → History → "Clear Recent History" instead (choose "Everything"), or export your bookmarks first if you plan any manual action.',
    });
  }
}

/**
 * Mesure les traces d'activité/confidentialité : zones système (Prefetch,
 * fichiers récents/Jump Lists, miniatures, Timeline, presse-papiers) et
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
  const prefetchStats = await measureDir(prefetchDir);
  if (prefetchStats.sizeBytes > 0) {
    findings.push({
      label: 'Prefetch (historique de lancement des programmes)', path: prefetchDir, sizeBytes: prefetchStats.sizeBytes,
      category: 'yellow', dataType: 'historique d\'exécution', dataTypeEn: 'program execution history',
      purpose: 'Fonction Windows qui précharge les programmes fréquemment utilisés pour accélérer leur démarrage ; le sous-produit est un journal de chaque exécutable lancé récemment, avec horodatage.',
      purposeEn: 'Windows feature that preloads frequently used programs to speed up their startup; the by-product is a log of every recently launched executable, with a timestamp.',
      note: 'Chaque fichier .pf révèle le nom d\'un programme lancé récemment (et quand). Accélère aussi son prochain démarrage ; Windows les régénère automatiquement.',
      noteEn: 'Each .pf file reveals the name of a recently launched program (and when). Also speeds up its next startup; Windows regenerates them automatically.',
      command: `Get-ChildItem "${prefetchDir}" | Remove-Item -Force -ErrorAction SilentlyContinue  # en admin`,
      lastActivity: prefetchStats.newestMtimeMs > 0 ? new Date(prefetchStats.newestMtimeMs).toISOString().slice(0, 10) : null,
    });
  } else {
    notes.push('Prefetch non mesurable (vide, ou lecture refusée sans droits admin — relancer le scan en administrateur).');
    notesEn.push('Prefetch not measurable (empty, or read denied without admin rights — rerun the scan as administrator).');
  }

  // Fichiers récents (.lnk) + Jump Lists (Automatic/CustomDestinations) : un seul
  // dossier parent, une seule action (les sous-dossiers sont comptés par récursion).
  const recentDir = path.join(roamingAppData, 'Microsoft', 'Windows', 'Recent');
  await pushDir(findings, recentDir, {
    label: 'Fichiers récents & documents ouverts (Jump Lists)', category: 'yellow',
    dataType: 'fichiers et documents récemment ouverts', dataTypeEn: 'recently opened files & documents',
    purpose: 'Raccourcis vers vos derniers fichiers ouverts et listes de documents récents par application, pour un accès rapide depuis le Démarrer/la barre des tâches.',
    purposeEn: 'Shortcuts to your last opened files and per-application recent-document lists, for quick access from Start/the taskbar.',
    note: 'Vide le menu « Récents » (Démarrer/Explorateur) et les listes de documents récents affichées au clic droit sur les icônes de la barre des tâches (Jump Lists). Se reconstruit à l\'usage.',
    noteEn: 'Clears the "Recent" list (Start/Explorer) and the recent-document lists shown when right-clicking taskbar icons (Jump Lists). Rebuilds itself as you use your PC.',
    command: `Get-ChildItem "${recentDir}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
  });

  const explorerDir = path.join(localAppData, 'Microsoft', 'Windows', 'Explorer');
  await pushDir(findings, explorerDir, {
    label: 'Cache de miniatures', category: 'yellow',
    dataType: 'miniatures d\'images/vidéos/documents', dataTypeEn: 'image/video/document thumbnails',
    purpose: 'Aperçus visuels des images, vidéos et documents consultés dans l\'Explorateur, générés pour un affichage plus rapide.',
    purposeEn: 'Visual previews of images, videos and documents browsed in Explorer, generated for faster display.',
    note: 'Miniatures des fichiers consultés dans l\'Explorateur — peuvent subsister même après suppression ou déplacement du fichier original. Windows les régénère au survol.',
    noteEn: 'Thumbnails of files browsed in Explorer — can persist even after the original file is deleted or moved. Windows regenerates them on demand.',
    command: `Get-ChildItem "${explorerDir}" | Remove-Item -Force -ErrorAction SilentlyContinue`,
  });

  const timelineDir = path.join(localAppData, 'ConnectedDevicesPlatform');
  await pushDir(findings, timelineDir, {
    label: 'Historique d\'activité (Timeline)', category: 'yellow',
    dataType: 'activité par application/document (synchronisation Timeline)', dataTypeEn: 'per-app/document activity (Timeline sync)',
    purpose: 'Journal qui retrace applications et documents ouverts dans le temps, utilisé par la fonction Chronologie et la synchronisation entre appareils Microsoft.',
    purposeEn: 'Log that tracks applications and documents opened over time, used by the Timeline feature and Microsoft cross-device sync.',
    note: 'Historique de ce qui a été ouvert et quand, utilisé par la Timeline/Activités Windows. Désactivable dans Confidentialité → Historique des activités.',
    noteEn: 'History of what was opened and when, used by the Windows Timeline/Activity feed. Can be disabled in Privacy → Activity History.',
    command: `Get-ChildItem "${timelineDir}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
  });

  const clipboardDir = path.join(localAppData, 'Microsoft', 'Windows', 'Clipboard');
  await pushDir(findings, clipboardDir, {
    label: 'Historique du presse-papiers', category: 'green',
    dataType: 'contenus copiés récemment', dataTypeEn: 'recently copied content',
    purpose: 'Historique de ce qui a été copié/collé (texte, images), si la fonction Win+V a été activée.',
    purposeEn: 'History of what was copied/pasted (text, images), if the Win+V clipboard history feature was ever enabled.',
    note: 'Historique du presse-papiers (Win+V), si la fonctionnalité a été activée. Sans impact si non utilisée.',
    noteEn: 'Clipboard history (Win+V), if the feature was ever enabled. No impact if unused.',
    command: `Get-ChildItem "${clipboardDir}" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
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
