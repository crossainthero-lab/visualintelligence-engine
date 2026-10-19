import { error, json } from '@sveltejs/kit';
import { batchSummary, setBatchState } from '#core/analysis/runner.ts';
import { body, fail } from '#lib/server/http.ts';

export const GET = ({ params }) => {
	const s = batchSummary(params.uid);
	if (!s) throw error(404, 'batch not found');
	return json(s);
};
/** {action: pause|resume|cancel}. Pause stops dispatching new work; cancel also aborts running analyses. */
export const POST = async ({ params, request }) => {
	const { action } = await body(request);
	try {
		setBatchState(params.uid, action === 'pause' ? 'paused' : action === 'resume' ? 'running' : action === 'cancel' ? 'cancelled' : fail('unknown action'));
		return json(batchSummary(params.uid));
	} catch (e) {
		fail(e);
	}
};
