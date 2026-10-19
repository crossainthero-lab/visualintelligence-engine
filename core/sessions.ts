import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { parseJson } from './util.ts';
import { thumbFile } from './media.ts';

export function listSessions(opts: { limit?: number; offset?: number; status?: string; from?: string; to?: string } = {}, db: DB = getDb()) {
	const w: string[] = [];
	const p: any[] = [];
	if (opts.status) (w.push('status=?'), p.push(opts.status));
	if (opts.from) (w.push('started_at>=?'), p.push(opts.from));
	if (opts.to) (w.push('started_at<?'), p.push(opts.to));
	const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
	const total = db.value<number>(`SELECT COUNT(*) FROM sessions ${where}`, ...p) ?? 0;
	const rows = db.all(
		`SELECT s.*, (SELECT COUNT(*) FROM session_videos sv JOIN videos v ON v.id=sv.video_id WHERE sv.session_id=s.id AND sv.new_download=1 AND v.analysis_status='analysed') AS analysed
		 FROM sessions s ${where} ORDER BY COALESCE(started_at, id) DESC LIMIT ? OFFSET ?`,
		...p, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0
	).map(shapeSession);
	return { total, sessions: rows };
}

function shapeSession(r: any) {
	return { ...r, incomplete: !!r.incomplete, recovered: !!r.recovered, source_detail: parseJson(r.source_detail, null), errors: undefined, errors_json: undefined, resources: parseJson(r.resources_json, null), resources_json: undefined, src_dir: undefined };
}

export function getSession(id: string, db: DB = getDb()) {
	const r = db.get<any>('SELECT * FROM sessions WHERE id=?', id);
	if (!r) return null;
	const s = shapeSession(r);
	const errors = parseJson<any[]>(r.errors_json, []);
	const newBytes = db.value<number>(`SELECT COALESCE(SUM(v.file_size),0) FROM session_videos sv JOIN videos v ON v.id=sv.video_id WHERE sv.session_id=? AND sv.new_download=1`, id) ?? 0;
	return { ...s, errors, disk_bytes_new: newBytes };
}

export function sessionVideos(id: string, opts: { status?: string; limit?: number; offset?: number } = {}, db: DB = getDb()) {
	const w = ['sv.session_id=?'];
	const p: any[] = [id];
	if (opts.status) (w.push('sv.status=?'), p.push(opts.status));
	const total = db.value<number>(`SELECT COUNT(*) FROM session_videos sv WHERE ${w.join(' AND ')}`, ...p) ?? 0;
	const rows = db.all<any>(
		`SELECT sv.position, sv.status AS session_status, sv.new_download, sv.error, sv.source_json, v.uid, v.platform_id, v.url, c.username AS creator, v.caption, v.file_size, v.duration_s, v.width, v.height,
			v.download_status, v.analysis_status, v.cur_primary, v.cur_relevance, v.bookmarked
		 FROM session_videos sv JOIN videos v ON v.id=sv.video_id LEFT JOIN creators c ON c.id=v.creator_id WHERE ${w.join(' AND ')} ORDER BY sv.position LIMIT ? OFFSET ?`,
		...p, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0
	);
	return { total, videos: rows.map((r) => ({ ...r, source: parseJson(r.source_json, null), source_json: undefined, bookmarked: !!r.bookmarked, has_thumb: existsSync(thumbFile(r.uid)) })) };
}

/** Tail of the collector's own log (capped), from the session folder the importer recorded. */
export function sessionLog(id: string, maxBytes = 64_000, db: DB = getDb()): { path: string | null; text: string; truncated: boolean } {
	const dir = db.value<string>('SELECT src_dir FROM sessions WHERE id=?', id);
	if (!dir) return { path: null, text: '', truncated: false };
	const p = join(dir, 'collector.log');
	if (!existsSync(p)) return { path: p, text: '(no collector.log for this session)', truncated: false };
	const size = statSync(p).size;
	const start = Math.max(0, size - maxBytes);
	const fd = openSync(p, 'r');
	try {
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		return { path: p, text: buf.toString('utf8'), truncated: start > 0 };
	} finally {
		closeSync(fd);
	}
}
