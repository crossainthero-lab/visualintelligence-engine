import { error } from '@sveltejs/kit';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { videoAbsByUid } from '#core/videos.ts';

// Range-capable streaming of the original file (no transcoding, no copy, no decode).
export const GET = ({ params, request }) => {
	const v = videoAbsByUid(params.uid);
	if (!v || !existsSync(v.abs)) throw error(404, 'video file not found');
	const size = statSync(v.abs).size;
	const range = request.headers.get('range');
	const type = v.abs.endsWith('.webm') ? 'video/webm' : 'video/mp4';
	if (range) {
		const m = /bytes=(\d*)-(\d*)/.exec(range);
		let start = m?.[1] ? Number(m[1]) : 0;
		let end = m?.[2] ? Number(m[2]) : size - 1;
		if (!m?.[1] && m?.[2]) (start = Math.max(0, size - Number(m[2])), (end = size - 1));
		if (start >= size || end >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
		const stream = createReadStream(v.abs, { start, end, highWaterMark: 256 * 1024 });
		return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } });
	}
	return new Response(Readable.toWeb(createReadStream(v.abs, { highWaterMark: 256 * 1024 })) as ReadableStream, { headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size) } });
};
