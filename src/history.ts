/**
 * Module 5 — Suivi dans le temps.
 *
 * Choix technique : un fichier `history.jsonl` (une ligne JSON par scan)
 * plutôt que la comparaison des rapports complets — compact, append-only,
 * et robuste : deux scans le même jour se comparent aussi. On ne garde par
 * scan que l'empreinte utile (root\name → taille).
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TopEntry } from './scanner.ts';

export interface HistorySnapshot {
  date: string; // ISO complet
  adjustedTotalBytes: number;
  sizes: Record<string, number>; // "Root\Name" → octets
}

export interface EvolutionChange {
  key: string;
  deltaBytes: number;
  kind: 'grown' | 'shrunk' | 'new' | 'removed';
}

export interface Evolution {
  previousDate: string;
  totalDeltaBytes: number;
  changes: EvolutionChange[];
}

const HISTORY_FILE = 'history.jsonl';
const MIN_DELTA = 50 * 1024 * 1024; // 50 Mo : en dessous, churn normal

function snapshotOf(entries: TopEntry[], adjustedTotalBytes: number): HistorySnapshot {
  const sizes: Record<string, number> = {};
  for (const e of entries) sizes[`${e.root}\\${e.name}`] = e.sizeBytes;
  return { date: new Date().toISOString(), adjustedTotalBytes, sizes };
}

/** Dernier snapshot enregistré, ou null au premier scan. */
export async function loadPreviousSnapshot(outDir: string): Promise<HistorySnapshot | null> {
  try {
    const raw = await readFile(path.join(outDir, HISTORY_FILE), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as HistorySnapshot;
  } catch {
    return null;
  }
}

/** Ajoute le scan courant à l'historique (append-only). */
export async function appendSnapshot(outDir: string, entries: TopEntry[], adjustedTotalBytes: number): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const line = JSON.stringify(snapshotOf(entries, adjustedTotalBytes)) + '\n';
  await appendFile(path.join(outDir, HISTORY_FILE), line, 'utf8');
}

/** Delta entre le scan courant et le snapshot précédent. */
export function computeEvolution(
  entries: TopEntry[],
  adjustedTotalBytes: number,
  previous: HistorySnapshot | null,
): Evolution | null {
  if (!previous) return null;

  const current = snapshotOf(entries, adjustedTotalBytes).sizes;
  const changes: EvolutionChange[] = [];

  for (const [key, size] of Object.entries(current)) {
    const before = previous.sizes[key];
    if (before === undefined) {
      if (size >= MIN_DELTA) changes.push({ key, deltaBytes: size, kind: 'new' });
    } else {
      const delta = size - before;
      if (Math.abs(delta) >= MIN_DELTA) changes.push({ key, deltaBytes: delta, kind: delta > 0 ? 'grown' : 'shrunk' });
    }
  }
  for (const [key, before] of Object.entries(previous.sizes)) {
    if (!(key in current) && before >= MIN_DELTA) changes.push({ key, deltaBytes: -before, kind: 'removed' });
  }

  changes.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  return {
    previousDate: previous.date,
    totalDeltaBytes: adjustedTotalBytes - previous.adjustedTotalBytes,
    changes: changes.slice(0, 25),
  };
}
