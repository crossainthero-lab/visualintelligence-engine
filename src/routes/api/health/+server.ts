import { json } from '@sveltejs/kit';
import { getDb } from '#core/db.ts';

export const GET = () => {
	const db = getDb();
	return json({ ok: true, version: '0.2.0', db: db.value('SELECT COUNT(*) FROM videos') !== undefined, uptimeS: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) });
};
