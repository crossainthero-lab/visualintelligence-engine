// One-time server initialisation shared by SvelteKit (dev + build) — DB, first-run import, background runner.
import { getDb } from '#core/db.ts';
import { importSessions } from '#core/importer.ts';
import { defaultSessionsDir } from '#core/paths.ts';
import { getSettings } from '#core/settings.ts';
import { runner } from '#core/analysis/runner.ts';
import { applyMediaLimits, generateMissingThumbnails } from '#core/media.ts';
import { absPath } from '#core/videos.ts';
import { detectProviders } from '#core/analysis/providers/index.ts';

let ready: ReturnType<typeof init> | null = null;
export function ensureReady() {
	return (ready ??= init());
}

export let lastImport: { at: string; report: ReturnType<typeof importSessions> } | null = null;

export function syncSessions(force = false) {
	const db = getDb();
	const dir = getSettings(db).collector.sessionsDir || defaultSessionsDir();
	const report = importSessions(db, dir, { force });
	lastImport = { at: new Date().toISOString(), report };
	return report;
}

async function init() {
	const db = getDb();
	applyMediaLimits(db);
	// First run (empty DB) or new session folders: backfill from the collector's Scroll Sessions. Incremental + idempotent.
	try {
		syncSessions();
	} catch (e) {
		console.error('[vie] session import failed:', e);
	}
	runner.watch(db);
	void detectProviders().catch(() => {}); // detection only (version / model list); never calls a model
	if (getSettings(db).media.autoThumbnails) {
		// Low-priority, one at a time, only for videos without a thumbnail. Idle when everything has one.
		void generateMissingThumbnails(db, (v) => absPath(db, v));
	}
	return true;
}
