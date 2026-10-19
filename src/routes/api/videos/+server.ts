import { json } from '@sveltejs/kit';
import { listVideos, selectUids } from '#core/videos.ts';
import { filterFromParams } from '#lib/server/http.ts';

export const GET = ({ url }) => {
	const f = filterFromParams(url.searchParams);
	if (url.searchParams.get('uidsOnly')) return json({ uids: selectUids(f, Number(url.searchParams.get('max') ?? 5000)) });
	return json(listVideos(f));
};
