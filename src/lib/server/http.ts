import { error, json } from '@sveltejs/kit';
import type { VideoFilter } from '#core/videos.ts';

const num = (v: string | null) => (v == null || v === '' || isNaN(Number(v)) ? undefined : Number(v));
const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const bool = (v: string | null) => (v == null || v === '' ? undefined : v === '1' || v === 'true');

export function filterFromParams(p: URLSearchParams): VideoFilter {
	return {
		q: p.get('q') ?? undefined,
		analysis: (p.get('analysis') as any) || undefined,
		sessionId: p.get('session') ?? undefined,
		creator: p.get('creator') ?? undefined,
		from: p.get('from') ?? undefined,
		to: p.get('to') ?? undefined,
		minSize: num(p.get('minSize')),
		maxSize: num(p.get('maxSize')),
		minDuration: num(p.get('minDuration')),
		maxDuration: num(p.get('maxDuration')),
		minHeight: num(p.get('minHeight')),
		category: list(p.get('category')),
		technique: list(p.get('technique')),
		observation: list(p.get('observation')),
		group: list(p.get('group')) as any,
		bookmarked: bool(p.get('bookmarked')),
		tag: p.get('tag') ?? undefined,
		useful: (p.get('useful') as any) || undefined,
		minConfidence: num(p.get('minConfidence')),
		minRelevance: num(p.get('minRelevance')),
		source: p.get('source') ?? undefined,
		downloadStatus: p.get('status') ?? undefined,
		sort: (p.get('sort') as any) || undefined,
		dir: (p.get('dir') as any) || undefined,
		limit: num(p.get('limit')),
		offset: num(p.get('offset'))
	};
}

export async function body<T = any>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw error(400, 'invalid JSON body');
	}
}

export const ok = (data: unknown = { ok: true }) => json(data);
export function fail(e: unknown, status = 400): never {
	throw error(status, e instanceof Error ? e.message : String(e));
}
