import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmp(prefix = 'vie-test-') {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a Python-collector-shaped sessions directory. */
export function makeSessions(root: string, spec: Array<{ id: string; info?: any; entries: any[]; files?: Record<string, number> }>) {
	for (const s of spec) {
		const d = join(root, s.id);
		mkdirSync(join(d, 'videos'), { recursive: true });
		writeFileSync(join(d, 'session.json'), JSON.stringify({ schema: 1, id: s.id, status: 'completed', started_at: '2026-10-19T10:00:00+11:00', ended_at: '2026-10-19T10:05:00+11:00', mode: 'fast', ...s.info }));
		writeFileSync(join(d, 'metadata.json'), JSON.stringify({ schema: 1, session: s.id, videos: s.entries }));
		for (const [f, size] of Object.entries(s.files ?? {})) writeFileSync(join(d, 'videos', f), Buffer.alloc(size, 7));
	}
}

export const entry = (id: string, over: any = {}) => ({
	id, url: `https://www.instagram.com/reel/${id}/`, creator: 'someone', caption: `caption #tag${id}`, status: 'downloaded', file: 'videos/0001.mp4',
	bytes: 100, sha256: id.padEnd(64, 'a').slice(0, 64), source: { kind: 'reels_feed' }, discovered_at: '2026-10-19T10:00:01+11:00', downloaded_at: '2026-10-19T10:00:05+11:00',
	probe: { duration_s: 10, width: 1080, height: 1920, fps: 30, video_codec: 'h264', has_audio: true }, ...over
});

/** Every test file gets its own database + data directory (call at module top level). */
export function isolate() {
	const d = tmp('vie-iso-');
	process.env.VIE_DATA_DIR = d;
	process.env.VIE_DB_PATH = join(d, 'vie.sqlite');
	process.env.VIE_CONFIG = join(d, 'config.toml');
}
