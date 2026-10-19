// Turns a video into the exact evidence an image-capable agent can be given, and states honestly what that evidence
// cannot show. No AI here: ffprobe, ffmpeg seeks and a scene-score pass, all CPU, all bounded.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../paths.ts';
import { contactSheet, detectShots, evenTimes, extractFrames, type FrameRef } from '../media.ts';
import type { Profile } from './types.ts';

export interface Prepared {
	workdir: string;
	frames: Array<{ index: number; t: number; path: string; kind: 'even' | 'shot' | 'burst' }>;
	sheet?: { path: string; cols: number; rows: number; index: Array<{ cell: number; row: number; col: number; t: number }> };
	shots?: Array<{ start: number; end: number }>;
	limitations: string[];
	input: Record<string, any>;
	cleanup(): void;
}

export async function prepareEvidence(
	video: { uid: string; abs: string; duration_s: number | null; width?: number | null; height?: number | null },
	profile: Profile,
	signal?: AbortSignal
): Promise<Prepared> {
	const dur = video.duration_s ?? 0;
	const workdir = join(tmpDir(), `analysis-${video.uid}-${process.pid}-${Date.now()}`);
	mkdirSync(workdir, { recursive: true });
	const planned: Array<{ t: number; kind: 'even' | 'shot' | 'burst' }> = evenTimes(dur, profile.frames).map((t) => ({ t, kind: 'even' }));

	let shots: Prepared['shots'];
	if (profile.shots) {
		const s = await detectShots({ uid: video.uid, abs: video.abs, duration_s: video.duration_s }, 0.3, signal);
		shots = s.shots;
		if (profile.perShotFrames && shots.length > 1) {
			const longest = [...shots].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, profile.perShotFrames);
			for (const sh of longest) planned.push({ t: (sh.start + sh.end) / 2, kind: 'shot' });
			if (profile.burstFrames && s.cuts.length) {
				const cut = s.cuts[Math.floor(s.cuts.length / 2)];
				for (let i = 0; i < profile.burstFrames; i++) planned.push({ t: Math.max(0, cut - 0.1 + i * 0.1), kind: 'burst' });
			}
		}
	}
	// de-duplicate near-identical timestamps, keep chronological order (agents cite frame numbers)
	const uniq: typeof planned = [];
	for (const p of planned.sort((a, b) => a.t - b.t)) if (!uniq.length || p.t - uniq[uniq.length - 1].t > 0.04) uniq.push(p);

	const refs: FrameRef[] = await extractFrames(video, uniq.map((u) => u.t), profile.frameWidth, signal);
	const frames = refs.map((r, i) => {
		const name = `frame_${String(i + 1).padStart(2, '0')}_t${r.t.toFixed(2)}s.jpg`;
		const dest = join(workdir, name);
		copyFileSync(r.path, dest);
		return { index: i + 1, t: r.t, path: dest, kind: uniq.find((u) => Math.abs(u.t - r.t) < 0.05)?.kind ?? 'even' };
	});
	let sheet: Prepared['sheet'];
	if (profile.contactSheet && refs.length >= 4) {
		const cs = await contactSheet(video, refs.slice(0, 16), 4, 320, signal);
		if (cs) {
			const dest = join(workdir, 'contact_sheet.jpg');
			copyFileSync(cs.path, dest);
			sheet = { ...cs, path: dest };
		}
	}

	const limitations = [
		`Only ${frames.length} still frame(s) from a ${dur ? dur.toFixed(1) + 's' : 'unknown-length'} video were inspected; no audio was heard and continuous motion between frames was not observed.`,
		'Camera moves, timing, easing, rolling shutter and temporal artefacts can only be inferred from differences between frames.'
	];
	if (!shots) limitations.push('No shot-boundary detection was run for this profile.');
	if (shots && shots.length) limitations.push(`Shot boundaries come from an automatic scene-change score (${shots.length} shot(s)); soft transitions and match cuts may be missed.`);

	return {
		workdir, frames, sheet, shots, limitations,
		input: { profile: profile.id, frames: frames.map((f) => ({ index: f.index, t: f.t, kind: f.kind })), contact_sheet: !!sheet, shots: shots?.length ?? null, duration_s: dur },
		cleanup: () => rmSync(workdir, { recursive: true, force: true })
	};
}
