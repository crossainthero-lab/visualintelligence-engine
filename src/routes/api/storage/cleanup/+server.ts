import { json } from '@sveltejs/kit';
import { executeCleanup, planCleanup } from '#core/storage.ts';
import { body, fail } from '#lib/server/http.ts';

// Two steps by design: POST {kind} returns the exact plan; POST {planId, confirm:"delete N"} executes it.
export const POST = async ({ request }) => {
	const b = await body(request);
	try {
		if (b.planId) return json(executeCleanup(b.planId, String(b.confirm ?? '')));
		return json(planCleanup(b.kind));
	} catch (e) {
		fail(e);
	}
};
