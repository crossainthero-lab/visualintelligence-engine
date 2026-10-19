import { error, json } from '@sveltejs/kit';
import { appendBlob, blobOffset } from '#core/ingest.ts';

// HEAD -> where to resume (x-received, or x-complete: 1). PUT with x-offset (+ x-final-size on the last chunk).
export const HEAD = ({ params }) => {
	const off = blobOffset(params.sha);
	return new Response(null, { headers: off < 0 ? { 'x-complete': '1' } : { 'x-received': String(off) } });
};
export const PUT = async ({ params, request }) => {
	const offset = Number(request.headers.get('x-offset') ?? 0);
	const finalSize = request.headers.get('x-final-size');
	const chunk = Buffer.from(await request.arrayBuffer());
	try {
		return json(await appendBlob(params.sha, offset, chunk, finalSize ? { size: Number(finalSize) } : null));
	} catch (e: any) {
		if (e.status) return json({ error: e.message, received: e.received }, { status: e.status });
		throw error(400, e.message);
	}
};
