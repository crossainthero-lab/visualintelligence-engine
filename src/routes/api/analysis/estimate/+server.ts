import { json } from '@sveltejs/kit';
import { estimate } from '#core/analysis/runner.ts';
import { resolveSelection } from '#core/analysis/select.ts';
import { body, fail, filterFromParams } from '#lib/server/http.ts';

export const POST = async ({ request }) => {
	const b = await body(request);
	try {
		const spec: any = { ...b.selection };
		if (spec.scope === 'filter' && typeof spec.filter === 'string') spec.filter = filterFromParams(new URLSearchParams(spec.filter));
		const sel = resolveSelection(spec);
		return json({ description: sel.description, ...estimate(sel.uids, b.provider, b.profile) });
	} catch (e) {
		fail(e);
	}
};
