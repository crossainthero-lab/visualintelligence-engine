import { json } from '@sveltejs/kit';
import { testProvider } from '#core/analysis/test.ts';
import { body } from '#lib/server/http.ts';

/** Explicit, billable-if-the-provider-bills smoke test: one generated image, one question. Never automatic. */
export const POST = async ({ params, request }) => {
	const b = await body(request).catch(() => ({}));
	return json(await testProvider(params.id, b.model));
};
