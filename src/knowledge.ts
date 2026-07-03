/**
 * Knowledge base: 🟢/🟡/🔴 classification of AppData folders.
 *
 * Technical choices:
 * - Three rule tiers, applied in priority order:
 *   1. EXACT rules keyed by `root\name` (lowercase) — accumulated field
 *      knowledge (npm-cache = cache, Bitcoin = wallet, etc.);
 *   2. NAME-PATTERN rules (e.g. `*-updater` = update installers);
 *   3. GENERIC child-name heuristics (Cache, Crashpad, logs…) that work for
 *      any unknown application.
 * - Default: 🟡 "to be checked" — an unknown folder is NEVER classified 🟢.
 * - Every 🟢 rule carries a PowerShell deletion command, generated but NEVER
 *   executed by the tool itself (strict read-only analysis).
 * - Every rule provides its user-facing texts in French (`note`, `dataType`)
 *   and English (`noteEn`, `dataTypeEn`); the UI picks the active language.
 */

export type Category = 'green' | 'yellow' | 'red';

export interface Classification {
  category: Category;
  /** Application or vendor owning the folder. */
  app: string;
  /** cache | logs | temp files | configuration | user data | application | system (French label). */
  dataType: string;
  /** English translation of dataType (fallback: dataType). */
  dataTypeEn?: string;
  /** Exact consequence of deleting, shown in the report (French). */
  note: string;
  /** English translation of note (fallback: note). */
  noteEn?: string;
  /** Does the application recreate the folder automatically? */
  autoRecreated: boolean;
  /** Suggested PowerShell command (never executed by the tool). */
  command?: string;
  /**
   * true when the classification comes from an EXACT rule or a proven name
   * pattern (not a generic heuristic). "Simple mode" only offers 🟢 KNOWN
   * items for cleaning: never a guess for a novice user.
   */
  known?: boolean;
}

const GREEN = 'green' as const;
const YELLOW = 'yellow' as const;
const RED = 'red' as const;

/** Standard PowerShell removal command, path quoted. */
function rmCmd(p: string): string {
  return `Remove-Item -Recurse -Force "${p}"`;
}

type RuleFactory = (p: string) => Classification;

/**
 * Exact rules keyed by `root\name` (case-insensitive).
 * Built from real-world audits — extend as new folders are identified.
 */
