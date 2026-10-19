// Lightweight media preparation: ffprobe, thumbnails, representative frames, shot boundaries, contact sheets,
// optional low-res proxies. CPU only, niced, one video decoded at a time per semaphore, nothing held in RAM.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, framesDir, thumbsDir, tmpDir } from './paths.ts';
import { run, Semaphore } from './exec.ts';
import type { DB } from './db.ts';
import { getDb, now } from './db.ts';
import { getSettings } from './settings.ts';

const thumbSem = new Semaphore(1);
const frameSem = new Semaphore(1);

export function applyMediaLimits(db: DB = getDb()) {
	const s = getSettings(db).media;
	thumbSem.limit = s.thumbConcurrency;
	frameSem.limit = s.frameConcurrency;
}

export interface ProbeSummary {
	duration_s: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	video_codec: string | null;
	audio_codec: string | null;
	has_audio: boolean;
	bit_rate: number | null;
	size: number | null;
	rotation: number | null;
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbeSummary> {
	const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60_000, signal, nice: 10 });
	if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.slice(0, 300)}`);
	const j = JSON.parse(r.stdout);
	const v = j.streams?.find((s: any) => s.codec_type === 'video');
	const a = j.streams?.find((s: any) => s.codec_type === 'audio');
	if (!v) throw new Error('no video stream');
	const [n, d] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
	return {
		duration_s: Number(j.format?.duration ?? v.duration) || null,
		width: v.width ?? null,
		height: v.height ?? null,
		fps: d ? Math.round((n / d) * 1000) / 1000 : null,
		video_codec: v.codec_name ?? null,
		audio_codec: a?.codec_name ?? null,
		has_audio: !!a,
		bit_rate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
		size: j.format?.size ? Number(j.format.size) : null,
		rotation: v.side_data_list?.find((x: any) => x.rotation != null)?.rotation ?? null
	};
}

const FF = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1'];

export function thumbFile(uid: string) {
	return join(thumbsDir(), `${uid}.jpg`);
}

/** One small JPEG per video, taken ~10% in (skips black leader frames). Idempotent; atomic rename. */
export async function ensureThumbnail(db: DB, video: { id: number; uid: string; abs: string; duration_s: number | null }, signal?: AbortSignal): Promise<string | null> {
	const out = thumbFile(video.uid);
	if (existsSync(out) && statSync(out).size > 0) {
		db.run('UPDATE videos SET thumb_path=? WHERE id=? AND thumb_path IS NULL', out, video.id);
		return out;
	}
	if (!existsSync(video.abs)) return null;
	const s = getSettings(db).media;
	const at = Math.max(0, Math.min((video.duration_s ?? 2) * 0.1, 3));
	return thumbSem.with(async () => {
		const tmp = `${out}.${process.pid}.tmp.jpg`;
		const r = await run('ffmpeg', [...FF, '-y', '-ss', at.toFixed(2), '-i', video.abs, '-frames:v', '1', '-vf', `scale=${s.thumbWidth}:-2:flags=bilinear`, '-q:v', '4', tmp], {
			timeoutMs: 45_000, signal, nice: s.niceLevel
		});
		if (r.code !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
			rmSync(tmp, { force: true });
			return null;
		}
		renameSync(tmp, out);
		db.run('UPDATE videos SET thumb_path=?, updated_at=? WHERE id=?', out, now(), video.id);
		return out;
	});
}

export interface FrameRef {
	index: number;
	t: number;
	path: string;
	width: number;
}

const key = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);

/** Frames at explicit timestamps (seconds). Cached by (video, t, width). Each is a fast seek: no full decode. */
export async function extractFrames(video: { uid: string; abs: string }, times: number[], width = 768, signal?: AbortSignal): Promise<FrameRef[]> {
	const dir = join(framesDir(), video.uid);
	mkdirSync(dir, { recursive: true });
	const refs: FrameRef[] = [];
	let i = 0;
	for (const t of times) {
		i++;
		const path = join(dir, `f${key([t.toFixed(2), width])}.jpg`);
		if (!existsSync(path)) {
			await frameSem.with(async () => {
				const tmp = `${path}.${process.pid}.tmp.jpg`;
				const r = await run('ffmpeg', [...FF, '-y', '-ss', Math.max(0, t).toFixed(3), '-i', video.abs, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', tmp], {
					timeoutMs: 60_000, signal, nice: 15
				});
				if (r.code === 0 && existsSync(tmp)) renameSync(tmp, path);
				else rmSync(tmp, { force: true });
			});
		}
		if (existsSync(path)) refs.push({ index: i, t: Math.round(t * 1000) / 1000, path, width });
	}
	return refs;
}

export const evenTimes = (duration: number, n: number) => {
	if (!duration || n <= 0) return [0];
	return Array.from({ length: n }, (_, i) => Math.min(duration - 0.05, ((i + 0.5) / n) * duration)).map((x) => Math.max(0, x));
};

/** Scene cuts via ffmpeg's scene score on a heavily downscaled stream. Full pass, CPU only, cached as JSON. */
export async function detectShots(video: { uid: string; abs: string; duration_s: number | null }, threshold = 0.3, signal?: AbortSignal): Promise<{ cuts: number[]; shots: Array<{ start: number; end: number }>; threshold: number }> {
	const cache = join(cacheDir(), 'shots');
	mkdirSync(cache, { recursive: true });
	const cp = join(cache, `${video.uid}-${threshold}.json`);
	if (existsSync(cp)) return JSON.parse(readFileSync(cp, 'utf8'));
	const r = await frameSem.with(() =>
		run('ffmpeg', [...FF, '-i', video.abs, '-vf', `scale=160:-2:flags=fast_bilinear,select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], {
			timeoutMs: 180_000, signal, nice: 15, maxOutput: 2_000_000
		})
	);
	const cuts = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000) / 1000);
	const dur = video.duration_s ?? (cuts.at(-1) ?? 0);
	const bounds = [0, ...cuts, dur];
	const shots = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] })).filter((s) => s.end > s.start);
	const res = { cuts, shots, threshold };
	writeFileSync(cp, JSON.stringify(res));
	return res;
}

