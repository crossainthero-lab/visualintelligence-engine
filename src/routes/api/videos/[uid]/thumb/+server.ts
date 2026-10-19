import { error } from '@sveltejs/kit';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ensureThumbnail, thumbFile } from '#core/media.ts';
import { getDb } from '#core/db.ts';
import { videoAbsByUid } from '#core/videos.ts';

export const GET = async ({ params }) => {
	let f = thumbFile(params.uid);
	if (!existsSync(f)) {
		const v = videoAbsByUid(params.uid);
		if (!v) throw error(404, 'video not found');
		const made = await ensureThumbnail(getDb(), v);
		if (!made) throw error(404, 'thumbnail unavailable');
		f = made;
	}
	return new Response(Readable.toWeb(createReadStream(f)) as ReadableStream, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
};
