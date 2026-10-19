import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { getDb, now } from './db.ts';
import { cacheDir, dataDir, dbPath, thumbsDir, tmpDir } from './paths.ts';
import { diskFree } from './stats.ts';
import { pruneCache } from './media.ts';

function dirSize(d: string): { bytes: number; files: number } {
	let bytes = 0;
	let files = 0;
	const walk = (p: string) => {
		let ents;
		try {
			ents = readdirSync(p, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of ents) {
			const f = join(p, e.name);
			if (e.isDirectory()) walk(f);
			else
				try {
					bytes += statSync(f).size;
					files++;
				} catch {
					/* vanished */
				}
		}
	};
	walk(d);
	return { bytes, files };
}

export function storageReport(db: DB = getDb()) {
	const originals = db.get<{ b: number; n: number }>(`SELECT COALESCE(SUM(file_size),0) b, COUNT(*) n FROM videos WHERE download_status='downloaded' AND file_missing=0`)!;
	const roots = db.all<{ id: number; path: string; kind: string }>('SELECT id,path,kind FROM media_roots');
	let artefacts = { bytes: 0, files: 0 };
	let partial = { bytes: 0, files: 0 };
	for (const r of roots) {
		if (!existsSync(r.path)) continue;
		for (const s of readdirSync(r.path, { withFileTypes: true })) {
			if (!s.isDirectory()) continue;
			const a = dirSize(join(r.path, s.name, 'analysis'));
			artefacts = { bytes: artefacts.bytes + a.bytes, files: artefacts.files + a.files };
			const pdir = dirSize(join(r.path, s.name, 'videos', '.partial'));
			partial = { bytes: partial.bytes + pdir.bytes, files: partial.files + pdir.files };
		}
	}
	const thumbs = dirSize(thumbsDir());
	const cache = dirSize(cacheDir());
	const tmp = dirSize(tmpDir());
	const dbBytes = [dbPath(), dbPath() + '-wal', dbPath() + '-shm'].reduce((a, p) => a + (existsSync(p) ? statSync(p).size : 0), 0);
	const free = diskFree(dataDir());
	const freeMedia = roots[0] ? diskFree(roots[0].path) : free;
	return {
		categories: [
			{ key: 'originals', label: 'Original videos', bytes: originals.b, files: originals.n },
			{ key: 'thumbnails', label: 'Thumbnails', ...thumbs },
			{ key: 'database', label: 'Database', bytes: dbBytes, files: 1 },
			{ key: 'artefacts', label: 'Analysis artefacts (session analysis/ folders)', ...artefacts },
			{ key: 'temp', label: 'Temporary files', bytes: tmp.bytes + partial.bytes, files: tmp.files + partial.files },
			{ key: 'cache', label: 'Caches (frames, sheets, shots, proxies)', ...cache }
		],
		filesystem: { dataDir: free, mediaRoot: freeMedia },
		roots
	};
}

export function findOrphans(db: DB = getDb()) {
	const missing = db.all<any>(`SELECT uid, rel_path, file_size FROM videos WHERE file_missing=1 OR download_status='missing'`);
	const orphanFiles: Array<{ path: string; bytes: number }> = [];
	for (const r of db.all<{ id: number; path: string }>(`SELECT id,path FROM media_roots`)) {
		if (!existsSync(r.path)) continue;
		const known = new Set(db.all<{ rel_path: string }>('SELECT rel_path FROM videos WHERE root_id=? AND rel_path IS NOT NULL', r.id).map((x) => x.rel_path));
		for (const s of readdirSync(r.path, { withFileTypes: true })) {
			if (!s.isDirectory()) continue;
			const vd = join(r.path, s.name, 'videos');
			if (!existsSync(vd)) continue;
			for (const f of readdirSync(vd)) {
				if (f.startsWith('.')) continue;
				const rel = `${s.name}/videos/${f}`;
				if (!known.has(rel)) orphanFiles.push({ path: join(vd, f), bytes: statSync(join(vd, f)).size });
			}
		}
	}
	return { missingFiles: missing, orphanFiles };
}

export function findDuplicates(db: DB = getDb()) {
	const groups = db.all<{ sha256: string; n: number }>(`SELECT sha256, COUNT(*) n FROM videos WHERE sha256 IS NOT NULL AND download_status='downloaded' GROUP BY sha256 HAVING n>1 ORDER BY n DESC LIMIT 200`);
	return groups.map((g) => ({ ...g, videos: db.all(`SELECT v.uid, v.platform_id, c.username creator, v.file_size, v.rel_path FROM videos v LEFT JOIN creators c ON c.id=v.creator_id WHERE v.sha256=?`, g.sha256) }));
}

// ---- destructive operations: plan first (exact list), then confirm -------------------------------------------------

type Kind = 'cache' | 'thumbnails' | 'temp' | 'orphan-files';
interface Plan {
	id: string;
	kind: Kind;
	files: string[];
	bytes: number;
	created: number;
}
const plans = new Map<string, Plan>();

function listFiles(d: string): string[] {
	const out: string[] = [];
	const walk = (p: string) => {
		if (!existsSync(p)) return;
		for (const e of readdirSync(p, { withFileTypes: true })) {
			const f = join(p, e.name);
			e.isDirectory() ? walk(f) : out.push(f);
		}
	};
	walk(d);
	return out;
}

export function planCleanup(kind: Kind, db: DB = getDb()) {
	let files: string[] = [];
	if (kind === 'cache') files = listFiles(cacheDir());
	else if (kind === 'thumbnails') files = listFiles(thumbsDir());
	else if (kind === 'temp') files = listFiles(tmpDir());
	else if (kind === 'orphan-files') files = findOrphans(db).orphanFiles.map((o) => o.path);
	const bytes = files.reduce((a, f) => {
		try {
			return a + statSync(f).size;
		} catch {
			return a;
		}
	}, 0);
	const plan: Plan = { id: randomUUID(), kind, files, bytes, created: Date.now() };
	plans.set(plan.id, plan);
	for (const [k, p] of plans) if (Date.now() - p.created > 600_000) plans.delete(k);
	return { id: plan.id, kind, fileCount: files.length, bytes, sample: files.slice(0, 40), note: kind === 'orphan-files' ? 'These files are inside your Scroll Sessions folders but no collector record references them.' : 'Safe: regenerated on demand.' };
}

export function executeCleanup(planId: string, confirm: string, db: DB = getDb()) {
	const plan = plans.get(planId);
	if (!plan) throw new Error('unknown or expired cleanup plan; create a new one');
	if (confirm !== `delete ${plan.files.length}`) throw new Error(`confirmation text must be exactly "delete ${plan.files.length}"`);
	const allowed = [cacheDir(), thumbsDir(), tmpDir(), ...db.all<{ path: string }>('SELECT path FROM media_roots').map((r) => r.path)].map((p) => resolve(p) + sep);
	let removed = 0;
	let bytes = 0;
	for (const f of plan.files) {
		const abs = resolve(f);
		if (!allowed.some((a) => abs.startsWith(a))) continue; // never delete outside the managed folders
		try {
			const sz = statSync(abs).size;
			rmSync(abs, { force: true });
			removed++;
			bytes += sz;
		} catch {
			/* already gone */
		}
	}
	if (plan.kind === 'thumbnails') db.run('UPDATE videos SET thumb_path=NULL');
	db.run('INSERT INTO audit_log(at,actor,action,detail_json) VALUES (?,?,?,?)', now(), 'ui', `cleanup:${plan.kind}`, JSON.stringify({ removed, bytes }));
	plans.delete(planId);
	return { removed, bytes };
}

export { pruneCache };
