import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../core/db.ts';
import { importSessions } from '../core/importer.ts';
import { PROVIDERS, detectProviders } from '../core/analysis/providers/index.ts';
import { batchSummary, cancelAnalysis, createBatch, estimate, runner, setBatchState } from '../core/analysis/runner.ts';
import { resolveSelection } from '../core/analysis/select.ts';
import { RESULT_JSON_SCHEMA, normaliseResult } from '../core/taxonomy.ts';
import { buildPrompt } from '../core/analysis/prompt.ts';
import { PROFILES } from '../core/analysis/profiles.ts';
import { correctLabel, correctResearch, getVideo, listVideos } from '../core/videos.ts';
import { exportResearch } from '../core/export.ts';
import { entry, isolate, makeSessions, tmp } from './helpers.ts';

isolate();

let calls = 0;
let delayMs = 0;
const GOOD = { summary: 'A 3D product spin.', categories: [{ key: 'cgi', confidence: 0.9, certainty: 'likely', evidence: [{ t: 1, frame: 2, note: 'glossy render' }] }], techniques: [{ key: 'blender_style_3d', confidence: 0.7, certainty: 'possible', evidence: [{ t: 1, frame: 2, note: 'looks like Eevee' }] }], observations: [], research: { useful: 'useful', relevance: 0.8, confidence: 0.7, explanation: 'x', relevant_for: ['rendering'], suggested_methods: [], learnable: [], analyse_further: [] }, limitations: 'stills only' };

