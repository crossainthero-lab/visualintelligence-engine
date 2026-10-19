import type { DB } from '../db.ts';
import { getDb } from '../db.ts';
import { selectUids, type VideoFilter } from '../videos.ts';
import type { Selection } from './runner.ts';

export type SelectionSpec =
	| { scope: 'uids'; uids: string[] }
	| { scope: 'session'; session: string; onlyUnanalysed?: boolean; limit?: number }
	| { scope: 'filter'; filter: VideoFilter; limit?: number }
	| { scope: 'next'; n: number; session?: string; creator?: string }
	| { scope: 'bookmarked'; onlyUnanalysed?: boolean; limit?: number }
	| { scope: 'creator'; creator: string; onlyUnanalysed?: boolean; limit?: number };

/** Turns an explicit request into an explicit list of video ids. Nothing is ever selected implicitly. */
export function resolveSelection(spec: SelectionSpec, db: DB = getDb()): Selection {
	const cap = (a: string[], n?: number) => (n ? a.slice(0, n) : a);
	const base: VideoFilter = { downloadStatus: 'downloaded', sort: 'collected', dir: 'desc' };
	switch (spec.scope) {
		case 'uids':
			return { uids: [...new Set(spec.uids)], description: `${spec.uids.length} selected video(s)` };
		case 'session': {
			const u = selectUids({ ...base, sessionId: spec.session, analysis: spec.onlyUnanalysed === false ? 'any' : 'unanalysed' }, 5000, db);
			return { uids: cap(u, spec.limit), description: `session ${spec.session}${spec.limit ? ` (first ${spec.limit})` : ''}${spec.onlyUnanalysed === false ? '' : ', unanalysed only'}` };
		}
		case 'filter': {
			const u = selectUids({ ...base, ...spec.filter, limit: undefined }, 5000, db);
			return { uids: cap(u, spec.limit), description: `current filter (${u.length} match${spec.limit ? `, first ${spec.limit}` : ''})` };
		}
		case 'next': {
			const u = selectUids({ ...base, analysis: 'unanalysed', sessionId: spec.session, creator: spec.creator }, spec.n, db);
			return { uids: u, description: `next ${spec.n} unanalysed${spec.session ? ` in session ${spec.session}` : ''}${spec.creator ? ` by @${spec.creator}` : ''} (newest first)` };
		}
		case 'bookmarked': {
			const u = selectUids({ ...base, bookmarked: true, analysis: spec.onlyUnanalysed === false ? 'any' : 'unanalysed' }, 5000, db);
			return { uids: cap(u, spec.limit), description: 'bookmarked videos' };
		}
		case 'creator': {
			const u = selectUids({ ...base, creator: spec.creator, analysis: spec.onlyUnanalysed === false ? 'any' : 'unanalysed' }, 5000, db);
			return { uids: cap(u, spec.limit), description: `videos by @${spec.creator.replace(/^@/, '')}` };
		}
	}
}
