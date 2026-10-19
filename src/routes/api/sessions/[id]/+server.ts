import { error, json } from '@sveltejs/kit';
import { getSession, sessionLog, sessionVideos } from '#core/sessions.ts';

export const GET = ({ params, url }) => {
	const s = getSession(params.id);
	if (!s) throw error(404, 'session not found');
	const p = url.searchParams;
	return json({
		session: s,
		videos: sessionVideos(params.id, { status: p.get('status') ?? undefined, limit: Number(p.get('limit') ?? 100), offset: Number(p.get('offset') ?? 0) }),
		log: p.get('log') ? sessionLog(params.id) : undefined
	});
};