const EXACT_RULES: Record<string, RuleFactory> = {
  // ---------- Local ----------
  'local\\packages': () => ({
    category: RED, app: 'Windows (apps MSIX)', dataType: 'système', dataTypeEn: 'system',
    note: 'Données des applications Windows/Store. Ne jamais supprimer manuellement — passer par Paramètres → Applications.',
    noteEn: 'Windows/Store app data. Never delete manually — use Settings → Apps instead.',
    autoRecreated: false,
  }),
  'local\\bravesoftware': () => ({
    category: YELLOW, app: 'Brave', dataType: 'profil navigateur + cache', dataTypeEn: 'browser profile + cache',
    note: 'Vider le cache DEPUIS Brave (Paramètres → Effacer les données → Images et fichiers en cache). Le profil (mots de passe, favoris) ne doit pas être supprimé à la main.',
    noteEn: 'Clear the cache FROM Brave itself (Settings → Clear browsing data → Cached images and files). The profile (passwords, bookmarks) must not be deleted by hand.',
    autoRecreated: false,
  }),
  'local\\google': () => ({
    category: YELLOW, app: 'Google (Chrome, Android Studio)', dataType: 'profil + caches IDE', dataTypeEn: 'profile + IDE caches',
    note: 'Cache Chrome à vider depuis le navigateur. Les anciens dossiers AndroidStudioX.Y sont supprimables si une version plus récente est utilisée.',
    noteEn: 'Clear the Chrome cache from the browser itself. Old AndroidStudioX.Y folders can be removed once a newer version is in use.',
    autoRecreated: false,
  }),
  'local\\yarn': (p) => ({
    category: GREEN, app: 'Yarn', dataType: 'cache de paquets', dataTypeEn: 'package cache',
    note: 'Cache de téléchargement des paquets. Recréé au prochain « yarn install ».',
    noteEn: 'Package download cache. Recreated on the next "yarn install".',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\android': () => ({
    category: RED, app: 'Android SDK', dataType: 'outils de développement', dataTypeEn: 'development tools',
    note: 'SDK nécessaire au développement Android/React Native. Gérer les composants via le SDK Manager d\'Android Studio.',
    noteEn: 'SDK required for Android/React Native development. Manage components through Android Studio\'s SDK Manager.',
    autoRecreated: false,
  }),
  'local\\npm-cache': (p) => ({
    category: GREEN, app: 'npm', dataType: 'cache de paquets', dataTypeEn: 'package cache',
    note: 'Recréé automatiquement. Préférer « npm cache clean --force » (garde la structure).',
    noteEn: 'Recreated automatically. Prefer "npm cache clean --force" (keeps the structure).',
    autoRecreated: true, command: `npm cache clean --force  # ou : ${rmCmd(p)}`,
  }),
  'local\\microsoft': () => ({
    category: RED, app: 'Microsoft (Office, Windows, Edge)', dataType: 'système', dataTypeEn: 'system',
    note: 'Mélange de données système et Office. Seuls certains sous-dossiers (TypeScript, FontCache) sont des caches sûrs — voir le détail niveau 2.',
    noteEn: 'Mix of system and Office data. Only a few subfolders (TypeScript, FontCache) are safe caches — see the level-2 detail.',
    autoRecreated: false,
  }),
  'local\\capcut': () => ({
    category: YELLOW, app: 'CapCut', dataType: 'application + projets', dataTypeEn: 'application + projects',
    note: '« User Data » contient les montages/brouillons (à ne pas perdre). Si l\'app n\'est plus utilisée, désinstaller proprement via Paramètres.',
    noteEn: '"User Data" holds your edits/drafts (do not lose them). If the app is no longer used, uninstall it properly via Settings.',
    autoRecreated: false,
  }),
  'local\\programs': () => ({
    category: RED, app: 'Applications installées (VS Code, Termius…)', dataType: 'application', dataTypeEn: 'application',
    note: 'Binaires des applications elles-mêmes. Désinstaller via Paramètres si besoin.',
    noteEn: 'The application binaries themselves. Uninstall via Settings if needed.',
    autoRecreated: false,
  }),
  'local\\githubdesktop': () => ({
    category: YELLOW, app: 'GitHub Desktop', dataType: 'application (multi-versions)', dataTypeEn: 'application (multi-version)',
    note: 'Les anciens dossiers app-X.Y.Z (restes de mises à jour Squirrel) sont supprimables ; garder la version la plus récente.',
    noteEn: 'Old app-X.Y.Z folders (Squirrel update leftovers) can be removed; keep the most recent version.',
    autoRecreated: false,
  }),
  'local\\postman': () => ({
    category: YELLOW, app: 'Postman', dataType: 'application (multi-versions)', dataTypeEn: 'application (multi-version)',
    note: 'Les anciens dossiers app-X.Y.Z sont supprimables ; garder la version la plus récente.',
    noteEn: 'Old app-X.Y.Z folders can be removed; keep the most recent version.',
    autoRecreated: false,
  }),
  'local\\dropbox': () => ({
    category: RED, app: 'Dropbox', dataType: 'base de synchronisation', dataTypeEn: 'sync database',
    note: '« instance1 » = base de sync (ne pas toucher). Seul « Crashpad » (dumps de crash) est supprimable — voir niveau 2.',
    noteEn: '"instance1" is the sync database (do not touch). Only "Crashpad" (crash dumps) is removable — see level 2.',
    autoRecreated: false,
  }),
  'local\\ms-playwright': (p) => ({
    category: YELLOW, app: 'Playwright', dataType: 'navigateurs de test', dataTypeEn: 'test browsers',
    note: 'Supprimable ; « npx playwright install » les retélécharge (plusieurs centaines de Mo).',
    noteEn: 'Removable; "npx playwright install" re-downloads them (several hundred MB).',
    autoRecreated: false, command: rmCmd(p),
  }),
  'local\\pip': (p) => ({
    category: GREEN, app: 'pip (Python)', dataType: 'cache de paquets', dataTypeEn: 'package cache',
    note: 'Recréé automatiquement. Préférer « pip cache purge ».',
    noteEn: 'Recreated automatically. Prefer "pip cache purge".',
    autoRecreated: true, command: `pip cache purge  # ou : ${rmCmd(p)}`,
  }),
  'local\\node-gyp': (p) => ({
    category: GREEN, app: 'node-gyp', dataType: 'cache (headers Node)', dataTypeEn: 'cache (Node headers)',
    note: 'Retéléchargé à la prochaine compilation de module natif.',
    noteEn: 'Re-downloaded on the next native module build.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\temp': () => ({
    category: GREEN, app: 'Windows / divers', dataType: 'temporaires', dataTypeEn: 'temporary files',
    note: 'Fichiers temporaires. Supprimer le CONTENU (certains fichiers de sessions actives seront verrouillés, c\'est normal). Recréé en permanence.',
    noteEn: 'Temporary files. Delete the CONTENTS (files from active sessions will stay locked, that\'s normal). Constantly recreated.',
    autoRecreated: true, command: 'Get-ChildItem "$env:LOCALAPPDATA\\Temp" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
  }),
  'local\\squirreltemp': (p) => ({
    category: GREEN, app: 'Installeurs Electron (Squirrel)', dataType: 'temporaires', dataTypeEn: 'temporary files',
    note: 'Restes d\'installations d\'apps Electron. Recréé au besoin lors des prochaines installations.',
    noteEn: 'Leftovers from Electron app installs. Recreated as needed by future installs.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\gitkrakencli': () => ({
    category: YELLOW, app: 'GitKraken CLI', dataType: 'application (versions)', dataTypeEn: 'application (versions)',
    note: 'Garder si l\'outil est utilisé ; sinon désinstaller.',
    noteEn: 'Keep if the tool is in use; otherwise uninstall it.',
    autoRecreated: false,
  }),
  'local\\nuget': (p) => ({
    category: GREEN, app: 'NuGet (.NET)', dataType: 'cache de paquets', dataTypeEn: 'package cache',
    note: 'Recréé au prochain restore .NET.',
    noteEn: 'Recreated on the next .NET restore.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\hardhat-nodejs': (p) => ({
    category: GREEN, app: 'Hardhat (dev blockchain)', dataType: 'cache', dataTypeEn: 'cache',
    note: 'Cache de compilateurs Solidity. Retéléchargé au besoin.',
    noteEn: 'Solidity compiler cache. Re-downloaded when needed.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\cloud-code': () => ({
    category: YELLOW, app: 'Google Cloud Code / Gemini CLI', dataType: 'outil', dataTypeEn: 'tool',
    note: 'Garder si utilisé récemment.',
    noteEn: 'Keep if recently used.',
    autoRecreated: false,
  }),
  'local\\synologydrive': () => ({
    category: RED, app: 'Synology Drive', dataType: 'application + base de sync', dataTypeEn: 'application + sync database',
    note: 'Application de synchronisation NAS. Ne pas toucher si utilisée.',
    noteEn: 'NAS sync application. Do not touch if in use.',
    autoRecreated: false,
  }),
  'local\\mozilla': () => ({
    category: YELLOW, app: 'Firefox', dataType: 'cache navigateur', dataTypeEn: 'browser cache',
    note: 'Partie cache du profil Firefox. Vider depuis Firefox (Paramètres → Vie privée → Effacer les données).',
    noteEn: 'Cache part of the Firefox profile. Clear it from Firefox (Settings → Privacy → Clear Data).',
    autoRecreated: true,
  }),
  'local\\crashdumps': (p) => ({
    category: GREEN, app: 'Windows', dataType: 'dumps de crash', dataTypeEn: 'crash dumps',
    note: 'Vidages mémoire d\'applications plantées. Recréé au prochain crash.',
    noteEn: 'Memory dumps from crashed applications. Recreated on the next crash.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\connecteddevicesplatform': () => ({
    category: RED, app: 'Windows (appareils connectés)', dataType: 'système', dataTypeEn: 'system',
    note: 'Synchronisation d\'activités Windows. Ne pas toucher.',
    noteEn: 'Windows activity sync. Do not touch.',
    autoRecreated: false,
  }),
  'local\\comms': () => ({
    category: RED, app: 'Windows (Courrier/Calendrier)', dataType: 'système', dataTypeEn: 'system',
    note: 'Base des applications de communication Windows. Ne pas toucher.',
    noteEn: 'Database of Windows communication apps. Do not touch.',
    autoRecreated: false,
  }),
  'local\\pgadmin4': () => ({
    category: YELLOW, app: 'pgAdmin 4', dataType: 'configuration', dataTypeEn: 'configuration',
    note: 'Peut contenir des connexions serveur enregistrées. Supprimer seulement si pgAdmin n\'est plus utilisé.',
    noteEn: 'May contain saved server connections. Delete only if pgAdmin is no longer used.',
    autoRecreated: false,
  }),
  'local\\tortoisegit': () => ({
    category: YELLOW, app: 'TortoiseGit', dataType: 'configuration/cache', dataTypeEn: 'configuration/cache',
    note: 'Supprimable si TortoiseGit n\'est plus utilisé.',
    noteEn: 'Removable if TortoiseGit is no longer used.',
    autoRecreated: false,
  }),
  'local\\meltytech': () => ({
    category: YELLOW, app: 'Shotcut', dataType: 'configuration', dataTypeEn: 'configuration',
    note: 'Réglages de l\'éditeur vidéo Shotcut. Supprimable si l\'app n\'est plus utilisée (perte des préférences).',
    noteEn: 'Shotcut video editor settings. Removable if the app is no longer used (preferences will be lost).',
    autoRecreated: false,
  }),
  'local\\neo': (p) => ({
    category: GREEN, app: 'Pilote Intel (NEO)', dataType: 'cache de compilation GPU', dataTypeEn: 'GPU compiler cache',
    note: 'Cache du compilateur OpenCL Intel. Recréé automatiquement.',
    noteEn: 'Intel OpenCL compiler cache. Recreated automatically.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'local\\cef': () => ({
    category: YELLOW, app: 'Chromium Embedded Framework', dataType: 'données d\'app embarquée', dataTypeEn: 'embedded app data',
    note: 'Utilisé par une app tierce (souvent Spotify/jeux). Supprimable si ancien — l\'app propriétaire le recréera.',
    noteEn: 'Used by a third-party app (often Spotify/games). Removable if old — the owning app will recreate it.',
    autoRecreated: true,
  }),
  'local\\d3dscache': (p) => ({
    category: GREEN, app: 'DirectX', dataType: 'cache de shaders', dataTypeEn: 'shader cache',
    note: 'Recréé automatiquement par le pilote graphique.',
    noteEn: 'Recreated automatically by the graphics driver.',
    autoRecreated: true, command: rmCmd(p),
  }),

  // ---------- Roaming ----------
  'roaming\\claude': () => ({
    category: YELLOW, app: 'Claude Desktop', dataType: 'données d\'application + VM', dataTypeEn: 'application data + VM',
    note: '« vm_bundles » (VM Cowork) est le gros morceau : supprimable, retéléchargé au prochain usage du mode agent local. Les caches (Cache, Code Cache) sont 🟢. Attention : peut être un miroir MSIX de Local\\Packages\\Claude_… (même contenu physique).',
    noteEn: '"vm_bundles" (Cowork VM) is the big one: removable, re-downloaded next time local agent mode is used. Caches (Cache, Code Cache) are 🟢. Careful: may be an MSIX mirror of Local\\Packages\\Claude_… (same physical content).',
    autoRecreated: true,
  }),
  'roaming\\code': () => ({
    category: YELLOW, app: 'Visual Studio Code', dataType: 'configuration + caches', dataTypeEn: 'configuration + caches',
    note: '« User » = réglages/keybindings (🔴). Les caches (CachedExtensionVSIXs, Crashpad, Cache, CachedData) sont 🟢 — voir le détail niveau 2. Fermer VS Code avant.',
    noteEn: '"User" holds settings/keybindings (🔴). Caches (CachedExtensionVSIXs, Crashpad, Cache, CachedData) are 🟢 — see level-2 detail. Close VS Code first.',
    autoRecreated: false,
  }),
  'roaming\\nvm': () => ({
    category: YELLOW, app: 'nvm-windows', dataType: 'versions de Node.js', dataTypeEn: 'Node.js versions',
    note: 'Désinstaller les versions obsolètes avec « nvm uninstall <version> » (vérifier d\'abord la version active avec « nvm list »).',
    noteEn: 'Uninstall obsolete versions with "nvm uninstall <version>" (check the active version first with "nvm list").',
    autoRecreated: false, command: 'nvm list  # puis : nvm uninstall <version>',
  }),
  'roaming\\microsoft': () => ({
    category: RED, app: 'Microsoft (Office, Windows)', dataType: 'système + modèles Office', dataTypeEn: 'system + Office templates',
    note: 'Contient Credentials/Crypto/Vault (🔴 absolu). Exception : « Teams » (Teams classique abandonné) est supprimable — voir niveau 2.',
    noteEn: 'Contains Credentials/Crypto/Vault (absolute 🔴). Exception: "Teams" (deprecated classic Teams) is removable — see level 2.',
    autoRecreated: false,
  }),
  'roaming\\python': () => ({
    category: YELLOW, app: 'Python (pip --user)', dataType: 'paquets installés', dataTypeEn: 'installed packages',
    note: 'Paquets installés en « pip install --user ». Supprimer casse ces paquets — réinstallation nécessaire.',
    noteEn: 'Packages installed with "pip install --user". Deleting breaks them — reinstall required.',
    autoRecreated: false,
  }),
  'roaming\\npm': () => ({
    category: YELLOW, app: 'npm (paquets globaux)', dataType: 'paquets installés', dataTypeEn: 'installed packages',
    note: 'Paquets « npm install -g ». Lister avec « npm ls -g » et désinstaller ceux qui ne servent plus.',
    noteEn: 'Packages from "npm install -g". List them with "npm ls -g" and uninstall the unused ones.',
    autoRecreated: false, command: 'npm ls -g --depth=0  # puis : npm uninstall -g <paquet>',
  }),
  'roaming\\dropbox': () => ({
    category: YELLOW, app: 'Dropbox (webview)', dataType: 'cache/session', dataTypeEn: 'cache/session',
    note: '« Partitions » = données de la webview. Supprimable Dropbox fermé ; possible reconnexion au compte.',
    noteEn: '"Partitions" is webview data. Removable with Dropbox closed; you may have to sign in again.',
    autoRecreated: true,
  }),
  'roaming\\postman': () => ({
    category: YELLOW, app: 'Postman', dataType: 'session', dataTypeEn: 'session',
    note: '« Partitions » supprimable mais déconnexion du compte Postman (les collections sont dans le cloud).',
    noteEn: '"Partitions" is removable but you will be signed out of Postman (collections live in the cloud).',
    autoRecreated: true,
  }),
  'roaming\\bitcoin': () => ({
    category: RED, app: 'Bitcoin Core', dataType: 'données utilisateur (wallet !)', dataTypeEn: 'user data (wallet!)',
    note: 'Contient « wallets » : NE JAMAIS SUPPRIMER sans sauvegarde vérifiée. Perte potentiellement irréversible de fonds.',
    noteEn: 'Contains "wallets": NEVER DELETE without a verified backup. Potentially irreversible loss of funds.',
    autoRecreated: false,
  }),
  'roaming\\ledger live': () => ({
    category: RED, app: 'Ledger Live', dataType: 'application crypto', dataTypeEn: 'crypto application',
    note: 'App de gestion de wallet matériel. Les clés sont sur le Ledger, mais par prudence ne pas toucher aux données de l\'app.',
    noteEn: 'Hardware wallet management app. Keys live on the Ledger device, but as a precaution do not touch the app data.',
    autoRecreated: false,
  }),
  'roaming\\ccleaner': (p) => ({
    category: GREEN, app: 'CCleaner', dataType: 'cache webview', dataTypeEn: 'webview cache',
    note: '« EBWebView » = cache Edge WebView de l\'interface. Recréé au lancement.',
    noteEn: '"EBWebView" is the UI\'s Edge WebView cache. Recreated at launch.',
    autoRecreated: true, command: rmCmd(`${p}\\EBWebView`),
  }),
  'roaming\\mozilla': () => ({
    category: RED, app: 'Firefox', dataType: 'profil (favoris, mots de passe)', dataTypeEn: 'profile (bookmarks, passwords)',
    note: 'Profil Firefox : favoris, mots de passe, extensions. Ne pas supprimer à la main.',
    noteEn: 'Firefox profile: bookmarks, passwords, extensions. Do not delete by hand.',
    autoRecreated: false,
  }),
  'roaming\\termius': () => ({
    category: RED, app: 'Termius', dataType: 'configuration SSH', dataTypeEn: 'SSH configuration',
    note: 'Peut contenir hôtes/identités SSH locales. Ne pas toucher.',
    noteEn: 'May contain local SSH hosts/identities. Do not touch.',
    autoRecreated: false,
  }),
  'roaming\\netlify': () => ({
    category: YELLOW, app: 'Netlify CLI', dataType: 'configuration + tokens', dataTypeEn: 'configuration + tokens',
    note: 'Contient le token d\'auth CLI. Supprimable si la CLI n\'est plus utilisée (re-login nécessaire).',
    noteEn: 'Contains the CLI auth token. Removable if the CLI is no longer used (re-login required).',
    autoRecreated: true,
  }),
  'roaming\\github desktop': () => ({
    category: YELLOW, app: 'GitHub Desktop', dataType: 'configuration + caches', dataTypeEn: 'configuration + caches',
    note: 'Caches supprimables (niveau 2) ; le reste = session GitHub.',
    noteEn: 'Caches are removable (level 2); the rest is your GitHub session.',
    autoRecreated: true,
  }),
  'roaming\\truffle-nodejs': (p) => ({
    category: GREEN, app: 'Truffle (dev blockchain)', dataType: 'configuration/cache', dataTypeEn: 'configuration/cache',
    note: 'Outil probablement abandonné (Truffle est déprécié). Recréé si réutilisé.',
    noteEn: 'Likely abandoned tool (Truffle is deprecated). Recreated if used again.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\airdroid': (p) => ({
    category: GREEN, app: 'AirDroid', dataType: 'logs + cache', dataTypeEn: 'logs + cache',
    note: 'Restes d\'application. Supprimable si AirDroid n\'est plus utilisé.',
    noteEn: 'Application leftovers. Removable if AirDroid is no longer used.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\com.adobe.dunamis': (p) => ({
    category: GREEN, app: 'Adobe (télémétrie)', dataType: 'télémétrie', dataTypeEn: 'telemetry',
    note: 'Données d\'analytics Adobe (SDK Dunamis). Recréé par Acrobat au prochain lancement.',
    noteEn: 'Adobe analytics data (Dunamis SDK). Recreated by Acrobat on next launch.',
    autoRecreated: true, command: rmCmd(p),
  }),
  'roaming\\ipfs desktop': (p) => ({
    category: GREEN, app: 'IPFS Desktop (désinstallé ?)', dataType: 'restes d\'application', dataTypeEn: 'app leftovers',
    note: 'Si l\'application n\'apparaît plus dans Programs, ce sont des données orphelines.',
    noteEn: 'If the application no longer appears in Programs, this is orphaned data.',
    autoRecreated: false, command: rmCmd(p),
  }),
  'roaming\\windsurf': () => ({
    category: YELLOW, app: 'Windsurf (IDE)', dataType: 'configuration + caches', dataTypeEn: 'configuration + caches',
    note: 'Supprimable si l\'éditeur n\'est plus utilisé (perte des réglages).',
    noteEn: 'Removable if the editor is no longer used (settings will be lost).',
    autoRecreated: false,
  }),

  // ---------- LocalLow ----------
  'locallow\\intel': (p) => ({
    category: GREEN, app: 'Intel (pilote graphique)', dataType: 'cache de shaders', dataTypeEn: 'shader cache',
    note: 'ShaderCache recréé automatiquement par le pilote.',
    noteEn: 'ShaderCache is recreated automatically by the driver.',
    autoRecreated: true, command: rmCmd(`${p}\\ShaderCache`),
  }),
  'locallow\\adobe': () => ({
    category: YELLOW, app: 'Adobe Acrobat', dataType: 'configuration + cache', dataTypeEn: 'configuration + cache',
    note: 'Petit ; supprimable si Acrobat n\'est plus utilisé.',
    noteEn: 'Small; removable if Acrobat is no longer used.',
    autoRecreated: true,
  }),
};

/** Name-pattern rules for level-1 folders. */
const PATTERN_RULES: Array<{ test: (name: string) => boolean; make: (p: string, name: string) => Classification }> = [
  {
    // xxx-updater: update-installer caches (electron-updater), always regenerated
    test: (n) => /-updater$/i.test(n),
    make: (p, n) => ({
      category: GREEN,
      app: n.replace(/-updater$/i, ''),
      dataType: 'installeurs de mise à jour', dataTypeEn: 'update installers',
      note: 'Cache de mises à jour téléchargées. Recréé à la prochaine mise à jour de l\'application.',
      noteEn: 'Downloaded-update cache. Recreated on the application\'s next update.',
      autoRecreated: true,
      command: rmCmd(p),
    }),
  },
  {
    test: (n) => /^npm-cache$/i.test(n),
    make: (p) => ({
      category: GREEN, app: 'npm', dataType: 'cache de paquets', dataTypeEn: 'package cache',
      note: 'Recréé automatiquement.', noteEn: 'Recreated automatically.',
      autoRecreated: true, command: rmCmd(p),
    }),
  },
];

/** Generic heuristics on level-2 subfolder names. */
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

/** Classifies a level-1 folder. */
export function classifyTop(root: string, name: string, fullPath: string): Classification {
  const key = `${root.toLowerCase()}\\${name.toLowerCase()}`;
  const exact = EXACT_RULES[key];
  if (exact) return { ...exact(fullPath), known: true };

  for (const rule of PATTERN_RULES) {
    if (rule.test(name)) return { ...rule.make(fullPath, name), known: true };
  }

  // Cautious default: never 🟢 for an unknown folder
  return {
    category: YELLOW,
    app: name,
    dataType: 'inconnu — à vérifier', dataTypeEn: 'unknown — verify manually',
    note: 'Application non répertoriée dans la base de règles. Vérifier manuellement avant toute suppression.',
    noteEn: 'Application not listed in the rule base. Verify manually before deleting anything.',
    autoRecreated: false,
    known: false,
  };
}

/** Classifies a level-2 subfolder (generic heuristics). */
export function classifyChild(parentClass: Classification, childName: string, childPath: string): Classification {
  const n = childName.toLowerCase();

  if (CHILD_RED.has(n)) {
    return {
      category: RED, app: parentClass.app, dataType: 'données utilisateur', dataTypeEn: 'user data',
      note: 'Données applicatives (profil, base, wallet…). Ne pas supprimer à la main.',
      noteEn: 'Application data (profile, database, wallet…). Do not delete by hand.',
      autoRecreated: false, known: parentClass.known,
    };
  }
  if (CHILD_GREEN.has(n)) {
    return {
      category: GREEN, app: parentClass.app, dataType: 'cache / logs', dataTypeEn: 'cache / logs',
      note: 'Cache ou journaux — recréé automatiquement par l\'application (la fermer avant).',
      noteEn: 'Cache or logs — recreated automatically by the application (close it first).',
      autoRecreated: true, command: rmCmd(childPath),
      // Name heuristic: "known" only if the parent application is known
      known: parentClass.known,
    };
  }
  if (CHILD_YELLOW.has(n)) {
    return {
      category: YELLOW, app: parentClass.app, dataType: 'stockage local / session', dataTypeEn: 'local storage / session',
      note: 'Supprimable mais conséquence probable : déconnexion ou perte d\'état local de l\'application.',
      noteEn: 'Removable, but likely consequence: sign-out or loss of the application\'s local state.',
      autoRecreated: true, known: parentClass.known,
    };
  }
  // Special case: Claude Desktop VM bundles (large, re-downloaded)
  if (n === 'vm_bundles') {
    return {
      category: YELLOW, app: parentClass.app, dataType: 'images VM (Cowork)', dataTypeEn: 'VM images (Cowork)',
      note: 'Bundle VM du mode agent local. Supprimable (app fermée) ; retéléchargé (plusieurs Go) au prochain usage.',
      noteEn: 'Local agent mode VM bundle. Removable (app closed); re-downloaded (several GB) on next use.',
      autoRecreated: true, command: rmCmd(childPath), known: true,
    };
  }

  // Default: the child inherits the parent's category, without a command
  return {
    category: parentClass.category, app: parentClass.app,
    dataType: parentClass.dataType, dataTypeEn: parentClass.dataTypeEn,
    note: '', noteEn: '', autoRecreated: parentClass.autoRecreated, known: parentClass.known,
  };
}
