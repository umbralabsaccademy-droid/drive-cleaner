# 🧹 Nettoyeur d'espace disque

> Libérez des gigaoctets sur Windows **sans jamais risquer vos données** — analyse en lecture seule, nettoyage via la Corbeille uniquement, 100 % local, open source.

[![Licence MIT](https://img.shields.io/badge/licence-MIT-green.svg)](LICENSE)
![Plateforme](https://img.shields.io/badge/plateforme-Windows%2010%2F11-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-brightgreen.svg)
![Dépendances](https://img.shields.io/badge/d%C3%A9pendances-0-orange.svg)

Un outil [Umbra Labs](https://www.academy.umbra-labs.dev/) — [@xumbralabs](https://x.com/xumbralabs)

---

## Pourquoi cet outil ?

Les nettoyeurs de disque classiques sont des boîtes noires : on ne sait ni ce qu'ils suppriment, ni pourquoi, ni ce qu'ils envoient chez eux. Celui-ci prend le contre-pied :

- 🔍 **Transparent** — chaque élément proposé est expliqué : à quelle application il appartient, pourquoi il est supprimable, ce qui se passera après. Le code est ouvert, lisez-le.
- ♻️ **Réversible** — tout ce qui est nettoyé part dans la **Corbeille** (récupérable ~30 jours). Jamais de suppression définitive.
- 🔒 **Local** — aucune connexion réseau sortante, aucune télémétrie, aucun compte. Le serveur web intégré n'écoute que sur `127.0.0.1`.
- 🧠 **Prudent par conception** — un dossier inconnu n'est **jamais** classé « supprimable sans risque ». Les profils, mots de passe, wallets et données utilisateur sont détectés et intouchables.
- 📦 **Zéro dépendance** — Node.js standard uniquement. Pas de `node_modules`, pas de supply chain à auditer.

## Deux modes, deux publics

**Mode Simple** (par défaut) — pour tout le monde : un bouton « Analyser mon ordinateur », des explications en français courant, et seuls les éléments **certifiés sans risque** par la base de règles sont proposés. Écrans d'explication au premier lancement.

**Mode Expert** (sélecteur en haut à droite) — pour les technophiles : détail complet par dossier (AppData niveaux 1-2, caches développeur, zones système, applications inutilisées), catégories 🟢/🟡/🔴, commandes PowerShell prêtes à copier, rapports HTML/JSON archivables, suivi de l'évolution entre les scans, relance en admin.

## Fonctionnalités

- Analyse d'**AppData** (Local, LocalLow, Roaming) avec classification par une base de ~60 règles + heuristiques prudentes
- Détection des **miroirs MSIX** (même contenu physique compté deux fois) par comparaison d'inodes NTFS
- **Caches développeur** : `node_modules` orphelins, caches Gradle/Maven/NuGet/pip/Expo, images d'émulateur Android, disques virtuels WSL/Docker (avec procédure de compactage)
- **Zones système** : restes Windows Update, corbeille, dumps de crash, `hiberfil.sys`, points de restauration (admin)
- **Applications inutilisées** : inventaire du registre croisé avec les traces d'exécution (UserAssist, Prefetch) — conseils de désinstallation, jamais d'action automatique
- **Suivi dans le temps** : chaque scan est historisé ; le rapport montre ce qui a grossi depuis le précédent
- **Journal des nettoyages** avec bouton « Ouvrir la Corbeille »

## Installation

### Option 1 — Exécutable (recommandé)

Téléchargez `appdata-analyzer.exe` depuis les [Releases](../../releases), puis **double-cliquez** : l'interface s'ouvre dans une fenêtre d'application (le serveur local se lance en arrière-plan et s'arrête tout seul à la fermeture).

> ⚠️ **SmartScreen** : l'exécutable n'est pas signé numériquement (la signature de code coûte ~300 €/an). Windows affichera « application non reconnue » au premier lancement → « Informations complémentaires » → « Exécuter quand même ». C'est précisément pour ça que le code est open source : vous pouvez l'auditer et construire l'exe vous-même (option 2).

### Option 2 — Depuis les sources

Prérequis : [Node.js](https://nodejs.org/) ≥ 22.18 (exécution TypeScript native). Aucune dépendance à installer.

```powershell
git clone https://github.com/umbralabsaccademy-droid/drive-cleaner.git
cd drive-cleaner

npm run serve        # tableau de bord web → http://localhost:7113
npm run scan:open    # ou : scan console + rapport HTML
npm run build:exe    # construire votre propre exe (dist\appdata-analyzer.exe)
```

`build:exe` utilise Node SEA (Single Executable Application) : `esbuild` bundle les sources, `postject` injecte le résultat dans une copie de `node.exe` — outils invoqués en one-shot via `npx`, rien n'est ajouté au projet.

### Options de ligne de commande

```
appdata-analyzer [--serve] [--port 7113] [--open] [--auto-exit]
                 [--path <AppData>] [--out <dossier>] [--workspaces <dossier>]
                 [--skip dev,system,apps,history] [--concurrency 32]
```

Lancez en **administrateur** pour mesurer aussi la corbeille complète, les zones Windows, les points de restauration et le Prefetch (un bouton « Relancer en admin » existe aussi dans l'interface).

## Le contrat de sécurité

C'est la partie importante. L'outil s'engage sur quatre garanties, vérifiables dans le code :

| Garantie | Où c'est appliqué |
|---|---|
| L'**analyse** ne modifie jamais rien (lecture seule) | [src/scanner.ts](src/scanner.ts) — uniquement `readdir`/`stat` |
| Le **nettoyage** passe exclusivement par la Corbeille | [src/cleaner.ts](src/cleaner.ts) — API .NET `SendToRecycleBin` |
| Le serveur ne peut supprimer que des éléments **identifiés par le dernier scan** (jamais un chemin arbitraire envoyé par un client) | [src/server.ts](src/server.ts) — validation par id |
| Un dossier **inconnu** n'est jamais « sans risque » ; le mode Simple exige une règle exacte | [src/knowledge.ts](src/knowledge.ts) + [src/actionables.ts](src/actionables.ts) |

S'y ajoutent : serveur limité à `127.0.0.1`, endpoints d'action protégés contre le CSRF (header custom → preflight CORS), validation stricte des noms de fichiers servis (pas de traversée de chemin).

## Architecture

```
src/
├── cli.ts          Point d'entrée : double-clic → serveur masqué + fenêtre app ; console ; --serve
├── pipeline.ts     Orchestration du scan complet, événements de progression
├── scanner.ts      Parcours disque asynchrone (pool concurrent, jonctions ignorées, erreurs tolérées)
├── knowledge.ts    ⭐ Base de règles de classification 🟢/🟡/🔴 (~60 règles + heuristiques)
├── dedupe.ts       Détection des miroirs MSIX par inode NTFS
├── devcaches.ts    Module caches développeur
├── system.ts       Module zones système (détection d'élévation admin)
├── apps.ts         Module applications installées (registre + UserAssist + Prefetch)
├── history.ts      Historique des scans (JSONL append-only) et calcul d'évolution
├── actionables.ts  Éléments nettoyables + garde-fous du mode simple + libellés grand public
├── cleaner.ts      Envoi à la Corbeille (séquentiel, résultats vérifiés)
├── report.ts       Analyse + rapport HTML autonome
├── server.ts       Tableau de bord web (http natif, SSE, double interface simple/expert)
└── types.ts        Types partagés
```

## Contribuer

La contribution la plus utile : **enrichir la base de règles** ([src/knowledge.ts](src/knowledge.ts)). Vous connaissez un dossier d'AppData non répertorié ? Ajoutez une entrée dans `EXACT_RULES` avec la clé `root\nom` en minuscules :

```ts
'roaming\\monapp': (p) => ({
  category: GREEN,                      // green | yellow | red
  app: 'MonApp', dataType: 'cache',
  note: 'Conséquence exacte de la suppression.',
  autoRecreated: true,                  // recréé automatiquement ?
  command: rmCmd(p),                    // uniquement si suppression pure
}),
```

Règles d'or du projet : un inconnu n'est jamais 🟢, une donnée utilisateur (profil, wallet, identifiants) est toujours 🔴, et en cas de doute on choisit 🟡 avec la conséquence écrite noir sur blanc.

Issues et pull requests bienvenues. Pas de dépendance externe — c'est un principe, pas un oubli.

## FAQ

**Pourquoi l'exe fait 83 Mo ?** Il embarque le runtime Node.js complet (Node SEA) : aucun prérequis sur votre machine en échange.

**Mon antivirus tique.** Exe non signé + construit par injection dans node.exe = heuristiques parfois grognonnes. Le code est ouvert, construisez l'exe vous-même si vous préférez.

**Des données sont-elles envoyées quelque part ?** Non. Aucune requête réseau sortante — vérifiable dans le code (le seul serveur est local).

**Les fichiers nettoyés reviennent !** C'est normal : caches et fichiers temporaires se régénèrent avec l'usage. L'outil vous le dit honnêtement — repassez tous les deux-trois mois.

**Linux/macOS ?** Non — l'outil est spécifique à Windows (AppData, Corbeille, registre, MSIX).

## Licence

[MIT](LICENSE) — faites-en ce que vous voulez : utiliser, modifier, redistribuer, y compris commercialement. Gardez juste la notice de licence.

---

Créé par **[Umbra Labs](https://www.academy.umbra-labs.dev/)** · Suivez [@xumbralabs](https://x.com/xumbralabs) pour les mises à jour · ⭐ si l'outil vous a libéré des gigas !
