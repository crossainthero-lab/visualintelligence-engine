// Backfill / sync the SQLite database from the Python collector's Scroll Sessions.
// Read-only with respect to the sessions folder: nothing is moved, rewritten, re-downloaded or deleted.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { hashtags, parseJson, uid } from './util.ts';

const SESSION_RE = /^\d{4}-\d{2}-\d{2}_\d{4}(_\d{2})?$/;
// Higher wins when the same video shows up in several sessions with different outcomes.
const STATUS_RANK: Record<string, number> = { downloaded: 6, queued: 5, downloading: 5, failed: 4, unavailable: 3, skipped: 2, discovered: 1, duplicate: 0 };

export interface ImportReport {
	sessionsDir: string;
	sessionsFound: number;
	sessionsImported: number;
	sessionsUnchanged: number;
	sessionsIncomplete: number;
	videosNew: number;
	videosTotal: number;
	filesOnDisk: number;
	filesMissing: number;
	orphanFiles: string[];
	bytesOnDisk: number;
	warnings: string[];
}

function readJson(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

function pidAlive(pid: number | null | undefined): boolean {
	if (!pid) return false;
	try {
		// A reused pid after reboot is common: only trust it if it is one of our collectors.
		const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
		return cmd.includes('collect_cli');
	} catch {
		return false;
	}
}

const iso = (ts: number | string | null | undefined): string | null => {
	if (ts == null) return null;
	if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
	const d = new Date(ts);
	return isNaN(+d) ? null : d.toISOString();
};

function sourceKind(entries: any[]): string {
	const kinds = new Set(entries.map((e) => e.source?.kind).filter(Boolean));
	if (kinds.size === 0) return 'unknown';
	return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

export function importSessions(db: DB, sessionsDir: string, opts: { force?: boolean; onProgress?: (m: string) => void } = {}): ImportReport {
	const rep: ImportReport = {
		sessionsDir, sessionsFound: 0, sessionsImported: 0, sessionsUnchanged: 0, sessionsIncomplete: 0, videosNew: 0, videosTotal: 0,
		filesOnDisk: 0, filesMissing: 0, orphanFiles: [], bytesOnDisk: 0, warnings: []
	};
	if (!existsSync(sessionsDir)) {
		rep.warnings.push(`sessions directory not found: ${sessionsDir}`);
		return rep;
	}
	const dirs = readdirSync(sessionsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && SESSION_RE.test(d.name))
		.map((d) => d.name)
		.sort();
	rep.sessionsFound = dirs.length;

	db.run('INSERT INTO media_roots(path,label,kind) VALUES (?,?,?) ON CONFLICT(path) DO NOTHING', sessionsDir, 'Scroll Sessions', 'sessions');
	const rootId = db.value<number>('SELECT id FROM media_roots WHERE path=?', sessionsDir)!;

	for (const name of dirs) {
		const dir = join(sessionsDir, name);
		const sPath = join(dir, 'session.json');
		const mPath = join(dir, 'metadata.json');
		const stamp = [safeMtime(sPath), safeMtime(mPath)].join(':');
		const prev = db.get<{ src_stamp: string }>('SELECT src_stamp FROM sessions WHERE id=?', name);
		if (prev && prev.src_stamp === stamp && !opts.force) {
			rep.sessionsUnchanged++;
			continue;
		}
		const info = readJson(sPath) ?? {};
		const meta = readJson(mPath) ?? { videos: [] };
		if (!existsSync(sPath) || !existsSync(mPath)) rep.warnings.push(`${name}: session.json/metadata.json missing or unreadable`);
		db.tx(() => importOne(db, rootId, name, dir, info, meta, stamp, rep));
		rep.sessionsImported++;
		opts.onProgress?.(`imported ${name}`);
	}

	// Totals + orphan scan (media files in videos/ that no metadata entry references)
	const refd = new Set(db.all<{ rel_path: string }>('SELECT rel_path FROM videos WHERE root_id=? AND rel_path IS NOT NULL', rootId).map((r) => r.rel_path));
	for (const name of dirs) {
		const vd = join(sessionsDir, name, "videos");
		if (!existsSync(vd)) continue;
		for (const f of readdirSync(vd)) {
			if (f.startsWith('.')) continue;
			const rel = `${name}/videos/${f}`;
			let size = 0;
			try {
				size = statSync(join(vd, f)).size;
			} catch {
				continue;
			}
			rep.filesOnDisk++;
			rep.bytesOnDisk += size;
			if (!refd.has(rel)) rep.orphanFiles.push(rel);
		}
	}
	rep.filesMissing = db.value<number>('SELECT COUNT(*) FROM videos WHERE file_missing=1') ?? 0;
	rep.videosTotal = db.value<number>('SELECT COUNT(*) FROM videos') ?? 0;
	rep.sessionsIncomplete = db.value<number>('SELECT COUNT(*) FROM sessions WHERE incomplete=1') ?? 0;
	return rep;
}

function safeMtime(p: string): number {
	try {
		return Math.round(statSync(p).mtimeMs);
	} catch {
		return 0;
	}
}

export interface ImportCtx {
	origin: string; // 'local' or a collector id
	relFor?: (e: any) => string | null; // where this entry's media lives, relative to the root (default: <session>/<file>)
	remoteOnly?: boolean; // metadata-only sync: the file stays on the collector machine
	sessionKey?: (id: string) => string;
}

export function importOne(db: DB, rootId: number, id: string, dirPath: string, info: any, meta: any, stamp: string, rep: ImportReport, ctx: ImportCtx = { origin: 'local' }) {
	const entries: any[] = Array.isArray(meta.videos) ? meta.videos : [];
	const t = now();
	const stale = info.status === 'running' && !pidAlive(info.pid);
	const status = stale ? 'interrupted' : (info.status ?? 'unknown');
	const lastAct = entries
		.flatMap((e) => [e.downloaded_at, e.discovered_at])
		.filter(Boolean)
		.sort()
		.pop();
	const started = iso(info.started_at);
	let ended = iso(info.ended_at);
	const reasons: string[] = [];
	if (!info.started_at) reasons.push('no session.json start time');
	if (stale) reasons.push('collector process ended without recording an end time (crash, kill or system freeze); counts are from the last metadata flush');
	if (!stale && info.status === 'running') reasons.push('session still marked running');
	if (status === 'interrupted' && !info.ended_at && !stale) reasons.push('no end time recorded');
	const incomplete = reasons.length > 0 || entries.length === 0 && info.status === 'running';
	if (!ended && stale && lastAct) ended = iso(lastAct); // best available evidence, flagged incomplete
	const duration = started && ended ? Math.max(0, (+new Date(ended) - +new Date(started)) / 1000) : null;

	const counts: Record<string, number> = {};
	for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
	const kind = sourceKind(entries);
	const detail = {
		saved_collections: info.saved_collections ?? undefined,
		creators_browsed: info.creators_browsed ?? undefined,
		start_url: info.config?.instagram?.start_url
	};
	const errors = entries.filter((e) => e.error).map((e) => ({ video: e.id, status: e.status, error: String(e.error).slice(0, 400) })).slice(0, 200);
	const bytes = entries.filter((e) => e.status === 'downloaded').reduce((a, e) => a + (e.bytes ?? 0), 0);

	db.run(
		`INSERT INTO sessions(id,origin,host,mode,source_kind,source_detail,account,status,started_at,ended_at,last_activity_at,duration_s,stop_reason,
			incomplete,incomplete_reason,recovered,encountered,downloaded,duplicates,failed,skipped,unavailable,queued,bytes_downloaded,errors_json,resources_json,src_dir,imported_at,src_stamp)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET host=excluded.host,mode=excluded.mode,source_kind=excluded.source_kind,source_detail=excluded.source_detail,
			account=excluded.account,status=excluded.status,started_at=excluded.started_at,ended_at=excluded.ended_at,last_activity_at=excluded.last_activity_at,
			duration_s=excluded.duration_s,stop_reason=excluded.stop_reason,incomplete=excluded.incomplete,incomplete_reason=excluded.incomplete_reason,
			recovered=excluded.recovered,encountered=excluded.encountered,downloaded=excluded.downloaded,duplicates=excluded.duplicates,failed=excluded.failed,
			skipped=excluded.skipped,unavailable=excluded.unavailable,queued=excluded.queued,bytes_downloaded=excluded.bytes_downloaded,errors_json=excluded.errors_json,
			resources_json=excluded.resources_json,src_dir=excluded.src_dir,imported_at=excluded.imported_at,src_stamp=excluded.src_stamp`,
		id, ctx.origin, info.host ?? null, info.mode ?? (entries.some((e) => e.agent_decision) ? 'normal' : 'unknown'), kind, JSON.stringify(detail),
		info.instagram_account ?? info.config?.instagram?.account ?? null, status, started, ended, iso(lastAct), duration, info.stop_reason ?? null,
		incomplete ? 1 : 0, reasons.join('; ') || null, stale || info.recovered ? 1 : 0, entries.length,
		counts.downloaded ?? 0, counts.duplicate ?? 0, counts.failed ?? 0, counts.skipped ?? 0, counts.unavailable ?? 0, (counts.queued ?? 0) + (counts.downloading ?? 0),
		bytes, JSON.stringify(errors), info.resources ? JSON.stringify(info.resources) : null, dirPath, t, stamp
	);

	let pos = 0;
	for (const e of entries) {
		pos++;
		if (!e.id) continue;
		const vid = upsertVideo(db, rootId, id, e, rep, ctx);
		db.run(
			`INSERT INTO session_videos(session_id,video_id,position,status,new_download,source_json,bytes,attempts,error,agent_decision_json,discovered_at,downloaded_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(session_id,video_id) DO UPDATE SET position=excluded.position,status=excluded.status,new_download=excluded.new_download,source_json=excluded.source_json,
			   bytes=excluded.bytes,attempts=excluded.attempts,error=excluded.error,agent_decision_json=excluded.agent_decision_json,discovered_at=excluded.discovered_at,downloaded_at=excluded.downloaded_at`,
			id, vid, pos, e.status, e.status === 'downloaded' ? 1 : 0, JSON.stringify(e.source ?? null), e.bytes ?? null, e.attempts ?? null,
			e.error ? String(e.error).slice(0, 400) : null, e.agent_decision ? JSON.stringify(e.agent_decision) : null, e.discovered_at ?? null, e.downloaded_at ?? null
		);
	}
}

function upsertVideo(db: DB, rootId: number, sessionId: string, e: any, rep: ImportReport, ctx: ImportCtx): number {
	const t = now();
	const username: string | null = e.creator ?? e.source_info?.channel ?? e.source_info?.uploader_id ?? null;
	let creatorId: number | null = null;
	if (username) {
		db.run(
			`INSERT INTO creators(username,display_name,platform_id,profile_url,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)
			 ON CONFLICT(username) DO UPDATE SET display_name=COALESCE(excluded.display_name,display_name), platform_id=COALESCE(excluded.platform_id,platform_id),
			   last_seen_at=MAX(COALESCE(last_seen_at,''),COALESCE(excluded.last_seen_at,''))`,
			username, e.creator_name ?? null, e.creator_id ?? null, `https://www.instagram.com/${username}/`, e.discovered_at ?? t, e.downloaded_at ?? e.discovered_at ?? t
		);
		creatorId = db.value<number>('SELECT id FROM creators WHERE username=?', username)!;
	}
	const isDl = e.status === 'downloaded' && e.file;
	const rel = isDl ? (ctx.relFor ? ctx.relFor(e) : `${sessionId}/${String(e.file)}`) : null;
	let size: number | null = e.bytes ?? null;
	let missing = 0;
	if (isDl && ctx.remoteOnly) {
		// metadata-only sync: the original stays on the collector machine
	} else if (isDl) {
		try {
			size = statSync(join(db.get<{ path: string }>('SELECT path FROM media_roots WHERE id=?', rootId)!.path, rel!)).size;
			if (size === 0) {
				// a 0-byte "download" is a file the OS never flushed before a crash/freeze: not a playable video
				missing = 1;
				rep.warnings.push(`zero-byte file (truncated by a crash): ${rel}`);
			}
		} catch {
			missing = 1;
			rep.warnings.push(`file missing on disk: ${rel}`);
		}
	}
	const p = e.probe ?? {};
	const seen = e.downloaded_at ?? e.discovered_at ?? t;
	const canonical = e.url ? e.url.replace(/\/?$/, '/') : null;
	const existing = db.get<{ id: number; download_status: string; rel_path: string | null; first_collected_at: string | null }>(
		'SELECT id,download_status,rel_path,first_collected_at FROM videos WHERE platform=? AND platform_id=?',
		'instagram', e.id
	);
	if (!existing) {
		db.run(
			`INSERT INTO videos(uid,platform,platform_id,url,canonical_url,creator_id,caption,hashtags,posted_at,first_collected_at,last_seen_at,source_kind,first_session_id,
				root_id,rel_path,file_size,duration_s,width,height,fps,video_codec,audio_codec,has_audio,sha256,download_status,file_missing,source_info_json,provenance_json,created_at,updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			uid('v'), 'instagram', e.id, e.url ?? null, canonical, creatorId, e.caption ?? null, JSON.stringify(hashtags(e.caption)), iso(e.posted_at),
			seen, seen, e.source?.kind ?? null, sessionId, isDl && !ctx.remoteOnly ? rootId : null, ctx.remoteOnly ? null : rel, size ?? e.bytes ?? null,
			p.duration_s ?? e.duration_hint_s ?? null, p.width ?? null, p.height ?? null, p.fps ?? null, p.video_codec ?? null, p.audio_codec ?? null,
			p.has_audio == null ? null : p.has_audio ? 1 : 0, e.sha256 ?? null, missing ? 'missing' : ctx.remoteOnly && isDl ? 'remote' : mapStatus(e.status), missing,
			e.source_info ? JSON.stringify(e.source_info) : null, JSON.stringify([provenance(sessionId, e)]), t, t
		);
		rep.videosNew++;
		const vid = db.value<number>('SELECT id FROM videos WHERE platform=? AND platform_id=?', 'instagram', e.id)!;
		linkContentDup(db, vid, e.sha256);
		return vid;
	}
	// Existing: merge. A real download beats everything; otherwise keep the strongest status. Never lose provenance.
	const better = (STATUS_RANK[e.status] ?? 0) > (STATUS_RANK[existing.download_status] ?? 0) || ((existing.download_status === 'missing' || existing.download_status === 'remote') && isDl && !missing && !ctx.remoteOnly);
	const prov = parseJson<any[]>(db.value<string>('SELECT provenance_json FROM videos WHERE id=?', existing.id), []);
	if (!prov.some((x) => x.session === sessionId)) prov.push(provenance(sessionId, e));
	db.run(
		`UPDATE videos SET last_seen_at=MAX(COALESCE(last_seen_at,''),?), provenance_json=?, updated_at=?,
			first_collected_at=MIN(COALESCE(first_collected_at,?),?),
			creator_id=COALESCE(creator_id,?), caption=COALESCE(caption,?), hashtags=CASE WHEN caption IS NULL THEN ? ELSE hashtags END,
			posted_at=COALESCE(posted_at,?), url=COALESCE(url,?), canonical_url=COALESCE(canonical_url,?) WHERE id=?`,
		seen, JSON.stringify(prov), t, seen, seen, creatorId, e.caption ?? null, JSON.stringify(hashtags(e.caption)), iso(e.posted_at), e.url ?? null, canonical, existing.id
	);
	if (isDl && !better && existing.download_status === 'downloaded' && existing.rel_path === rel) {
		// same file seen again (re-import): keep size / missing-ness current without touching anything else
		db.run(`UPDATE videos SET file_size=?, file_missing=?, download_status=? WHERE id=?`, size, missing, missing ? 'missing' : 'downloaded', existing.id);
	}
	if (better && isDl) {
		db.run(
			`UPDATE videos SET download_status=?,file_missing=?,root_id=?,rel_path=?,file_size=?,duration_s=?,width=?,height=?,fps=?,video_codec=?,audio_codec=?,has_audio=?,sha256=?,
				first_session_id=COALESCE(first_session_id,?), source_kind=COALESCE(source_kind,?), source_info_json=COALESCE(source_info_json,?) WHERE id=?`,
			missing ? 'missing' : 'downloaded', missing, rootId, rel, size, p.duration_s ?? null, p.width ?? null, p.height ?? null, p.fps ?? null, p.video_codec ?? null,
			p.audio_codec ?? null, p.has_audio == null ? null : p.has_audio ? 1 : 0, e.sha256 ?? null, sessionId, e.source?.kind ?? null, e.source_info ? JSON.stringify(e.source_info) : null, existing.id
		);
		linkContentDup(db, existing.id, e.sha256);
	} else if (better) {
		db.run('UPDATE videos SET download_status=? WHERE id=?', mapStatus(e.status), existing.id);
	}
	return existing.id;
}

function mapStatus(s: string): string {
	return s === 'downloading' ? 'queued' : s === 'duplicate' ? 'discovered' : s;
}

function provenance(session: string, e: any) {
	return { session, status: e.status, source: e.source ?? null, at: e.downloaded_at ?? e.discovered_at ?? null };
}

/** Same bytes under a different platform id: keep both records, link them, never merge destructively. */
function linkContentDup(db: DB, videoId: number, sha?: string | null) {
	if (!sha) return;
	const other = db.get<{ id: number }>('SELECT id FROM videos WHERE sha256=? AND id<>? ORDER BY id LIMIT 1', sha, videoId);
	if (other && other.id < videoId) db.run('UPDATE videos SET content_dup_of=? WHERE id=?', other.id, videoId);
}
