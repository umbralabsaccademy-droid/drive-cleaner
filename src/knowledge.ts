/**
 * Base de connaissances : classification 🟢/🟡/🔴 des dossiers AppData.
 *
 * Choix techniques :
 * - Trois niveaux de règles, appliqués dans cet ordre de priorité :
 *   1. règles EXACTES par chemin (`root\name` en minuscules) — la connaissance
 *      « métier » accumulée (npm-cache = cache, Bitcoin = wallet, etc.) ;
 *   2. règles par MOTIF sur le nom (ex. `*-updater` = installeurs de MàJ) ;
 *   3. heuristiques GÉNÉRIQUES sur les noms d'enfants (Cache, Crashpad, logs…)
 *      qui fonctionnent pour n'importe quelle application inconnue.
 * - Défaut : 🟡 « à vérifier » — on ne classe jamais 🟢 un dossier inconnu.
 * - Chaque règle 🟢 porte une commande PowerShell de suppression, générée mais
 *   JAMAIS exécutée par l'outil (lecture seule stricte).
 */

export type Category = 'green' | 'yellow' | 'red';

export interface Classification {
  category: Category;
  /** Application ou éditeur propriétaire du dossier. */
  app: string;
  /** cache | logs | temporaires | configuration | données utilisateur | application | système */
  dataType: string;
  /** Conséquence exacte d'une suppression, affichée dans le rapport. */
  note: string;
  /** L'application recrée-t-elle le dossier automatiquement ? */
  autoRecreated: boolean;
  /** Commande PowerShell suggérée (jamais exécutée par l'outil). */
  command?: string;
  /**
   * true si la classification vient d'une règle EXACTE ou d'un motif éprouvé
   * (pas d'une heuristique générique). Le « mode simple » ne propose au
   * nettoyage QUE les éléments 🟢 connus : jamais de pari pour un novice.
   */
  known?: boolean;
}

const GREEN = 'green' as const;
const YELLOW = 'yellow' as const;
const RED = 'red' as const;

/** Commande de suppression PowerShell standard, chemin quoté. */
function rmCmd(p: string): string {
  return `Remove-Item -Recurse -Force "${p}"`;
}

type RuleFactory = (p: string) => Classification;

/**
 * Règles exactes par `root\name` (insensible à la casse).
 * Construites à partir d'un audit manuel réel — étendre au fil des découvertes.
 */
