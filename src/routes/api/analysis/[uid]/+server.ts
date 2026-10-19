import { error, json } from '@sveltejs/kit';
import { getDb } from '#core/db.ts';
import { cancelAnalysis, retryAnalysis } from '#core/analysis/runner.ts';
import { parseJson } from '#core/util.ts';
import { body, fail } from '#lib/server/http.ts';

export const GET = ({ params }) => {
	const a = getDb().get<any>(`SELECT a.*, v.uid AS video_uid FROM analyses a JOIN videos v ON v.id=a.video_id WHERE a.uid=?`, params.uid);
	if (!a) throw error(404, 'analysis not found');
	return json({ ...a, result: parseJson(a.result_json, null), input: parseJson(a.input_json, null), usage: parseJson(a.usage_json, null), evidence: parseJson(a.evidence_json, null), result_json: undefined, input_json: undefined, usage_json: undefined, evidence_json: undefined });
};
export const POST = async ({ params, request }) => {
	const { action } = await body(request);
	try {
		if (action === 'cancel') return (cancelAnalysis(params.uid), json({ ok: true }));
		if (action === 'retry') return json(await retryAnalysis(params.uid));
		return fail('unknown action');
	} catch (e) {
		return fail(e);
	}
};
