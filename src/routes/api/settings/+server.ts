import { json } from '@sveltejs/kit';
import { getSettings, setSettings } from '#core/settings.ts';
import { applyMediaLimits } from '#core/media.ts';
import { body, fail } from '#lib/server/http.ts';

export const GET = () => json(getSettings());
export const PUT = async ({ request }) => {
	try {
		const s = setSettings(await body(request));
		applyMediaLimits();
		return json(s);
	} catch (e) {
		fail(e);
	}
};
