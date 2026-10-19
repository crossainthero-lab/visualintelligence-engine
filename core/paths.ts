// Where things live. Everything is overridable by environment so the same code runs as a dev checkout,
// a systemd service on a headless server, or a test with a temp dir.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository / install root (the directory holding package.json). */
export function repoRoot(): string {
	if (process.env.VIE_ROOT) return resolve(process.env.VIE_ROOT);
	let d = here;
	for (let i = 0; i < 6; i++) {
		if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'core'))) return d;
		d = dirname(d);
	}
	return process.cwd();
}

export function dataDir(): string {
	const d = process.env.VIE_DATA_DIR ? resolve(process.env.VIE_DATA_DIR) : join(repoRoot(), 'data');
	mkdirSync(d, { recursive: true, mode: 0o700 });
	return d;
}

export const dbPath = () => process.env.VIE_DB_PATH ?? join(dataDir(), 'vie.sqlite');

export function subdir(name: string): string {
	const d = join(dataDir(), name);
	mkdirSync(d, { recursive: true });
	return d;
}
export const thumbsDir = () => subdir('thumbs');
export const cacheDir = () => subdir('cache');
export const framesDir = () => subdir(join('cache', 'frames'));
export const tmpDir = () => subdir('tmp');
export const backupsDir = () => subdir('backups');
export const logsDir = () => subdir('logs');
export const mediaDir = () => (process.env.VIE_MEDIA_DIR ? resolve(process.env.VIE_MEDIA_DIR) : subdir('media'));

/** Default location of the Python collector's Scroll Sessions (read in place, never moved). */
export function defaultSessionsDir(): string {
	if (process.env.VIE_SESSIONS_DIR) return resolve(process.env.VIE_SESSIONS_DIR);
	return join(repoRoot(), 'scroll-sessions');
}

export const stateDirCollector = () =>
	process.env.VIE_STATE_DIR ? resolve(process.env.VIE_STATE_DIR) : join(homedir(), '.local', 'share', 'visualintelligence-engine');
