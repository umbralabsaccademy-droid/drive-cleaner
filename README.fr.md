<p align="center">
  <a href="https://www.academy.umbra-labs.dev/"><img src="assets/logo_umbra_labs.png" alt="Umbra Labs" width="160"></a>
</p>

# 👻 GhostTrace

> Supprimez fichiers inutiles et traces de télémétrie sur Windows **sans jamais risquer vos données** — analyse en lecture seule, nettoyage via la Corbeille uniquement, 100 % local, open source.

**🌍 Langues :** [English](README.md) · Français (ce fichier) — l'application elle-même est bilingue (FR/EN, détection automatique, commutable).

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

## Installation

### Option 1 — Exécutable (recommandé)

Téléchargez `ghosttrace-vX.Y.Z.exe` depuis la [dernière release](../../releases/latest), puis **double-cliquez** : l'interface s'ouvre dans une fenêtre d'application (le serveur local se lance en arrière-plan et s'arrête tout seul à la fermeture).

Chaque release est **construite depuis les sources par la CI publique GitHub Actions** ([.github/workflows/release.yml](.github/workflows/release.yml)) — les logs de build sont auditables. Vérifiez votre téléchargement avec le `SHA256SUMS.txt` publié :

```powershell
Get-FileHash .\ghosttrace-v2.1.0.exe -Algorithm SHA256
```

> ⚠️ **SmartScreen** : l'exécutable n'est pas signé numériquement (la signature coûte ~300 €/an). Windows affichera « application non reconnue » au premier lancement → « Informations complémentaires » → « Exécuter quand même ». C'est précisément pour ça que le code est open source et les builds reproductibles : auditez-le, ou construisez l'exe vous-même (option 2).

### Option 2 — Depuis les sources

Prérequis : [Node.js](https://nodejs.org/) ≥ 22.18. Aucune dépendance à installer.

```powershell
git clone https://github.com/umbralabsaccademy-droid/drive-cleaner.git
cd drive-cleaner

npm run serve        # tableau de bord web → http://localhost:7113
npm run scan:open    # ou : scan console + rapport HTML
npm run build:exe    # construire votre propre exe (dist\ghosttrace.exe)
```

Lancez en **administrateur** pour mesurer aussi la corbeille complète, les zones Windows, les points de restauration et le Prefetch (un bouton « Relancer en admin » existe aussi dans l'interface).

## Le contrat de sécurité

| Garantie | Où c'est appliqué |
|---|---|
| L'**analyse** ne modifie jamais rien (lecture seule) | [src/scanner.ts](src/scanner.ts) — uniquement `readdir`/`stat` |
| Le **nettoyage** passe exclusivement par la Corbeille | [src/cleaner.ts](src/cleaner.ts) — API .NET `SendToRecycleBin` |
| Le serveur ne peut supprimer que des éléments **identifiés par le dernier scan** | [src/server.ts](src/server.ts) — validation par identifiant |
| Un dossier **inconnu** n'est jamais « sans risque » ; le mode Simple exige une règle exacte | [src/knowledge.ts](src/knowledge.ts) + [src/actionables.ts](src/actionables.ts) |

S'y ajoutent : serveur limité à `127.0.0.1`, endpoints d'action protégés contre le CSRF, validation stricte des noms de fichiers servis.

## Contribuer

La contribution la plus utile : **enrichir la base de règles** ([src/knowledge.ts](src/knowledge.ts)) — ajoutez une entrée dans `EXACT_RULES` avec la clé `root\nom` en minuscules, en fournissant les textes en français (`note`) **et** en anglais (`noteEn`). Règles d'or : un inconnu n'est jamais 🟢, une donnée utilisateur est toujours 🔴, en cas de doute 🟡 avec la conséquence écrite noir sur blanc.

Le détail complet (FAQ, architecture, options CLI) est dans le [README anglais](README.md).

## Licence

[MIT](LICENSE) — faites-en ce que vous voulez : utiliser, modifier, redistribuer, y compris commercialement. Gardez juste la notice de licence.

---

Créé par **[Umbra Labs](https://www.academy.umbra-labs.dev/)** · Suivez [@xumbralabs](https://x.com/xumbralabs) · ⭐ si l'outil vous a libéré des gigas !
