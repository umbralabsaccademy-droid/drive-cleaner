/**
 * Pipeline de scan complet, réutilisable par le CLI et le serveur web.
 *
 * Choix technique : le pipeline émet des événements de progression typés via
 * un callback `emit` — le CLI les imprime en console, le serveur les diffuse
 * en SSE au tableau de bord. Un module en échec émet un événement et le scan
 * continue : jamais de crash global.
 */
import { scanAppData } from './scanner.ts';
import { findMsixMirrors } from './dedupe.ts';
import { analyze, writeReport } from './report.ts';
import { scanDevCaches } from './devcaches.ts';
import { scanSystem, isElevated } from './system.ts';
import { scanInstalledApps } from './apps.ts';
import { scanPrivacy } from './privacy.ts';
import { buildActionables, type Actionable } from './actionables.ts';
import { loadPreviousSnapshot, appendSnapshot, computeEvolution, type Evolution } from './history.ts';
import type { Section } from './types.ts';
import os from 'node:os';

export interface PipelineOptions {
  appDataPath: string;
  outDir: string;
  workspacesPath: string;
  skip: Set<string>;
  concurrency: number;
}

export interface ProgressEvent {
  /** phase = nouvelle étape ; item = ligne de détail ; warn = avertissement */
  type: 'phase' | 'item' | 'warn';
  text: string;
}

export interface ScanSummary {
  htmlPath: string;
  jsonPath: string;
  htmlFile: string; // nom de fichier seul, pour construire un lien web
  adjustedTotalBytes: number;
  greenGainBytes: number;
  yellowGainBytes: number;
  seconds: number;
  /** Le scan a-t-il tourné avec des droits admin ? */
  admin: boolean;
  /** Éléments nettoyables (base du nettoyage assisté). */
  actionables: Actionable[];
  /** Applications candidates à la désinstallation (conseil, jamais d'action). */
  unusedApps: Array<{ name: string; sizeBytes: number; lastUsed: string | null }>;
  /** Avertissements du module traces (ex. navigateur ouvert), affichés avant le nettoyage. */
  privacyNotes: string[];
  privacyNotesEn: string[];
}

export const fmt = (b: number): string =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} Go` : `${(b / 1024 ** 2).toFixed(1)} Mo`;

/**
 * Exécute le scan complet (AppData + modules actifs), écrit le rapport et
 * retourne la synthèse. `emit` reçoit chaque événement de progression —
 * console pour le CLI, SSE pour le tableau de bord web.
 */
export async function runFullScan(opts: PipelineOptions, emit: (ev: ProgressEvent) => void): Promise<ScanSummary> {
  const started = Date.now();

  emit({ type: 'phase', text: `Scanning AppData: ${opts.appDataPath} (read-only)` });
  const entries = await scanAppData(opts.appDataPath, {
    concurrency: opts.concurrency,
    onProgress: (e) => emit({ type: 'item', text: `${e.root}\\${e.name} : ${fmt(e.sizeBytes)}` }),
  });

  emit({ type: 'phase', text: 'Detecting MSIX mirrors…' });
  const mirrors = await findMsixMirrors(opts.appDataPath, entries);
  for (const m of mirrors) {
    emit({ type: 'warn', text: `Mirror: Roaming\\${m.roamingName} ⇄ Packages\\${m.packageName} (${fmt(m.duplicatedBytes)} double-counted)` });
  }
  const adjustedTotal = entries.reduce((s, e) => s + e.sizeBytes, 0) - mirrors.reduce((s, m) => s + m.duplicatedBytes, 0);

  const sections: Section[] = [];
  const runModule = async (name: string, label: string, fn: () => Promise<Section>): Promise<void> => {
    if (opts.skip.has(name)) return;
    emit({ type: 'phase', text: `${label}…` });
    try {
      const section = await fn();
      sections.push(section);
      const total = section.findings.reduce((s, f) => s + f.sizeBytes, 0);
      emit({ type: 'item', text: `${section.findings.length} item(s), ${fmt(total)}` });
    } catch (err) {
      emit({ type: 'warn', text: `Module "${name}" failed (skipped): ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  await runModule('dev', 'Developer caches (workspaces, home, AVD, vhdx)', () => scanDevCaches(os.homedir(), opts.workspacesPath));
  await runModule('system', 'System areas (Temp, Windows Update, recycle bin…)', () => scanSystem());
  await runModule('apps', 'Installed applications (registry + UserAssist + Prefetch)', () => scanInstalledApps());
  await runModule('privacy', 'Privacy & activity traces (Prefetch, Recent, browsers…)', () => scanPrivacy());

  let evolution: Evolution | null = null;
  if (!opts.skip.has('history')) {
    const previous = await loadPreviousSnapshot(opts.outDir);
    evolution = computeEvolution(entries, adjustedTotal, previous);
    if (evolution) {
      const d = evolution.totalDeltaBytes;
      emit({ type: 'item', text: `Change since ${evolution.previousDate.slice(0, 16).replace('T', ' ')}: ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}` });
    }
    await appendSnapshot(opts.outDir, entries, adjustedTotal);
  }

  emit({ type: 'phase', text: 'Generating report…' });
  const analysis = analyze(entries, mirrors, opts.appDataPath, sections, evolution);
  const { html, json } = await writeReport(analysis, opts.outDir);

  // Conseil « programmes inutilisés » pour le mode simple (jamais d'action automatique)
  const appsSection = sections.find((s) => s.id === 'apps');
  const unusedApps = (appsSection?.findings ?? [])
    .filter((f) => f.category === 'yellow' && f.lastActivity)
    .slice(0, 5)
    .map((f) => ({ name: f.label.split(' — ')[0], sizeBytes: f.sizeBytes, lastUsed: f.lastActivity ?? null }));

  const privacySection = sections.find((s) => s.id === 'privacy');

  const seconds = Math.round((Date.now() - started) / 1000);
  return {
    htmlPath: html,
    jsonPath: json,
    htmlFile: html.split(/[\\/]/).pop() ?? '',
    adjustedTotalBytes: analysis.adjustedTotalBytes,
    greenGainBytes: analysis.greenGainBytes,
    yellowGainBytes: analysis.yellowGainBytes,
    seconds,
    admin: await isElevated(),
    actionables: buildActionables(analysis),
    unusedApps,
    privacyNotes: privacySection?.notes ?? [],
    privacyNotesEn: privacySection?.notesEn ?? [],
  };
}
