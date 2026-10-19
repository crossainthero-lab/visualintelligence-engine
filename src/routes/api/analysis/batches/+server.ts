import { json } from '@sveltejs/kit';
import { createBatch, listBatches } from '#core/analysis/runner.ts';
import { resolveSelection } from '#core/analysis/select.ts';
import { body, fail, filterFromParams } from '#lib/server/http.ts';

export const GET = () => json({ batches: listBatches(40) });

/** Explicit analysis request. The only way analysis ever starts from the dashboard. */
export const POST = async ({ request }) => {
	const b = await body(request);
	try {
		const spec: any = { ...b.selection };
		if (spec.scope === 'filter' && typeof spec.filter === 'string') spec.filter = filterFromParams(new URLSearchParams(spec.filter));
		const sel = resolveSelection(spec);
		if (!sel.uids.length) fail('the selection matched no videos');
		const r = await createBatch(sel, { provider: b.provider, profile: b.profile, model: b.model || undefined, concurrency: b.concurrency, maxSuccess: b.maxSuccess || undefined, maxCostUsd: b.maxCostUsd || undefined, reanalyse: !!b.reanalyse, note: b.note });
		return json({ ...r, description: sel.description });
	} catch (e) {
		fail(e);
	}
};
