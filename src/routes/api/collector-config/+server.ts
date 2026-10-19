import { json } from '@sveltejs/kit';
import { readCollectorConfig, writeCollectorConfig } from '#core/collectorConfig.ts';
import { body, fail } from '#lib/server/http.ts';

export const GET = () => json(readCollectorConfig());
export const PUT = async ({ request }) => {
	try {
		return json(writeCollectorConfig(await body(request)));
	} catch (e) {
		fail(e);
	}
};
