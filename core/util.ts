import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function uid(prefix: string, len = 10): string {
	const b = randomBytes(len);
	let s = '';
	for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
	return `${prefix}_${s}`;
}

export function parseJson<T = any>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((res) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
	});

export function hashtags(caption: string | null | undefined): string[] {
	if (!caption) return [];
	return [...new Set([...caption.matchAll(/#([\p{L}\p{N}_]{2,60})/gu)].map((m) => m[1].toLowerCase()))];
}

export function clamp(n: number, lo: number, hi: number) {
	return Math.min(hi, Math.max(lo, n));
}

export function fmtBytes(n: number | null | undefined): string {
	if (n == null) return '—';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
	return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/** Run async tasks with a hard concurrency cap. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}
