import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { DB, Row } from './db.ts';
import { getDb, now } from './db.ts';
import { GROUPS } from './taxonomy.ts';
import { parseJson } from './util.ts';
import { thumbFile } from './media.ts';

export interface VideoFilter {
	q?: string;
	analysis?: 'analysed' | 'unanalysed' | 'queued' | 'running' | 'failed' | 'any';
	sessionId?: string;
	creator?: string;
	from?: string; // ISO date, first collected >=
	to?: string;
	minSize?: number;
	maxSize?: number;
	minDuration?: number;
	maxDuration?: number;
	minHeight?: number;
	category?: string[];
	technique?: string[];
	observation?: string[];
	group?: Array<'motionGraphics' | 'aiFilm' | 'threeD' | 'interestingTechnique'>;
	bookmarked?: boolean;
	tag?: string;
	useful?: 'useful' | 'not_useful' | 'uncertain';
	minConfidence?: number;
	minRelevance?: number;
	source?: string;
	downloadStatus?: string; // default 'downloaded'; 'all' for everything
	ids?: string[];
	sort?: 'collected' | 'size' | 'duration' | 'relevance' | 'creator' | 'resolution' | 'posted';
	dir?: 'asc' | 'desc';
	limit?: number;
	offset?: number;
}

const SORTS: Record<string, string> = {
	collected: 'v.first_collected_at',
	size: 'v.file_size',
	duration: 'v.duration_s',
	relevance: 'v.cur_relevance',
	creator: 'c.username COLLATE NOCASE',
	resolution: '(COALESCE(v.width,0)*COALESCE(v.height,0))',
	posted: 'v.posted_at'
};

const labelExists = (kind: string, n: number) => `EXISTS (SELECT 1 FROM video_current_labels l WHERE l.video_id=v.id AND l.kind='${kind}' AND l.key IN (${Array(n).fill('?').join(',')}))`;

