import { json } from '@sveltejs/kit';
import { listSessions } from '#core/sessions.ts';

export const GET = ({ url }) => {
	const p = url.searchParams;
	return json(listSessions({ limit: Number(p.get('limit') ?? 100), offset: Number(p.get('offset') ?? 0), status: p.get('status') ?? undefined, from: p.get('from') ?? undefined, to: p.get('to') ?? undefined }));
};
