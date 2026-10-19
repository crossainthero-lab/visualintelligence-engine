import { json } from '@sveltejs/kit';
import { getDb } from '#core/db.ts';
import { parseJson } from '#core/util.ts';

// Analysis list (jobs) with video context. Filters: status, video, batch.
export const GET = ({ url }) => {
	const db = getDb();
	const p = url.searchParams;
	const w: string[] = [];
	const a: any[] = [];
	if (p.get('status')) (w.push(`a.status IN (${p.get('status')!.split(',').map(() => '?').join(',')})`), a.push(...p.get('status')!.split(',')));
	if (p.get('video')) (w.push('v.uid=?'), a.push(p.get('video')));
	if (p.get('batch')) (w.push('b.uid=?'), a.push(p.get('batch')));
	const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
	const rows = db.all<any>(
		`SELECT a.uid, a.provider, a.model, a.profile, a.status, a.created_at, a.started_at, a.completed_at, a.error, a.summary, a.useful, a.relevance, a.confidence, a.usage_json, a.retries,
			v.uid AS video_uid, c.username AS creator, b.uid AS batch_uid
		 FROM analyses a JOIN videos v ON v.id=a.video_id LEFT JOIN creators c ON c.id=v.creator_id LEFT JOIN analysis_batches b ON b.id=a.batch_id ${where}
		 ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...a, Math.min(Number(p.get('limit') ?? 100), 500), Number(p.get('offset') ?? 0));
	return json({ analyses: rows.map((r) => ({ ...r, usage: parseJson(r.usage_json, null), usage_json: undefined })) });
};
