/**
 * Best-effort diagnostic trail for the admin-relaunch handover.
 *
 * Both the old and the new (elevated) instance run headless — no console is
 * ever visible to the user (`windowsHide`/`-WindowStyle Hidden`) — so this
 * file is the only way to see what actually happened when the relaunch
 * fails silently. %TEMP% is per-user and shared between a process and its
 * elevated (same-user, higher-integrity) counterpart.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_PATH = path.join(os.tmpdir(), 'appdata-analyzer-debug.log');

export function logDebug(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
}
