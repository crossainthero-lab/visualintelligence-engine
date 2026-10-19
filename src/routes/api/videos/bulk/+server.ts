import { json } from '@sveltejs/kit';
import { addTags, removeTags, selectUids, setBookmark } from '#core/videos.ts';
import { body, fail, filterFromParams } from '#lib/server/http.ts';

/** Bulk edits on an explicit list of uids (or a filter, resolved to uids first). Never starts analysis. */
export const POST = async ({ request }) => {
	const b = await body(request);
	const uids: string[] = b.uids ?? (b.filter ? selectUids(filterFromParams(new URLSearchParams(b.filter)), 5000) : []);
	if (!uids.length) fail('no videos selected');
	if (b.action === 'bookmark') setBookmark(uids, true);
	else if (b.action === 'unbookmark') setBookmark(uids, false);
	else if (b.action === 'tag') addTags(uids, b.tags ?? []);
	else if (b.action === 'untag') removeTags(uids, b.tags ?? []);
	else fail('unknown action');
	return json({ ok: true, affected: uids.length });
};
