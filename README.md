<p align="center">
  <a href="https://www.academy.umbra-labs.dev/"><img src="assets/logo_umbra_labs.png" alt="Umbra Labs" width="160"></a>
</p>

# 👻 GhostTrace

> See exactly what tracks you on Windows — cookies, browsing history, Prefetch, activity timeline — and clear gigabytes of ordinary junk alongside it, **without ever risking your data**. Read-only analysis, cleanup through the Recycle Bin only, 100% local, open source.

**🌍 Languages:** English (this file) · [Français](README.fr.md) — the app itself is bilingual (FR/EN, auto-detected, switchable).

[![Latest release](https://img.shields.io/github/v/release/umbralabsaccademy-droid/drive-cleaner?label=download)](../../releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-orange.svg)
![Privacy](https://img.shields.io/badge/privacy-cookies%2C%20history%2C%20Prefetch...-8a2be2.svg)

An [Umbra Labs](https://www.academy.umbra-labs.dev/) tool — [@xumbralabs](https://x.com/xumbralabs)

---

## Why this tool?

Classic disk cleaners are black boxes: you don't know what they delete, why, or what they phone home. This one takes the opposite stance:

- 🔍 **Transparent** — every suggested item is explained: which application owns it, why it's removable, what happens afterwards. The code is open — read it.
- 🕵️ **Privacy-aware** — cookies, browsing history, saved sessions, Prefetch, Windows Timeline and more are detected across Chrome, Edge and Firefox, each explained in plain language: what it's actually *for*, not just whether it's "safe" to delete.
- ♻️ **Reversible** — everything cleaned goes to the **Recycle Bin** (recoverable for ~30 days). Never a permanent delete.
- 🔒 **Local** — no outbound network connection, no telemetry, no account. The built-in web server only listens on `127.0.0.1`.
- 🧠 **Cautious by design** — an unknown folder is **never** classified "safe to delete". Profiles, passwords, wallets and user data are detected and untouchable.
- 📦 **Zero dependencies** — standard Node.js only. No `node_modules`, no supply chain to audit.

## 🕵️ Privacy traces, explained — not just deleted

Most cleaners either ignore browsing/activity traces entirely, or wipe them blindly. GhostTrace does neither:

- **Detects them specifically** — cookies, browsing/search history, saved sessions, site storage, favicons and top sites for **Chrome, Edge and Firefox**; plus Windows-level traces: **Prefetch** (a log of every program you've recently run), **Recent files & Jump Lists**, the **thumbnail cache**, **Windows Timeline/Activity History**, and **clipboard history**.
- **Explains what each file is actually for**, before you decide anything — e.g. *"A site sets this cookie to recognize you across visits — staying logged in, remembering a cart — but also, very often, to track your browsing for advertising purposes."* The goal is understanding, not just a delete button.
- **Draws a hard line on what it will never touch**: saved passwords, saved payment/autofill data, and Firefox's `places.sqlite` (which mixes browsing history with your bookmarks in a single file) are shown for your information but **never** offered for deletion — that's not tracking, it's data you'd actually miss.
- **Warns you about consequences that matter** — clearing cookies logs you out everywhere; a running browser means its files are locked — instead of a generic "done" message.
- **Kept visually distinct from disk-space cleanup** in both modes — 💾 *Disk space* and 🕵️ *Privacy* are always shown as two separate groups, so you always know which kind of cleanup you're doing.

Everything above still goes through the same Recycle Bin safety net as disk-space cleanup: reversible for ~30 days, nothing permanent.

## Two modes, two audiences

**Simple mode** (default) — for everyone: one "Analyze my computer" button, plain-language explanations, split into two clearly labeled groups (💾 *Disk space* / 🕵️ *Privacy*), and only items **certified safe** by the rule base are offered. Explanation screens on first launch.

**Expert mode** (selector at the top right) — for technical users: the same 💾/🕵️ split plus a quick filter, full detail per folder (AppData levels 1-2, developer caches, system areas, unused applications), 🟢/🟡/🔴 categories, ready-to-copy PowerShell commands, archivable HTML/JSON reports, scan-over-scan evolution tracking, relaunch as admin.

## Features

- **Privacy traces** across Chrome/Edge/Firefox and Windows itself (cookies, history, Prefetch, Jump Lists, Timeline…), each explained — see above
- **AppData** analysis (Local, LocalLow, Roaming) classified by a base of ~60 rules + cautious heuristics
- **MSIX mirror** detection (same physical content counted twice) through NTFS inode comparison
- **Developer caches**: orphaned `node_modules`, Gradle/Maven/NuGet/pip/Expo caches, Android emulator images, WSL/Docker virtual disks (with the compaction procedure)
- **System areas**: Windows Update leftovers, recycle bin, crash dumps, `hiberfil.sys`, restore points (admin)
- **Unused applications**: registry inventory cross-checked with execution traces (UserAssist, Prefetch) — uninstall advice, never automatic action
- **Tracking over time**: every scan is recorded; the report shows what grew since the previous one
- **Cleanup journal** with an "Open Recycle Bin" button
- **Bilingual UI** (English/French) — auto-detected from the browser, switchable at the top right

## Installation

### Option 1 — Executable (recommended)

Download `ghosttrace-vX.Y.Z.exe` from the [latest release](../../releases/latest), then **double-click**: the interface opens in an app window (the local server starts in the background and stops on its own after you close the window).

Each release is **built from source by the public GitHub Actions pipeline** ([.github/workflows/release.yml](.github/workflows/release.yml)) — the build logs are auditable. Verify your download against the published `SHA256SUMS.txt`:

```powershell
Get-FileHash .\ghosttrace-v2.1.0.exe -Algorithm SHA256
```

> ⚠️ **SmartScreen**: the executable is not code-signed (signing costs ~€300/year). Windows will show "unrecognized app" on first launch → "More info" → "Run anyway". That's exactly why the code is open source and the builds are reproducible: audit it, or build the exe yourself (option 2).

### Option 2 — From source

Prerequisite: [Node.js](https://nodejs.org/) ≥ 22.18 (native TypeScript execution). No dependencies to install.

```powershell
git clone https://github.com/umbralabsaccademy-droid/drive-cleaner.git
cd drive-cleaner

npm run serve        # web dashboard → http://localhost:7113
npm run scan:open    # or: console scan + HTML report
npm run build:exe    # build your own exe (dist\ghosttrace.exe)
```

`build:exe` uses Node SEA (Single Executable Application): `esbuild` bundles the sources, `postject` injects the result into a copy of `node.exe` — both tools are invoked one-shot via `npx`, nothing is added to the project.

### Command-line options

```
ghosttrace [--serve] [--port 7113] [--open] [--auto-exit]
           [--path <AppData>] [--out <folder>] [--workspaces <folder>]
           [--skip dev,system,apps,privacy,history] [--concurrency 32]
```

Run as **administrator** to also measure the full recycle bin, Windows areas, restore points and Prefetch (a "Relaunch as admin" button also exists in the UI).

## The safety contract

This is the part that matters. The tool commits to four guarantees, verifiable in the code:

| Guarantee | Where it's enforced |
|---|---|
| The **analysis** never modifies anything (read-only) | [src/scanner.ts](src/scanner.ts) — `readdir`/`stat` only |
| **Cleanup** goes exclusively through the Recycle Bin | [src/cleaner.ts](src/cleaner.ts) — .NET `SendToRecycleBin` API |
| The server can only delete items **identified by the last scan** (never an arbitrary path sent by a client) | [src/server.ts](src/server.ts) — id validation |
| An **unknown** folder is never "no risk"; Simple mode requires an exact rule | [src/knowledge.ts](src/knowledge.ts) + [src/actionables.ts](src/actionables.ts) |

On top of that: server bound to `127.0.0.1`, action endpoints protected against CSRF (custom header → CORS preflight), strict validation of served file names (no path traversal).

## Architecture

```
src/
├── cli.ts          Entry point: double-click → hidden server + app window; console; --serve
├── pipeline.ts     Full-scan orchestration, progress events
├── scanner.ts      Async disk walk (concurrent pool, junctions skipped, access errors tolerated)
├── knowledge.ts    ⭐ 🟢/🟡/🔴 classification rule base (~60 rules + heuristics, FR/EN texts)
├── dedupe.ts       MSIX mirror detection through NTFS inodes
├── devcaches.ts    Developer caches module
├── system.ts       System areas module (admin elevation detection)
├── apps.ts         Installed applications module (registry + UserAssist + Prefetch)
├── privacy.ts      🕵️ Privacy/activity-traces module (cookies, history, Prefetch, Timeline… across Chrome/Edge/Firefox)
├── history.ts      Scan history (append-only JSONL) and evolution computation
├── actionables.ts  Cleanable items + simple-mode guardrails + plain-language labels (FR/EN)
├── cleaner.ts      Recycle Bin cleanup (sequential, verified results)
├── report.ts       Analysis + self-contained bilingual HTML report
├── server.ts       Web dashboard (native http, SSE, simple/expert dual UI, FR/EN)
└── types.ts        Shared types
```

## Contributing

The most useful contribution: **extending the rule base** ([src/knowledge.ts](src/knowledge.ts)). You know an AppData folder that isn't listed? Add an entry to `EXACT_RULES` keyed by lowercase `root\name`:

```ts
'roaming\\myapp': (p) => ({
  category: GREEN,                      // green | yellow | red
  app: 'MyApp', dataType: 'cache', dataTypeEn: 'cache',
  note: 'Conséquence exacte de la suppression.',   // French
  noteEn: 'Exact consequence of deleting it.',     // English
  autoRecreated: true,                  // recreated automatically?
  command: rmCmd(p),                    // only if it's a pure deletion
}),
```

Golden rules of the project: an unknown is never 🟢, user data (profiles, wallets, credentials) is always 🔴, and when in doubt choose 🟡 with the consequence spelled out. Please provide both French and English texts.

Found a tracking file we're missing (another browser, a new Windows feature)? [src/privacy.ts](src/privacy.ts) is the module to extend — each entry needs a plain-language `purpose`/`purposeEn` (what it's for) in addition to the usual `note`/`noteEn` (what happens if you delete it).

Issues and pull requests welcome. No external dependencies — that's a principle, not an oversight.

## FAQ

**Does this replace clearing cookies/history from my browser's own settings?** Not exactly — think of it as a second pass: it also catches what browsers don't give you a one-click button for (Prefetch, Windows Timeline, Jump Lists, thumbnail cache…), across all your browsers at once, and explains what each item actually does before you clear it.

**Why is the exe 83 MB?** It embeds the full Node.js runtime (Node SEA): zero prerequisites on your machine in exchange.

**My antivirus flags it.** Unsigned exe + built by injecting into node.exe = occasionally grumpy heuristics. The code is open — build the exe yourself if you prefer.

**Is any data sent anywhere?** No. No outbound network request — verifiable in the code (the only server is local).

**The cleaned files come back!** That's normal: caches and temp files regenerate with use. The tool tells you so honestly — come back every two or three months.

**Linux/macOS?** No — the tool is Windows-specific (AppData, Recycle Bin, registry, MSIX).

## License

[MIT](LICENSE) — do whatever you want with it: use, modify, redistribute, commercially included. Just keep the license notice.

---

Built by **[Umbra Labs](https://www.academy.umbra-labs.dev/)** · Follow [@xumbralabs](https://x.com/xumbralabs) for updates · ⭐ if this tool freed up some gigabytes!