export function buildWhere(f: VideoFilter): { where: string; params: any[] } {
	const w: string[] = [];
	const p: any[] = [];
	const ds = f.downloadStatus ?? 'downloaded';
	if (ds !== 'all') (w.push('v.download_status = ?'), p.push(ds));
	if (f.q?.trim()) {
		for (const term of f.q.trim().split(/\s+/).slice(0, 6)) {
			const like = `%${term.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
			w.push(`(v.caption LIKE ? ESCAPE '\\' OR c.username LIKE ? ESCAPE '\\' OR v.platform_id LIKE ? ESCAPE '\\' OR v.notes LIKE ? ESCAPE '\\' OR v.cur_summary LIKE ? ESCAPE '\\'
				OR EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=v.id AND t.name LIKE ? ESCAPE '\\'))`);
			p.push(like, like, like, like, like, like);
		}
	}
	if (f.analysis && f.analysis !== 'any') {
		if (f.analysis === 'analysed') w.push(`v.analysis_status='analysed'`);
		else if (f.analysis === 'unanalysed') w.push(`v.analysis_status IN ('none','failed')`);
		else (w.push('v.analysis_status = ?'), p.push(f.analysis));
	}
	if (f.sessionId) (w.push('EXISTS (SELECT 1 FROM session_videos sv WHERE sv.video_id=v.id AND sv.session_id=?)'), p.push(f.sessionId));
	if (f.creator) (w.push('c.username = ? COLLATE NOCASE'), p.push(f.creator.replace(/^@/, '')));
	if (f.from) (w.push('v.first_collected_at >= ?'), p.push(f.from));
	if (f.to) (w.push('v.first_collected_at < ?'), p.push(f.to));
	if (f.minSize != null) (w.push('v.file_size >= ?'), p.push(f.minSize));
	if (f.maxSize != null) (w.push('v.file_size <= ?'), p.push(f.maxSize));
	if (f.minDuration != null) (w.push('v.duration_s >= ?'), p.push(f.minDuration));
	if (f.maxDuration != null) (w.push('v.duration_s <= ?'), p.push(f.maxDuration));
	if (f.minHeight != null) (w.push('MAX(COALESCE(v.height,0),COALESCE(v.width,0)) >= ?'), p.push(f.minHeight));
	for (const kind of ['category', 'technique', 'observation'] as const) {
		const keys = f[kind];
		if (keys?.length) (w.push(labelExists(kind, keys.length)), p.push(...keys));
	}
	for (const g of f.group ?? []) {
		const parts = (GROUPS[g] ?? []).map((x) => (p.push(...x.keys), labelExists(x.kind, x.keys.length)));
		if (parts.length) w.push(`(${parts.join(' OR ')})`);
	}
	if (f.bookmarked != null) w.push(f.bookmarked ? 'v.bookmarked=1' : 'v.bookmarked=0');
	if (f.tag) (w.push('EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=v.id AND t.name = ? COLLATE NOCASE)'), p.push(f.tag));
	if (f.useful) (w.push('v.cur_useful = ?'), p.push(f.useful));
	if (f.minConfidence != null) (w.push('v.cur_confidence >= ?'), p.push(f.minConfidence));
	if (f.minRelevance != null) (w.push('v.cur_relevance >= ?'), p.push(f.minRelevance));
	if (f.source) (w.push('v.source_kind = ?'), p.push(f.source));
	if (f.ids?.length) (w.push(`v.uid IN (${f.ids.map(() => '?').join(',')})`), p.push(...f.ids));
	return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

const COLS = `v.id, v.uid, v.platform_id, v.url, c.username AS creator, c.profile_url AS creator_url, v.caption, v.hashtags, v.posted_at, v.first_collected_at, v.source_kind,
	v.first_session_id, v.file_size, v.duration_s, v.width, v.height, v.fps, v.video_codec, v.audio_codec, v.has_audio, v.sha256, v.download_status, v.file_missing,
	v.analysis_status, v.cur_useful, v.cur_relevance, v.cur_confidence, v.cur_primary, v.cur_summary, v.bookmarked, v.notes,
	(SELECT group_concat(t.name, ',') FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=v.id) AS tags,
	(SELECT COUNT(*) FROM session_videos sv WHERE sv.video_id=v.id) AS session_count`;

function shape(r: Row): Row & { hashtags: string[]; tags: string[]; bookmarked: boolean; has_audio: boolean | null; file_missing: boolean; has_thumb: boolean } {
	return {
		...r,
		hashtags: parseJson<string[]>(r.hashtags, []),
		tags: r.tags ? String(r.tags).split(',') : [],
		bookmarked: !!r.bookmarked,
		has_audio: r.has_audio == null ? null : !!r.has_audio,
		file_missing: !!r.file_missing,
		has_thumb: existsSync(thumbFile(r.uid))
	};
}
export type VideoRow = ReturnType<typeof shape>;

export function listVideos(f: VideoFilter = {}, db: DB = getDb()) {
	const { where, params } = buildWhere(f);
	const limit = Math.min(Math.max(f.limit ?? 60, 1), 500);
	const offset = Math.max(f.offset ?? 0, 0);
	const sort = SORTS[f.sort ?? 'collected'] ?? SORTS.collected;
	const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
	const from = `FROM videos v LEFT JOIN creators c ON c.id=v.creator_id`;
	const total = db.value<number>(`SELECT COUNT(*) ${from} ${where}`, ...params) ?? 0;
	const rows = db.all(`SELECT ${COLS} ${from} ${where} ORDER BY ${sort} ${dir} NULLS LAST, v.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset).map(shape);
	return { total, limit, offset, videos: rows };
}

/** uids matching a filter (used to turn "analyse the current filtered results" into an explicit id list). */
export function selectUids(f: VideoFilter, max = 5000, db: DB = getDb()): string[] {
	const { where, params } = buildWhere({ ...f, limit: undefined });
	const sort = SORTS[f.sort ?? 'collected'] ?? SORTS.collected;
	return db
		.all<{ uid: string }>(`SELECT v.uid FROM videos v LEFT JOIN creators c ON c.id=v.creator_id ${where} ORDER BY ${sort} ${f.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, v.id DESC LIMIT ?`, ...params, max)
		.map((r) => r.uid);
}

