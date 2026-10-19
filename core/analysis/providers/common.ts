import { run, which } from '../../exec.ts';

/** First balanced JSON object in text (agents sometimes wrap output in prose or a fence). */
export function extractJson(text: string): any | null {
	if (!text) return null;
	const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	try {
		return JSON.parse(t);
	} catch {
		/* fall through */
	}
	const start = t.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) {
			try {
				return JSON.parse(t.slice(start, i + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

export async function cliVersion(cmd: string): Promise<{ path: string | null; version: string | null }> {
	const path = which(cmd);
	if (!path) return { path: null, version: null };
	const r = await run(path, ['--version'], { timeoutMs: 15_000 });
	return { path, version: r.code === 0 ? r.stdout.trim().split('\n')[0] : null };
}
