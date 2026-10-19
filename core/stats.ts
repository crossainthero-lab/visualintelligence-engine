import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { statfsSync } from 'node:fs';
import { dataDir } from './paths.ts';

export interface Range {
	from?: string;
	to?: string;
}

function rangeSql(r: Range, col: string) {
	const w: string[] = [];
	const p: any[] = [];
	if (r.from) (w.push(`${col} >= ?`), p.push(r.from));
	if (r.to) (w.push(`${col} < ?`), p.push(r.to));
	return { sql: w.length ? ' AND ' + w.join(' AND ') : '', p };
}

export function overview(range: Range = {}, db: DB = getDb()) {
	const rv = rangeSql(range, 'v.first_collected_at');
	const rs = rangeSql(range, 's.started_at');
	const d = (sql: string, ...p: any[]) => db.value<number>(sql, ...p) ?? 0;
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const downloaded = d(`SELECT COUNT(*) FROM videos v WHERE v.download_status='downloaded'${rv.sql}`, ...rv.p);
	const analysed = d(`SELECT COUNT(*) FROM videos v WHERE v.download_status='downloaded' AND v.analysis_status='analysed'${rv.sql}`, ...rv.p);
	const unanalysed = downloaded - analysed;

	const series = db.all<{ day: string; videos: number; bytes: number }>(
		`SELECT substr(v.first_collected_at,1,10) AS day, COUNT(*) videos, COALESCE(SUM(v.file_size),0) bytes FROM videos v
		 WHERE v.download_status='downloaded' AND v.first_collected_at IS NOT NULL${rv.sql} GROUP BY day ORDER BY day`, ...rv.p);
	let cum = d(`SELECT COALESCE(SUM(file_size),0) FROM videos v WHERE v.download_status='downloaded' AND v.first_collected_at < ?`, range.from ?? '0000');
	const growth = series.map((r) => ({ day: r.day, bytes: (cum += r.bytes) }));

	return {
		range,
		totals: {
			uniqueVideos: d(`SELECT COUNT(*) FROM videos v WHERE 1=1${rv.sql}`, ...rv.p),
			downloadedFiles: downloaded,
			collectedToday: d(`SELECT COUNT(*) FROM videos WHERE download_status='downloaded' AND first_collected_at >= ?`, startOfDay.toISOString()),
			sessions: d(`SELECT COUNT(*) FROM sessions s WHERE 1=1${rs.sql}`, ...rs.p),
			diskBytes: d(`SELECT COALESCE(SUM(file_size),0) FROM videos v WHERE v.download_status='downloaded'${rv.sql}`, ...rv.p),
			analysed,
			unanalysed,
			analysisPct: downloaded ? Math.round((analysed / downloaded) * 1000) / 10 : 0,
			pendingJobs: d(`SELECT COUNT(*) FROM analyses WHERE status IN ('queued','preparing','running')`),
			failedJobs: d(`SELECT COUNT(*) FROM analyses WHERE status='failed'`),
			duplicatesAvoided: d(`SELECT COUNT(*) FROM session_videos sv JOIN sessions s ON s.id=sv.session_id WHERE sv.status='duplicate'${rs.sql}`, ...rs.p),
			missingFiles: d(`SELECT COUNT(*) FROM videos WHERE file_missing=1`),
			incompleteSessions: d(`SELECT COUNT(*) FROM sessions WHERE incomplete=1`)
		},
		perDay: series,
		storageGrowth: growth,
		bySource: db.all(`SELECT COALESCE(v.source_kind,'unknown') AS source, COUNT(*) n FROM videos v WHERE v.download_status='downloaded'${rv.sql} GROUP BY source ORDER BY n DESC`, ...rv.p),
		byClassification: db.all(
			`SELECT COALESCE(v.cur_primary,'unclassified') AS classification, COUNT(*) n FROM videos v WHERE v.download_status='downloaded'${rv.sql} GROUP BY classification ORDER BY n DESC`, ...rv.p)
	};
}

export function diskFree(path = dataDir()) {
	try {
		const s = statfsSync(path);
		return { path, freeBytes: Number(s.bavail) * s.bsize, totalBytes: Number(s.blocks) * s.bsize };
	} catch {
		return { path, freeBytes: null as number | null, totalBytes: null as number | null };
	}
}
