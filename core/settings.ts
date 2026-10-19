import type { DB } from './db.ts';
import { getDb, now } from './db.ts';
import { parseJson } from './util.ts';

export interface Settings {
	media: { thumbWidth: number; thumbConcurrency: number; autoThumbnails: boolean; frameConcurrency: number; cacheMaxMB: number; cacheMaxAgeDays: number; niceLevel: number };
	analysis: {
		concurrency: number;
		defaultProvider: string;
		defaultProfile: string;
		maxConcurrency: number;
		providers: Record<string, { enabled: boolean; model?: string; timeoutS?: number; command?: string; extra?: Record<string, any> }>;
	};
	collector: { sessionsDir: string };
	server: { trustedLan: boolean; requireAuth: boolean };
	retention: { keepAnalysisRawDays: number; keepCacheDays: number };
	sarness: { host: string; sshAlias: string; profile: string; endpoint: string };
}

export const DEFAULT_SETTINGS: Settings = {
	media: { thumbWidth: 360, thumbConcurrency: 1, autoThumbnails: true, frameConcurrency: 1, cacheMaxMB: 2048, cacheMaxAgeDays: 14, niceLevel: 15 },
	analysis: {
		concurrency: 1,
		maxConcurrency: 3,
		defaultProvider: '',
		defaultProfile: 'quick',
		providers: {
			claude: { enabled: true, timeoutS: 300 },
			codex: { enabled: true, timeoutS: 300 },
			antigravity: { enabled: false },
			sarness: { enabled: true, timeoutS: 300 }
		}
	},
	collector: { sessionsDir: '' },
	server: { trustedLan: false, requireAuth: false },
	retention: { keepAnalysisRawDays: 365, keepCacheDays: 14 },
	sarness: { host: '', sshAlias: '', profile: '', endpoint: '' }
};

function merge<T>(base: T, over: any): T {
	if (over == null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
	const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
	for (const k of Object.keys(over)) {
		out[k] = base && typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k]) ? merge((base as any)[k], over[k]) : over[k];
	}
	return out;
}

export function getSettings(db: DB = getDb()): Settings {
	const rows = db.all<{ key: string; value_json: string }>('SELECT key,value_json FROM settings');
	let s = structuredClone(DEFAULT_SETTINGS);
	for (const r of rows) s = merge(s, { [r.key]: parseJson(r.value_json, null) });
	return s;
}

export function setSettings(patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>, db: DB = getDb()): Settings {
	const cur = getSettings(db);
	db.tx(() => {
		for (const [k, v] of Object.entries(patch)) {
			const next = merge((cur as any)[k], v);
			db.run(
				`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
				k, JSON.stringify(next), now()
			);
		}
		validate(getSettings(db)); // throwing here rolls the whole change back: an invalid value is never stored
	});
	return getSettings(db);
}

function validate(s: Settings) {
	const bad = (m: string) => {
		throw new Error(`invalid setting: ${m}`);
	};
	if (s.analysis.concurrency < 1 || s.analysis.concurrency > s.analysis.maxConcurrency) bad(`analysis.concurrency must be 1..${s.analysis.maxConcurrency}`);
	if (s.media.thumbConcurrency < 1 || s.media.thumbConcurrency > 4) bad('media.thumbConcurrency must be 1..4');
	if (s.media.frameConcurrency < 1 || s.media.frameConcurrency > 4) bad('media.frameConcurrency must be 1..4');
	if (s.media.thumbWidth < 120 || s.media.thumbWidth > 1080) bad('media.thumbWidth must be 120..1080');
}
