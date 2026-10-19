import { error, json } from '@sveltejs/kit';
import { addTags, correctLabel, correctResearch, getVideo, removeTags, setBookmark, setNotes } from '#core/videos.ts';
import { body } from '#lib/server/http.ts';

export const GET = ({ params }) => {
	const v = getVideo(params.uid);
	if (!v) throw error(404, 'video not found');
	return json(v);
};

/** Human edits: bookmark, notes, tags, label corrections, research verdict. Never touches media or agent output. */
export const PATCH = async ({ params, request }) => {
	const b = await body(request);
	if (!getVideo(params.uid)) throw error(404, 'video not found');
	if (typeof b.bookmarked === 'boolean') setBookmark([params.uid], b.bookmarked);
	if (typeof b.notes === 'string') setNotes(params.uid, b.notes);
	if (Array.isArray(b.addTags)) addTags([params.uid], b.addTags);
	if (Array.isArray(b.removeTags)) removeTags([params.uid], b.removeTags);
	if (b.label) correctLabel(params.uid, b.label.kind, String(b.label.key), b.label.action, b.label.note);
	if (b.research) correctResearch(params.uid, b.research, b.note);
	return json(getVideo(params.uid));
};
