import type { DB } from './db.ts';
import { parseJson } from './util.ts';

export interface ExportOpts {
	format: 'json' | 'jsonl' | 'csv';
	onlyAnalysed?: boolean;
	uids?: string[];
}

export function exportRecords(db: DB, o: Pick<ExportOpts, 'onlyAnalysed' | 'uids'> = {}) {
	const w = [`v.download_status='downloaded'`];
	const p: any[] = [];
	if (o.onlyAnalysed !== false) w.push(`v.current_analysis_id IS NOT NULL`);
	if (o.uids?.length) (w.push(`v.uid IN (${o.uids.map(() => '?').join(',')})`), p.push(...o.uids));
	const rows = db.all<any>(
		`SELECT v.*, c.username AS creator FROM videos v LEFT JOIN creators c ON c.id=v.creator_id WHERE ${w.join(' AND ')} ORDER BY v.first_collected_at, v.id`, ...p);
	return rows.map((v) => {
		const a = v.current_analysis_id ? db.get<any>('SELECT uid,provider,model,profile,schema_version,prompt_version,completed_at,result_json,usage_json,input_json FROM analyses WHERE id=?', v.current_analysis_id) : null;
		return {
			video: { uid: v.uid, platform_id: v.platform_id, url: v.url, creator: v.creator, caption: v.caption, hashtags: parseJson(v.hashtags, []), posted_at: v.posted_at, first_collected_at: v.first_collected_at, source_kind: v.source_kind, duration_s: v.duration_s, width: v.width, height: v.height, fps: v.fps, file_size: v.file_size, sha256: v.sha256 },
			sessions: db.all('SELECT session_id, status FROM session_videos WHERE video_id=?', v.id),
			tags: db.all<any>('SELECT t.name FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=?', v.id).map((t) => t.name),
			bookmarked: !!v.bookmarked,
			notes: v.notes,
			current_labels: db.all('SELECT kind,key,confidence,source FROM video_current_labels WHERE video_id=? ORDER BY kind,confidence DESC', v.id),
			research: { useful: v.cur_useful, relevance: v.cur_relevance, confidence: v.cur_confidence },
			human_corrections: db.all('SELECT field,new_json,note,created_at FROM corrections WHERE video_id=? ORDER BY id', v.id).map((c: any) => ({ ...c, new: parseJson(c.new_json, null), new_json: undefined })),
			analysis: a && { uid: a.uid, provider: a.provider, model: a.model, profile: a.profile, schema_version: a.schema_version, prompt_version: a.prompt_version, completed_at: a.completed_at, evidence_given: parseJson(a.input_json, null), usage: parseJson(a.usage_json, null), result: parseJson(a.result_json, null) },
			analysis_history: db.all('SELECT uid,provider,model,profile,status,completed_at FROM analyses WHERE video_id=? ORDER BY id', v.id)
		};
	});
}

const q = (x: any) => `"${String(x ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

export function exportResearch(db: DB, o: ExportOpts): string {
	const recs = exportRecords(db, o);
	if (o.format === 'jsonl') return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
	if (o.format === 'csv') {
		const head = ['uid', 'platform_id', 'creator', 'url', 'collected', 'duration_s', 'width', 'height', 'useful', 'relevance', 'confidence', 'categories', 'techniques', 'observations', 'provider', 'model', 'profile', 'summary', 'tags', 'bookmarked'];
		const lines = [head.join(',')];
		for (const r of recs) {
			const L = (k: string) => r.current_labels.filter((l: any) => l.kind === k).map((l: any) => l.key).join('|');
			lines.push([r.video.uid, r.video.platform_id, r.video.creator, r.video.url, r.video.first_collected_at, r.video.duration_s, r.video.width, r.video.height, r.research.useful, r.research.relevance, r.research.confidence, L('category'), L('technique'), L('observation'), r.analysis?.provider, r.analysis?.model, r.analysis?.profile, r.analysis?.result?.summary, r.tags.join('|'), r.bookmarked].map(q).join(','));
		}
		return lines.join('\n') + '\n';
	}
	return JSON.stringify({ exported_at: new Date().toISOString(), count: recs.length, records: recs }, null, 1);
}
