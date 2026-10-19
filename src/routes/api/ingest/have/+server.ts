import { json } from '@sveltejs/kit';
import { haveBlobs } from '#core/ingest.ts';
import { body, fail } from '#lib/server/http.ts';

export const POST = async ({ request }) => {
	const b = await body(request);
	try {
		return json(haveBlobs(b.shas ?? []));
	} catch (e) {
		fail(e);
	}
};
