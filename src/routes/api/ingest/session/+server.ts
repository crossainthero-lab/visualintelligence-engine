import { json } from '@sveltejs/kit';
import { getDb } from '#core/db.ts';
import { ingestSession } from '#core/ingest.ts';
import { body } from '#lib/server/http.ts';

export const POST = async ({ request, locals }) => {
	const b = await body(request);
	try {
		return json(ingestSession(getDb(), locals.collectorId!, b));
	} catch (e: any) {
		return json({ error: e.message, problems: e.problems }, { status: e.status ?? 400 });
	}
};