const EXACT_RULES: Record<string, RuleFactory> = {
  // ---------- Local ----------
  'local\\packages': () => ({
    category: RED, app: 'Windows (apps MSIX)', dataType: 'système',
    note: 'Données des applications Windows/Store. Ne jamais supprimer manuellement — passer par Paramètres → Applications.',
    autoRecreated: false,
  }),
  'local\\bravesoftware': () => ({
    category: YELLOW, app: 'Brave', dataType: 'profil navigateur + cache',
    note: 'Vider le cache DEPUIS Brave (Paramètres → Effacer les données → Images et fichiers en cache). Le profil (mots de passe, favoris) ne doit pas être supprimé à la main.',
    autoRecreated: false,
  }),
  'local\\google': () => ({
    category: YELLOW, app: 'Google (Chrome, Android Studio)', dataType: 'profil + caches IDE',
    note: 'Cache Chrome à vider depuis le navigateur. Les anciens dossiers AndroidStudioX.Y sont supprimables si une version plus récente est utilisée.',
    autoRecreated: false,
  }),
  'local\\yarn': (p) => ({
    category: GREEN, app: 'Yarn', dataType: 'cache de paquets',
    note: 'Cache de téléchargement des paquets. Recréé au prochain « yarn install ».',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\android': () => ({
    category: RED, app: 'Android SDK', dataType: 'outils de développement',
    note: 'SDK nécessaire au développement Android/React Native. Gérer les composants via le SDK Manager d\'Android Studio.',
    autoRecreated: false,
  }),
  'local\\npm-cache': (p) => ({
    category: GREEN, app: 'npm', dataType: 'cache de paquets',
    note: 'Recréé automatiquement. Préférer « npm cache clean --force » (garde la structure).',
    autoRecreated: true, command: `npm cache clean --force  # ou : ${rmCmd(p)}`,
  }),
  'local\\microsoft': () => ({
    category: RED, app: 'Microsoft (Office, Windows, Edge)', dataType: 'système',
    note: 'Mélange de données système et Office. Seuls certains sous-dossiers (TypeScript, FontCache) sont des caches sûrs — voir le détail niveau 2.',
    autoRecreated: false,
  }),
  'local\\capcut': () => ({
    category: YELLOW, app: 'CapCut', dataType: 'application + projets',
    note: '« User Data » contient les montages/brouillons (à ne pas perdre). Si l\'app n\'est plus utilisée, désinstaller proprement via Paramètres.',
    autoRecreated: false,
  }),
  'local\\programs': () => ({
    category: RED, app: 'Applications installées (VS Code, Termius…)', dataType: 'application',
    note: 'Binaires des applications elles-mêmes. Désinstaller via Paramètres si besoin.',
    autoRecreated: false,
  }),
  'local\\githubdesktop': () => ({
    category: YELLOW, app: 'GitHub Desktop', dataType: 'application (multi-versions)',
    note: 'Les anciens dossiers app-X.Y.Z (restes de mises à jour Squirrel) sont supprimables ; garder la version la plus récente.',
    autoRecreated: false,
  }),
  'local\\postman': () => ({
    category: YELLOW, app: 'Postman', dataType: 'application (multi-versions)',
    note: 'Les anciens dossiers app-X.Y.Z sont supprimables ; garder la version la plus récente.',
    autoRecreated: false,
  }),
  'local\\dropbox': () => ({
    category: RED, app: 'Dropbox', dataType: 'base de synchronisation',
    note: '« instance1 » = base de sync (ne pas toucher). Seul « Crashpad » (dumps de crash) est supprimable — voir niveau 2.',
    autoRecreated: false,
  }),
  'local\\ms-playwright': (p) => ({
    category: YELLOW, app: 'Playwright', dataType: 'navigateurs de test',
    note: 'Supprimable ; « npx playwright install » les retélécharge (plusieurs centaines de Mo).',
    autoRecreated: false, command: rmCmd(p),
  }),
  'local\\pip': (p) => ({
    category: GREEN, app: 'pip (Python)', dataType: 'cache de paquets',
    note: 'Recréé automatiquement. Préférer « pip cache purge ».',
    autoRecreated: true, command: `pip cache purge  # ou : ${rmCmd(p)}`,
  }),
  'local\\node-gyp': (p) => ({
    category: GREEN, app: 'node-gyp', dataType: 'cache (headers Node)',
    note: 'Retéléchargé à la prochaine compilation de module natif.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\temp': () => ({
    category: GREEN, app: 'Windows / divers', dataType: 'temporaires',
    note: 'Fichiers temporaires. Supprimer le CONTENU (certains fichiers de sessions actives seront verrouillés, c\'est normal). Recréé en permanence.',
    autoRecreated: true, command: 'Get-ChildItem "$env:LOCALAPPDATA\\Temp" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
  }),
  'local\\squirreltemp': (p) => ({
    category: GREEN, app: 'Installeurs Electron (Squirrel)', dataType: 'temporaires',
    note: 'Restes d\'installations d\'apps Electron. Recréé au besoin lors des prochaines installations.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\gitkrakencli': () => ({
    category: YELLOW, app: 'GitKraken CLI', dataType: 'application (versions)',
    note: 'Garder si l\'outil est utilisé ; sinon désinstaller.',
    autoRecreated: false,
  }),
  'local\\nuget': (p) => ({
    category: GREEN, app: 'NuGet (.NET)', dataType: 'cache de paquets',
    note: 'Recréé au prochain restore .NET.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\hardhat-nodejs': (p) => ({
    category: GREEN, app: 'Hardhat (dev blockchain)', dataType: 'cache',
    note: 'Cache de compilateurs Solidity. Retéléchargé au besoin.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\cloud-code': () => ({
    category: YELLOW, app: 'Google Cloud Code / Gemini CLI', dataType: 'outil',
    note: 'Garder si utilisé récemment.',
    autoRecreated: false,
  }),
  'local\\synologydrive': () => ({
    category: RED, app: 'Synology Drive', dataType: 'application + base de sync',
    note: 'Application de synchronisation NAS. Ne pas toucher si utilisée.',
    autoRecreated: false,
  }),
  'local\\mozilla': () => ({
    category: YELLOW, app: 'Firefox', dataType: 'cache navigateur',
    note: 'Partie cache du profil Firefox. Vider depuis Firefox (Paramètres → Vie privée → Effacer les données).',
    autoRecreated: true,
  }),
  'local\\crashdumps': (p) => ({
    category: GREEN, app: 'Windows', dataType: 'dumps de crash',
    note: 'Vidages mémoire d\'applications plantées. Recréé au prochain crash.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\connecteddevicesplatform': () => ({
    category: RED, app: 'Windows (appareils connectés)', dataType: 'système',
    note: 'Synchronisation d\'activités Windows. Ne pas toucher.',
    autoRecreated: false,
  }),
  'local\\comms': () => ({
    category: RED, app: 'Windows (Courrier/Calendrier)', dataType: 'système',
    note: 'Base des applications de communication Windows. Ne pas toucher.',
    autoRecreated: false,
  }),
  'local\\pgadmin4': () => ({
    category: YELLOW, app: 'pgAdmin 4', dataType: 'configuration',
    note: 'Peut contenir des connexions serveur enregistrées. Supprimer seulement si pgAdmin n\'est plus utilisé.',
    autoRecreated: false,
  }),
  'local\\tortoisegit': () => ({
    category: YELLOW, app: 'TortoiseGit', dataType: 'configuration/cache',
    note: 'Supprimable si TortoiseGit n\'est plus utilisé.',
    autoRecreated: false,
  }),
  'local\\meltytech': () => ({
    category: YELLOW, app: 'Shotcut', dataType: 'configuration',
    note: 'Réglages de l\'éditeur vidéo Shotcut. Supprimable si l\'app n\'est plus utilisée (perte des préférences).',
    autoRecreated: false,
  }),
  'local\\neo': (p) => ({
    category: GREEN, app: 'Pilote Intel (NEO)', dataType: 'cache de compilation GPU',
    note: 'Cache du compilateur OpenCL Intel. Recréé automatiquement.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\cef': () => ({
    category: YELLOW, app: 'Chromium Embedded Framework', dataType: 'données d\'app embarquée',
    note: 'Utilisé par une app tierce (souvent Spotify/jeux). Supprimable si ancien — l\'app propriétaire le recréera.',
    autoRecreated: true,
  }),
  'local\\d3dscache': (p) => ({
    category: GREEN, app: 'DirectX', dataType: 'cache de shaders',
    note: 'Recréé automatiquement par le pilote graphique.',
    autoRecreated: true, command: rmCmd(p),
  }),

  // ---------- Roaming ----------
  'roaming\\claude': () => ({
    category: YELLOW, app: 'Claude Desktop', dataType: 'données d\'application + VM',
    note: '« vm_bundles » (VM Cowork) est le gros morceau : supprimable, retéléchargé au prochain usage du mode agent local. Les caches (Cache, Code Cache) sont 🟢. Attention : peut être un miroir MSIX de Local\\Packages\\Claude_… (même contenu physique).',
    autoRecreated: true,
  }),
  'roaming\\code': () => ({
    category: YELLOW, app: 'Visual Studio Code', dataType: 'configuration + caches',
    note: '« User » = réglages/keybindings (🔴). Les caches (CachedExtensionVSIXs, Crashpad, Cache, CachedData) sont 🟢 — voir le détail niveau 2. Fermer VS Code avant.',
    autoRecreated: false,
  }),
  'roaming\\nvm': () => ({
    category: YELLOW, app: 'nvm-windows', dataType: 'versions de Node.js',
    note: 'Désinstaller les versions obsolètes avec « nvm uninstall <version> » (vérifier d\'abord la version active avec « nvm list »).',
    autoRecreated: false, command: 'nvm list  # puis : nvm uninstall <version>',
  }),
  'roaming\\microsoft': () => ({
    category: RED, app: 'Microsoft (Office, Windows)', dataType: 'système + modèles Office',
    note: 'Contient Credentials/Crypto/Vault (🔴 absolu). Exception : « Teams » (Teams classique abandonné) est supprimable — voir niveau 2.',
    autoRecreated: false,
  }),
  'roaming\\python': () => ({
    category: YELLOW, app: 'Python (pip --user)', dataType: 'paquets installés',
    note: 'Paquets installés en « pip install --user ». Supprimer casse ces paquets — réinstallation nécessaire.',
    autoRecreated: false,
  }),
  'roaming\\npm': () => ({
    category: YELLOW, app: 'npm (paquets globaux)', dataType: 'paquets installés',
    note: 'Paquets « npm install -g ». Lister avec « npm ls -g » et désinstaller ceux qui ne servent plus.',
    autoRecreated: false, command: 'npm ls -g --depth=0  # puis : npm uninstall -g <paquet>',
  }),
  'roaming\\dropbox': () => ({
    category: YELLOW, app: 'Dropbox (webview)', dataType: 'cache/session',
    note: '« Partitions » = données de la webview. Supprimable Dropbox fermé ; possible reconnexion au compte.',
    autoRecreated: true,
  }),
  'roaming\\postman': () => ({
    category: YELLOW, app: 'Postman', dataType: 'session',
    note: '« Partitions » supprimable mais déconnexion du compte Postman (les collections sont dans le cloud).',
    autoRecreated: true,
  }),
  'roaming\\bitcoin': () => ({
    category: RED, app: 'Bitcoin Core', dataType: 'données utilisateur (wallet !)',
    note: 'Contient « wallets » : NE JAMAIS SUPPRIMER sans sauvegarde vérifiée. Perte potentiellement irréversible de fonds.',
    autoRecreated: false,
  }),
  'roaming\\ledger live': () => ({
    category: RED, app: 'Ledger Live', dataType: 'application crypto',
    note: 'App de gestion de wallet matériel. Les clés sont sur le Ledger, mais par prudence ne pas toucher aux données de l\'app.',
    autoRecreated: false,
  }),
  'roaming\\ccleaner': (p) => ({
    category: GREEN, app: 'CCleaner', dataType: 'cache webview',
    note: '« EBWebView » = cache Edge WebView de l\'interface. Recréé au lancement.',
    autoRecreated: true, command: rmCmd(`${p}\\EBWebView`),
  }),
  'roaming\\mozilla': () => ({
    category: RED, app: 'Firefox', dataType: 'profil (favoris, mots de passe)',
    note: 'Profil Firefox : favoris, mots de passe, extensions. Ne pas supprimer à la main.',
    autoRecreated: false,
  }),
  'roaming\\termius': () => ({
    category: RED, app: 'Termius', dataType: 'configuration SSH',
    note: 'Peut contenir hôtes/identités SSH locales. Ne pas toucher.',
    autoRecreated: false,
  }),
  'roaming\\netlify': () => ({
    category: YELLOW, app: 'Netlify CLI', dataType: 'configuration + tokens',
    note: 'Contient le token d\'auth CLI. Supprimable si la CLI n\'est plus utilisée (re-login nécessaire).',
    autoRecreated: true,
  }),
  'roaming\\github desktop': () => ({
    category: YELLOW, app: 'GitHub Desktop', dataType: 'configuration + caches',
    note: 'Caches supprimables (niveau 2) ; le reste = session GitHub.',
    autoRecreated: true,
  }),
  'roaming\\truffle-nodejs': (p) => ({
    category: GREEN, app: 'Truffle (dev blockchain)', dataType: 'configuration/cache',
    note: 'Outil probablement abandonné (Truffle est déprécié). Recréé si réutilisé.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\airdroid': (p) => ({
    category: GREEN, app: 'AirDroid', dataType: 'logs + cache',
    note: 'Restes d\'application. Supprimable si AirDroid n\'est plus utilisé.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\com.adobe.dunamis': (p) => ({
    category: GREEN, app: 'Adobe (télémétrie)', dataType: 'télémétrie',
    note: 'Données d\'analytics Adobe (SDK Dunamis). Recréé par Acrobat au prochain lancement.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\ipfs desktop': (p) => ({
    category: GREEN, app: 'IPFS Desktop (désinstallé ?)', dataType: 'restes d\'application',
    note: 'Si l\'application n\'apparaît plus dans Programs, ce sont des données orphelines.',
    autoRecreated: false, command: rmCmd(p),
  }),
  'roaming\\windsurf': () => ({
    category: YELLOW, app: 'Windsurf (IDE)', dataType: 'configuration + caches',
    note: 'Supprimable si l\'éditeur n\'est plus utilisé (perte des réglages).',
    autoRecreated: false,
  }),

  // ---------- LocalLow ----------
  'locallow\\intel': (p) => ({
    category: GREEN, app: 'Intel (pilote graphique)', dataType: 'cache de shaders',
    note: 'ShaderCache recréé automatiquement par le pilote.',
    autoRecreated: true, command: rmCmd(`${p}\\ShaderCache`),
  }),
  'locallow\\adobe': () => ({
    category: YELLOW, app: 'Adobe Acrobat', dataType: 'configuration + cache',
    note: 'Petit ; supprimable si Acrobat n\'est plus utilisé.',
    autoRecreated: true,
  }),
};

/** Règles par motif sur le nom du dossier de niveau 1. */
const PATTERN_RULES: Array<{ test: (name: string) => boolean; make: (p: string, name: string) => Classification }> = [
  {
    // xxx-updater : caches d'installeurs de mise à jour (electron-updater), toujours regénérés
    test: (n) => /-updater$/i.test(n),
    make: (p, n) => ({
      category: GREEN,
      app: n.replace(/-updater$/i, ''),
      dataType: 'installeurs de mise à jour',
      note: 'Cache de mises à jour téléchargées. Recréé à la prochaine mise à jour de l\'application.',
      autoRecreated: true,
      command: rmCmd(p),
    }),
  },
  {
    test: (n) => /^npm-cache$/i.test(n),
    make: (p) => ({
      category: GREEN, app: 'npm', dataType: 'cache de paquets',
      note: 'Recréé automatiquement.', autoRecreated: true, command: rmCmd(p),
    }),
  },
];

/** Heuristiques génériques sur les noms de sous-dossiers (niveau 2). */
const CHILD_GREEN = new Set([
  'cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache',
  'shadercache', 'crashpad', 'crashreports', 'quitreports', 'dumps', 'logs', 'log',
  'blob_storage', 'cachedextensionvsixs', 'cacheddata', 'cachedprofilesdata', 'cachedextensions',
  'sentry', '_cacache', '_npx', '_logs', 'temp', 'tmp', 'pending', 'tempa', 'tempb', 'tempc',
]);
const CHILD_YELLOW = new Set([
  'service worker', 'webstorage', 'partitions', 'indexeddb', 'local storage', 'session storage',
  'shared dictionary', 'network',
]);
const CHILD_RED = new Set([
  'user data', 'user', 'profiles', 'wallets', 'credentials', 'vault', 'crypto',
  'instance1', 'blocks', 'chainstate', 'instance_db',
]);

/** Classifie un dossier de niveau 1. */
export function classifyTop(root: string, name: string, fullPath: string): Classification {
  const key = `${root.toLowerCase()}\\${name.toLowerCase()}`;
  const exact = EXACT_RULES[key];
  if (exact) return { ...exact(fullPath), known: true };

  for (const rule of PATTERN_RULES) {
    if (rule.test(name)) return { ...rule.make(fullPath, name), known: true };
  }

  // Défaut prudent : jamais 🟢 pour un inconnu
  return {
    category: YELLOW,
    app: name,
    dataType: 'inconnu — à vérifier',
    note: 'Application non répertoriée dans la base de règles. Vérifier manuellement avant toute suppression.',
    autoRecreated: false,
    known: false,
  };
}

/** Classifie un sous-dossier de niveau 2 (heuristiques génériques). */
export function classifyChild(parentClass: Classification, childName: string, childPath: string): Classification {
  const n = childName.toLowerCase();

  if (CHILD_RED.has(n)) {
    return {
      category: RED, app: parentClass.app, dataType: 'données utilisateur',
      note: 'Données applicatives (profil, base, wallet…). Ne pas supprimer à la main.',
      autoRecreated: false, known: parentClass.known,
    };
  }
  if (CHILD_GREEN.has(n)) {
    return {
      category: GREEN, app: parentClass.app, dataType: 'cache / logs',
      note: 'Cache ou journaux — recréé automatiquement par l\'application (la fermer avant).',
      autoRecreated: true, command: rmCmd(childPath),
      // Heuristique de nom : « connue » seulement si l'application parente l'est
      known: parentClass.known,
    };
  }
  if (CHILD_YELLOW.has(n)) {
    return {
      category: YELLOW, app: parentClass.app, dataType: 'stockage local / session',
      note: 'Supprimable mais conséquence probable : déconnexion ou perte d\'état local de l\'application.',
      autoRecreated: true, known: parentClass.known,
    };
  }
  // Cas particulier : bundles VM de Claude Desktop (volumineux, retéléchargés)
  if (n === 'vm_bundles') {
    return {
      category: YELLOW, app: parentClass.app, dataType: 'images VM (Cowork)',
      note: 'Bundle VM du mode agent local. Supprimable (app fermée) ; retéléchargé (plusieurs Go) au prochain usage.',
      autoRecreated: true, command: rmCmd(childPath), known: true,
    };
  }

  // Par défaut, l'enfant hérite de la catégorie du parent, sans commande
  return {
    category: parentClass.category, app: parentClass.app, dataType: parentClass.dataType,
    note: '', autoRecreated: parentClass.autoRecreated, known: parentClass.known,
  };
}
