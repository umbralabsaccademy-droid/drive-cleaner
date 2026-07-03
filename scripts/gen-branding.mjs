// Génère src/branding.ts à partir des assets téléchargés
import { readFileSync, writeFileSync } from 'node:fs';

const ico = readFileSync('assets/logo.ico').toString('base64');
const png = readFileSync('assets/logo_umbra_labs.png').toString('base64');

const out = `/**
 * Umbra Labs branding, embedded as base64 so the single-file SEA executable
 * ships the assets without any file next to it.
 * Regenerate from assets/ with scripts/gen-branding.mjs if the logos change.
 */
export const SITE_URL = 'https://www.academy.umbra-labs.dev/';
export const TWITTER_URL = 'https://x.com/xumbralabs';
export const TWITTER_HANDLE = '@xumbralabs';

/** assets/logo.ico (favicon; also the exe icon source at build time) */
export const FAVICON_ICO_B64 = '${ico}';

/** assets/logo_umbra_labs.png (header logo) */
export const LOGO_PNG_B64 = '${png}';
`;
writeFileSync('src/branding.ts', out);
console.log('src/branding.ts genere :', Math.round(out.length / 1024), 'Ko');