export function getVideo(idOrUid: string | number, db: DB = getDb()) {
	const where = typeof idOrUid === 'number' || /^\d+$/.test(String(idOrUid)) ? 'v.id = ?' : 'v.uid = ?';
	const r = db.get(`SELECT ${COLS}, v.root_id, v.rel_path, v.source_info_json, v.provenance_json, v.content_dup_of, v.current_analysis_id, v.canonical_url FROM videos v LEFT JOIN creators c ON c.id=v.creator_id WHERE ${where}`, idOrUid as any);
	if (!r) return null;
	const base = shape(r);
	return {
		...base,
		source_info: parseJson(r.source_info_json, null),
		provenance: parseJson<any[]>(r.provenance_json, []),
		sessions: db.all(
			`SELECT sv.session_id, sv.status, sv.new_download, sv.source_json, sv.discovered_at, sv.downloaded_at, s.mode, s.started_at FROM session_videos sv JOIN sessions s ON s.id=sv.session_id WHERE sv.video_id=? ORDER BY s.started_at`,
			r.id
		).map((x) => ({ ...x, source: parseJson(x.source_json, null), source_json: undefined })),
		labels: db.all(`SELECT kind,key,confidence,source FROM video_current_labels WHERE video_id=? ORDER BY kind, confidence DESC`, r.id),
		corrections: db.all(`SELECT field,old_json,new_json,note,created_at FROM corrections WHERE video_id=? ORDER BY id DESC LIMIT 50`, r.id)
	};
}

export function absPath(db: DB, v: { root_id: number | null; rel_path: string | null }): string | null {
	if (v.root_id == null || !v.rel_path) return null;
	const root = db.value<string>('SELECT path FROM media_roots WHERE id=?', v.root_id);
	return root ? join(root, v.rel_path) : null;
}

export function videoAbsByUid(uid: string, db: DB = getDb()): { id: number; uid: string; abs: string; duration_s: number | null; width: number | null; height: number | null } | null {
	const v = db.get<any>('SELECT id,uid,root_id,rel_path,duration_s,width,height FROM videos WHERE uid=?', uid);
	if (!v) return null;
	const abs = absPath(db, v);
	return abs ? { id: v.id, uid: v.uid, abs, duration_s: v.duration_s, width: v.width, height: v.height } : null;
}

// ---- human edits ------------------------------------------------------------------------------------------------

export function setBookmark(uids: string[], on: boolean, db: DB = getDb()) {
	return db.tx(() => uids.map((u) => db.run('UPDATE videos SET bookmarked=?, updated_at=? WHERE uid=?', on ? 1 : 0, now(), u).changes).reduce((a, b) => Number(a) + Number(b), 0));
}

export function setNotes(uid: string, notes: string, db: DB = getDb()) {
	db.tx(() => {
		const old = db.value<string>('SELECT notes FROM videos WHERE uid=?', uid);
		db.run('UPDATE videos SET notes=?, updated_at=? WHERE uid=?', notes || null, now(), uid);
		const id = db.value<number>('SELECT id FROM videos WHERE uid=?', uid);
		if (id) db.run('INSERT INTO corrections(video_id,field,old_json,new_json,created_at) VALUES (?,?,?,?,?)', id, 'notes', JSON.stringify(old ?? null), JSON.stringify(notes), now());
	});
}

export function addTags(uids: string[], tags: string[], source = 'human', db: DB = getDb()) {
	db.tx(() => {
		for (const name of tags.map((t) => t.trim()).filter(Boolean)) {
			db.run('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING', name);
			const tid = db.value<number>('SELECT id FROM tags WHERE name=?', name)!;
			for (const u of uids) db.run('INSERT INTO video_tags(video_id,tag_id,source,created_at) SELECT id,?,?,? FROM videos WHERE uid=? ON CONFLICT DO NOTHING', tid, source, now(), u);
		}
	});
}
export function removeTags(uids: string[], tags: string[], db: DB = getDb()) {
	db.tx(() => {
		for (const name of tags) for (const u of uids) db.run('DELETE FROM video_tags WHERE video_id=(SELECT id FROM videos WHERE uid=?) AND tag_id=(SELECT id FROM tags WHERE name=? COLLATE NOCASE)', u, name);
		db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM video_tags)');
	});
}
export const allTags = (db: DB = getDb()) => db.all<{ name: string; n: number }>('SELECT t.name, COUNT(vt.video_id) n FROM tags t LEFT JOIN video_tags vt ON vt.tag_id=t.id GROUP BY t.id ORDER BY n DESC, t.name');

/**
 * Human classification edit. kind/key add (status active) or remove (status rejected) a label; the original agent
 * output stays untouched in analyses/*, and every change is logged in `corrections`.
 */