/** Contact sheet (grid) of frames; the cell -> timestamp index is returned so an agent can cite times. */
export async function contactSheet(video: { uid: string; abs: string }, frames: FrameRef[], cols = 4, cell = 320, signal?: AbortSignal) {
	if (!frames.length) return null;
	const dir = join(cacheDir(), 'sheets');
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${video.uid}-${key(frames.map((f) => f.path))}.jpg`);
	const index = frames.map((f, i) => ({ cell: i + 1, row: Math.floor(i / cols) + 1, col: (i % cols) + 1, t: f.t }));
	if (existsSync(out)) return { path: out, cols, rows: Math.ceil(frames.length / cols), index };
	const list = join(tmpDir(), `${video.uid}-${process.pid}.txt`);
	writeFileSync(list, frames.map((f) => `file '${f.path.replace(/'/g, "'\\''")}'\nduration 1`).join('\n') + `\nfile '${frames.at(-1)!.path.replace(/'/g, "'\\''")}'\n`);
	const rows = Math.ceil(frames.length / cols);
	const r = await frameSem.with(() =>
		run('ffmpeg', [...FF, '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${cell}:-2,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', out], {
			timeoutMs: 60_000, signal, nice: 15
		})
	);
	rmSync(list, { force: true });
	if (r.code !== 0 || !existsSync(out)) return null;
	return { path: out, cols, rows, index };
}

/** Optional low-res proxy for agents/providers that accept a video file. Cached; only built on request. */
export async function makeProxy(video: { uid: string; abs: string }, height = 480, signal?: AbortSignal): Promise<string | null> {
	const dir = join(cacheDir(), 'proxies');
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${video.uid}-${height}.mp4`);
	if (existsSync(out)) return out;
	const tmp = `${out}.${process.pid}.tmp.mp4`;
	const r = await frameSem.with(() =>
		run('ffmpeg', [...FF, '-y', '-threads', '2', '-i', video.abs, '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', tmp], {
			timeoutMs: 300_000, signal, nice: 15
		})
	);
	if (r.code !== 0 || !existsSync(tmp)) {
		rmSync(tmp, { force: true });
		return null;
	}
	renameSync(tmp, out);
	return out;
}

export interface CacheStats {
	dir: string;
	bytes: number;
	files: number;
	parts: Record<string, { bytes: number; files: number }>;
}

function walk(d: string, fn: (p: string, st: Stats) => void) {
	if (!existsSync(d)) return;
	for (const e of readdirSync(d, { withFileTypes: true })) {
		const p = join(d, e.name);
		if (e.isDirectory()) walk(p, fn);
		else {
			try {
				fn(p, statSync(p));
			} catch {
				/* vanished */
			}
		}
	}
}

export function cacheStats(): CacheStats {
	const base = cacheDir();
	const parts: CacheStats['parts'] = {};
	let bytes = 0;
	let files = 0;
	walk(base, (p, st) => {
		const part = p.slice(base.length + 1).split('/')[0];
		parts[part] ??= { bytes: 0, files: 0 };
		parts[part].bytes += st.size;
		parts[part].files++;
		bytes += st.size;
		files++;
	});
	return { dir: base, bytes, files, parts };
}

/** Delete cache files older than maxAge, then oldest-first until under maxBytes. Returns what was removed. */
export function pruneCache(maxBytes: number, maxAgeMs: number, dryRun = false) {
	const all: Array<{ p: string; size: number; at: number }> = [];
	walk(cacheDir(), (p, st) => all.push({ p, size: st.size, at: st.atimeMs > st.mtimeMs ? st.atimeMs : st.mtimeMs }));
	const doomed = new Set<string>();
	const cutoff = Date.now() - maxAgeMs;
	for (const f of all) if (f.at < cutoff) doomed.add(f.p);
	let total = all.filter((f) => !doomed.has(f.p)).reduce((a, f) => a + f.size, 0);
	for (const f of all.sort((a, b) => a.at - b.at)) {
		if (total <= maxBytes) break;
		if (!doomed.has(f.p)) (doomed.add(f.p), (total -= f.size));
	}
	const removed = all.filter((f) => doomed.has(f.p));
	if (!dryRun) for (const f of removed) rmSync(f.p, { force: true });
	return { files: removed.length, bytes: removed.reduce((a, f) => a + f.size, 0), paths: removed.slice(0, 50).map((f) => f.p), dryRun };
}

/** Background thumbnail queue: bounded, restartable (state = presence of the JPEG), zero cost when empty. */
let thumbJob: { running: boolean; done: number; total: number; failed: number; cancel: boolean } = { running: false, done: 0, total: 0, failed: 0, cancel: false };
export const thumbProgress = () => ({ ...thumbJob });
export function cancelThumbs() {
	thumbJob.cancel = true;
}

export async function generateMissingThumbnails(db: DB, resolveAbs: (v: any) => string | null, limit = 100000) {
	if (thumbJob.running) return thumbProgress();
	applyMediaLimits(db);
	const rows = db.all<any>(`SELECT v.id,v.uid,v.duration_s,v.root_id,v.rel_path FROM videos v WHERE v.download_status='downloaded' AND v.file_missing=0 ORDER BY v.id DESC LIMIT ?`, limit)
		.filter((v) => !existsSync(thumbFile(v.uid)));
	thumbJob = { running: true, done: 0, total: rows.length, failed: 0, cancel: false };
	(async () => {
		for (const v of rows) {
			if (thumbJob.cancel) break;
			const abs = resolveAbs(v);
			const ok = abs ? await ensureThumbnail(db, { ...v, abs }) : null;
			ok ? thumbJob.done++ : thumbJob.failed++;
		}
		thumbJob.running = false;
	})().catch(() => (thumbJob.running = false));
	return thumbProgress();
}
