import { json } from '@sveltejs/kit';
import { cacheStats, cancelThumbs, generateMissingThumbnails, pruneCache, thumbProgress } from '#core/media.ts';
import { getDb } from '#core/db.ts';
import { absPath } from '#core/videos.ts';
import { getSettings } from '#core/settings.ts';
import { body } from '#lib/server/http.ts';

export const GET = () => json({ thumbs: thumbProgress(), cache: cacheStats() });
export const POST = async ({ request }) => {
	const b = await body(request);
	const db = getDb();
	if (b.action === 'thumbnails') return json(await generateMissingThumbnails(db, (v) => absPath(db, v)));
	if (b.action === 'cancel-thumbnails') return (cancelThumbs(), json({ ok: true }));
	if (b.action === 'prune-cache') {
		const s = getSettings(db).media;
		return json(pruneCache(s.cacheMaxMB * 1048576, s.cacheMaxAgeDays * 86400000, !!b.dryRun));
	}
	return json({ error: 'unknown action' }, { status: 400 });
};