beforeAll(async () => {
	const root = tmp();
	const files: Record<string, number> = {};
	makeSessions(root, [{ id: '2026-10-19_1000', entries: ['A', 'B', 'C', 'D', 'E'].map((c, i) => entry(c.repeat(10), { file: `videos/000${i + 1}.mp4` })), files }]);
	for (let i = 1; i <= 5; i++) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x568:r=24:d=3`, '-pix_fmt', 'yuv420p', join(root, '2026-10-19_1000', 'videos', `000${i}.mp4`)]);
	importSessions(getDb(), root, { force: true });
	PROVIDERS.fake = {
		id: 'fake',
		async detect() {
			return { id: 'fake', label: 'Fake (test double)', kind: 'cli', available: true, authenticated: true, models: [], supports: { images: true, video: false, structured: true }, detail: 'unit-test provider', verified: 'unverified', pricing: { known: true, note: '' } };
		},
		async run(req, signal) {
			calls++;
			expect(req.images.length).toBeGreaterThan(0);
			await new Promise((r, rej) => {
				const t = setTimeout(r, delayMs);
				signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('cancelled'))));
			});
			return { text: JSON.stringify(GOOD), json: GOOD, model: 'fake-1', usage: { costUsd: 0.25, ms: 5 } };
		}
	};
	await detectProviders(true);
});

const uids = () => listVideos({ limit: 50 }).videos.map((v) => v.uid);

describe('taxonomy result normalisation', () => {
	it('keeps multiple labels, caps unsupported confidence, rejects over-claims', () => {
		const { result, problems } = normaliseResult({ summary: 's', categories: [{ key: 'cgi', confidence: 0.99 }, { key: 'composited_render', confidence: 0.8, evidence: [{ note: 'x' }] }, { key: 'definitely_blender', confidence: 1 }], techniques: [{ key: 'brand_new_thing', confidence: 0.4, evidence: [{ note: 'y' }] }], observations: [{ key: 'phone_filmed_display_possible', confidence: 0.6, evidence: [{ note: 'moire' }] }], research: { useful: 'maybe' }, limitations: 'l' });
		expect(result!.categories.map((c) => c.key)).toEqual(['cgi', 'composited_render']);
		expect(result!.categories[0].confidence).toBe(0.5); // no evidence => capped
		expect(result!.techniques[0].key).toBe('custom:brand_new_thing');
		expect(result!.research.useful).toBe('uncertain');
		expect(problems.join(' ')).toMatch(/asserts certainty/);
	});
	it('refuses unusable output', () => {
		expect(normaliseResult('nope').result).toBeNull();
		expect(normaliseResult({}).result).toBeNull();
	});
	it('prompt states limits and forbids certainty about tools', () => {
		const p = buildPrompt({ uid: 'v_x', creator: 'a' }, PROFILES.quick, { workdir: '/w', frames: [{ index: 1, t: 0.5, path: '/w/f.jpg', kind: 'even' }], limitations: ['Only 1 still frame'], input: {}, cleanup() {} }, 'read-files');
		expect(p).toMatch(/Never claim to have watched the whole video/);
		expect(p).toMatch(/possible phone-filmed computer display/i);
		expect(p).toMatch(/genjutsu_like_transition/);
		expect(RESULT_JSON_SCHEMA.required).toContain('limitations');
	});
});

describe('analysis runner', () => {
	it('never runs anything without an explicit batch; estimate calls no provider', async () => {
		calls = 0;
		const est = estimate(uids().slice(0, 3), 'fake', 'quick');
		expect(est.videos).toBe(3);
		expect(est.estimatedCostUsd).toBeNull(); // nothing to calibrate from yet: honest "unknown"
		await new Promise((r) => setTimeout(r, 200));
		expect(calls).toBe(0);
	});

	it('runs a batch, stores labels + history, and skips already analysed unless reanalysing', async () => {
		const [u1, u2] = uids();
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: [u1, u2] }), { provider: 'fake', profile: 'quick' });
		await runner.drain([r.batchId]);
		const b = batchSummary(r.batchUid)!;
		expect(b.counts).toEqual({ completed: 2 });
		expect(b.status).toBe('completed');
		const v: any = getVideo(u1);
		expect(v.analysis_status).toBe('analysed');
		expect(v.labels.map((l: any) => l.key)).toEqual(expect.arrayContaining(['cgi', 'blender_style_3d']));
		await expect(createBatch(resolveSelection({ scope: 'uids', uids: [u1] }), { provider: 'fake', profile: 'quick' })).rejects.toThrow(/already analysed/);
		const again = await createBatch(resolveSelection({ scope: 'uids', uids: [u1] }), { provider: 'fake', profile: 'quick', reanalyse: true });
		await runner.drain([again.batchId]);
		expect(getDb().value('SELECT COUNT(*) FROM analyses a JOIN videos v ON v.id=a.video_id WHERE v.uid=?', u1)).toBe(2); // history kept
		// the estimate now has measured cost
		expect(estimate([uids()[3]], 'fake', 'quick').estimatedCostUsd).toBe(0.25);
	});

	it('human corrections survive reanalysis and are separate from agent output', async () => {
		const u = uids()[0];
		correctLabel(u, 'category', 'cgi', 'reject', 'wrong');
		correctLabel(u, 'category', 'tutorial', 'add');
		correctResearch(u, { useful: 'not_useful' });
		let v: any = getVideo(u);
		expect(v.labels.filter((l: any) => l.kind === 'category').map((l: any) => l.key)).toEqual(['tutorial']);
		expect(v.cur_useful).toBe('not_useful');
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: [u] }), { provider: 'fake', profile: 'quick', reanalyse: true });
		await runner.drain([r.batchId]);
		v = getVideo(u);
		expect(v.labels.some((l: any) => l.key === 'cgi')).toBe(false);
		expect(v.labels.some((l: any) => l.key === 'tutorial' && l.source === 'human')).toBe(true);
		expect(getDb().value(`SELECT COUNT(*) FROM video_labels WHERE video_id=? AND key='cgi' AND analysis_id IS NOT NULL`, v.id)).toBeGreaterThanOrEqual(3);
	});

	it('stops after N successes and leaves the rest cancelled, not silently retried', async () => {
		const un = listVideos({ analysis: 'unanalysed', limit: 10 }).videos.map((v) => v.uid);
		expect(un.length).toBe(3);
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: un }), { provider: 'fake', profile: 'quick', maxSuccess: 1, concurrency: 1 });
		await runner.drain([r.batchId]);
		const b = batchSummary(r.batchUid)!;
		expect(b.counts).toEqual({ completed: 1, cancelled: 2 });
		expect(b.note).toMatch(/limit 1/);
	});

	it('enforces a cost ceiling and refuses one for providers without prices', async () => {
		const un = listVideos({ analysis: 'unanalysed', limit: 10 }).videos.map((v) => v.uid);
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: un }), { provider: 'fake', profile: 'quick', maxCostUsd: 0.25 });
		await runner.drain([r.batchId]);
		expect(batchSummary(r.batchUid)!.counts).toEqual({ completed: 1, cancelled: 1 });
		const orig = PROVIDERS.fake.detect;
		PROVIDERS.fake.detect = async () => ({ ...(await orig()), pricing: { known: false, note: '' } });
		await detectProviders(true);
		await expect(createBatch(resolveSelection({ scope: 'uids', uids: uids() }), { provider: 'fake', profile: 'quick', maxCostUsd: 1, reanalyse: true })).rejects.toThrow(/cost limit cannot be enforced/);
		PROVIDERS.fake.detect = orig;
		await detectProviders(true);
	});

	it('cancels a running analysis and a whole batch; pause stops dispatching', async () => {
		delayMs = 4000;
		const v = uids().slice(0, 3);
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: v }), { provider: 'fake', profile: 'quick', reanalyse: true, concurrency: 1 });
		await new Promise((res) => setTimeout(res, 1500));
		expect(batchSummary(r.batchUid)!.counts.running ?? 0).toBeGreaterThanOrEqual(1);
		setBatchState(r.batchUid, 'paused');
		const run = getDb().get<any>(`SELECT uid FROM analyses WHERE batch_id=? AND status IN ('running','preparing')`, r.batchId)!;
		cancelAnalysis(run.uid);
		await new Promise((res) => setTimeout(res, 1500));
		const c = batchSummary(r.batchUid)!.counts as any;
		expect(c.cancelled).toBe(1);
		expect(c.queued).toBe(2); // paused: nothing new started
		setBatchState(r.batchUid, 'cancelled');
		expect(batchSummary(r.batchUid)!.counts).toEqual({ cancelled: 3 });
		expect(getDb().value(`SELECT COUNT(*) FROM videos WHERE analysis_status IN ('queued','running')`)).toBe(0);
		delayMs = 0;
	});

	it('index profile (Level 0) calls no provider and does not count as analysed', async () => {
		calls = 0;
		const u = listVideos({ analysis: 'unanalysed', limit: 1 }).videos[0].uid;
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: [u] }), { provider: 'none', profile: 'index' });
		await runner.drain([r.batchId]);
		expect(calls).toBe(0);
		expect((getVideo(u) as any).analysis_status).toBe('none');
	});

	it('recovers analyses orphaned by a dead runner as failed, not retried', () => {
		const db = getDb();
		const vid = db.value<number>('SELECT id FROM videos LIMIT 1')!;
		db.run(`INSERT INTO analyses(uid,video_id,provider,profile,schema_version,prompt_version,status,created_at,claimed_by) VALUES ('a_orphan',?,'fake','quick','x','x','running','x','somehost:1')`, vid);
		runner.recoverStale(db);
		expect(db.get<any>(`SELECT status,error FROM analyses WHERE uid='a_orphan'`)).toMatchObject({ status: 'failed' });
	});

	it('exports structured research in all formats', () => {
		const j = JSON.parse(exportResearch(getDb(), { format: 'json' }));
		expect(j.count).toBeGreaterThan(0);
		expect(j.records[0].analysis.result.categories.length).toBeGreaterThan(0);
		expect(exportResearch(getDb(), { format: 'csv' }).split('\n')[0]).toMatch(/^uid,/);
		expect(exportResearch(getDb(), { format: 'jsonl' }).trim().split('\n').length).toBe(j.count);
	});
});