export function correctLabel(uid: string, kind: 'category' | 'technique' | 'observation', key: string, action: 'add' | 'reject' | 'clear', note?: string, db: DB = getDb()) {
	db.tx(() => {
		const id = db.value<number>('SELECT id FROM videos WHERE uid=?', uid);
		if (!id) throw new Error(`unknown video ${uid}`);
		db.run('DELETE FROM video_labels WHERE video_id=? AND analysis_id IS NULL AND kind=? AND key=?', id, kind, key);
		if (action !== 'clear') db.run('INSERT INTO video_labels(video_id,analysis_id,kind,key,confidence,status,note,created_at) VALUES (?,?,?,?,?,?,?,?)', id, null, kind, key, action === 'add' ? 1 : null, action === 'add' ? 'active' : 'rejected', note ?? null, now());
		db.run('INSERT INTO corrections(video_id,field,old_json,new_json,note,created_at) VALUES (?,?,?,?,?,?)', id, `label:${kind}`, null, JSON.stringify({ key, action }), note ?? null, now());
		rebuildCurrent(id, db);
	});
}

export function correctResearch(uid: string, patch: { useful?: 'useful' | 'not_useful' | 'uncertain' | null; relevance?: number | null }, note?: string, db: DB = getDb()) {
	db.tx(() => {
		const v = db.get<any>('SELECT id,cur_useful,cur_relevance FROM videos WHERE uid=?', uid);
		if (!v) throw new Error(`unknown video ${uid}`);
		db.run('INSERT INTO corrections(video_id,field,old_json,new_json,note,created_at) VALUES (?,?,?,?,?,?)', v.id, 'research', JSON.stringify({ useful: v.cur_useful, relevance: v.cur_relevance }), JSON.stringify(patch), note ?? null, now());
		rebuildCurrent(v.id, db);
	});
}

/** Recompute `video_current_labels` + the denormalised summary columns from the current analysis and human edits. */
export function rebuildCurrent(videoId: number, db: DB = getDb()) {
	const v = db.get<any>('SELECT current_analysis_id FROM videos WHERE id=?', videoId);
	if (!v) return;
	db.run('DELETE FROM video_current_labels WHERE video_id=?', videoId);
	if (v.current_analysis_id) {
		db.run(
			`INSERT OR REPLACE INTO video_current_labels(video_id,kind,key,confidence,source) SELECT video_id,kind,key,confidence,'agent' FROM video_labels WHERE video_id=? AND analysis_id=? AND status='active'`,
			videoId, v.current_analysis_id
		);
	}
	for (const h of db.all<any>(`SELECT kind,key,confidence,status FROM video_labels WHERE video_id=? AND analysis_id IS NULL`, videoId)) {
		if (h.status === 'active') db.run(`INSERT OR REPLACE INTO video_current_labels(video_id,kind,key,confidence,source) VALUES (?,?,?,?,'human')`, videoId, h.kind, h.key, 1);
		else db.run('DELETE FROM video_current_labels WHERE video_id=? AND kind=? AND key=?', videoId, h.kind, h.key);
	}
	const a = v.current_analysis_id ? db.get<any>('SELECT useful,relevance,confidence,summary FROM analyses WHERE id=?', v.current_analysis_id) : null;
	let useful = a?.useful ?? null;
	let relevance = a?.relevance ?? null;
	// latest human override of the research verdict wins
	const hum = db.get<any>(`SELECT new_json FROM corrections WHERE video_id=? AND field='research' ORDER BY id DESC LIMIT 1`, videoId);
	if (hum) {
		const p = parseJson<any>(hum.new_json, {});
		if (p.useful !== undefined) useful = p.useful;
		if (p.relevance !== undefined) relevance = p.relevance;
	}
	const primary = db.get<any>(`SELECT key FROM video_current_labels WHERE video_id=? AND kind='category' ORDER BY (source='human') DESC, confidence DESC LIMIT 1`, videoId);
	db.run('UPDATE videos SET cur_useful=?, cur_relevance=?, cur_confidence=?, cur_primary=?, cur_summary=?, updated_at=? WHERE id=?', useful, relevance, a?.confidence ?? null, primary?.key ?? null, a?.summary ?? null, now(), videoId);
}
