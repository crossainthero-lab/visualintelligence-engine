// Analysis orchestration. Nothing here runs unless a person (dashboard, CLI or MCP client) explicitly created a batch.
// Bounded concurrency, hard timeouts, cancellable, no automatic retries (a retry is a new explicit request).
import { hostname } from 'node:os';
import type { DB } from '../db.ts';
import { getDb, now } from '../db.ts';
import { getSettings } from '../settings.ts';
import { RESULT_JSON_SCHEMA, TAXONOMY_VERSION, normaliseResult } from '../taxonomy.ts';
import { absPath, rebuildCurrent } from '../videos.ts';
import { ensureThumbnail, probe } from '../media.ts';
import { parseJson, uid } from '../util.ts';
import { getProfile } from './profiles.ts';
import { prepareEvidence } from './prepare.ts';
import { PROMPT_VERSION, buildPrompt } from './prompt.ts';
import { getProvider, detectProviders } from './providers/index.ts';

const WHO = `${hostname()}:${process.pid}`;

export interface Selection {
	uids: string[];
	description: string; // human-readable: "next 10 unanalysed", "session 2026-10-19_2122", ...
}
export interface BatchOptions {
	provider: string;
	profile: string;
	model?: string;
	concurrency?: number;
	maxSuccess?: number;
	maxCostUsd?: number;
	reanalyse?: boolean;
	note?: string;
	startNow?: boolean;
}

export function estimate(uids: string[], provider: string, profileId: string, db: DB = getDb()) {
	const profile = getProfile(profileId);
	const hist = db.get<any>(
		`SELECT COUNT(*) n, AVG(json_extract(usage_json,'$.costUsd')) cost, AVG(json_extract(usage_json,'$.ms')) ms, AVG(json_extract(usage_json,'$.inputTokens')) tok
		 FROM analyses WHERE provider=? AND profile=? AND status='completed'`, provider, profileId);
	const eligible = db.all<{ uid: string; analysis_status: string }>(
		`SELECT uid, analysis_status FROM videos WHERE uid IN (${uids.map(() => '?').join(',') || "''"}) AND download_status='downloaded' AND file_missing=0`, ...uids);
	const n = eligible.length;
	return {
		videos: n, skipped: uids.length - n, alreadyAnalysed: eligible.filter((e) => e.analysis_status === 'analysed').length,
		framesPerVideo: profile.frames + profile.perShotFrames + profile.burstFrames + (profile.contactSheet ? 1 : 0),
		providerCalls: profile.usesProvider ? n : 0,
		basedOnPastRuns: hist?.n ?? 0,
		estimatedCostUsd: profile.usesProvider && hist?.cost != null ? Math.round(hist.cost * n * 1000) / 1000 : null,
		estimatedSeconds: profile.usesProvider && hist?.ms != null ? Math.round((hist.ms / 1000) * n) : null,
		note: !profile.usesProvider ? 'Local only: no AI provider is called.' : hist?.n ? `Estimate = average of ${hist.n} earlier completed run(s) with this provider and profile (measured, not list-price).` : 'No earlier runs with this provider and profile, so cost and time are unknown. Run one video first to calibrate.'
	};
}

export async function createBatch(sel: Selection, o: BatchOptions, db: DB = getDb()) {
	const profile = getProfile(o.profile);
	const settings = getSettings(db);
	if (profile.usesProvider) {
		const info = (await detectProviders()).find((p) => p.id === o.provider);
		if (!info) throw new Error(`unknown provider "${o.provider}"`);
		if (!info.available) throw new Error(`provider "${o.provider}" is not available: ${info.detail}`);
		if (o.maxCostUsd != null && !(info.pricing?.known)) throw new Error(`provider "${o.provider}" does not report prices, so a cost limit cannot be enforced; use maxSuccess instead`);
	}
	const concurrency = Math.min(Math.max(o.concurrency ?? settings.analysis.concurrency, 1), settings.analysis.maxConcurrency);
	const rows = db.all<any>(`SELECT id,uid,analysis_status,download_status,file_missing FROM videos WHERE uid IN (${sel.uids.map(() => '?').join(',') || "''"})`, ...sel.uids);
	const skipped: Array<{ uid: string; reason: string }> = [];
	const ok: any[] = [];
	const seen = new Set(rows.map((r) => r.uid));
	for (const u of sel.uids) if (!seen.has(u)) skipped.push({ uid: u, reason: 'unknown video' });
	for (const r of rows) {
		if (r.download_status !== 'downloaded' || r.file_missing) skipped.push({ uid: r.uid, reason: 'no media file' });
		else if (!o.reanalyse && profile.usesProvider && r.analysis_status === 'analysed') skipped.push({ uid: r.uid, reason: 'already analysed (use reanalyse)' });
		else if (profile.usesProvider && ['queued', 'running'].includes(r.analysis_status)) skipped.push({ uid: r.uid, reason: 'analysis already in progress' });
		else ok.push(r);
	}
	if (!ok.length) throw new Error(`nothing to analyse (${skipped.length} skipped${skipped[0] ? ': ' + skipped[0].reason : ''})`);
	const batchUid = uid('b');
	const t = now();
	const batchId = db.tx(() => {
		db.run(
			`INSERT INTO analysis_batches(uid,created_at,provider,model,profile,selection_json,concurrency,max_success,max_cost_usd,status,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
			batchUid, t, o.provider, o.model ?? null, o.profile, JSON.stringify({ description: sel.description, count: ok.length, skipped: skipped.length }), concurrency, o.maxSuccess ?? null, o.maxCostUsd ?? null, o.startNow === false ? 'queued' : 'running', o.note ?? null);
		const bid = db.value<number>('SELECT id FROM analysis_batches WHERE uid=?', batchUid)!;
		for (const r of ok) {
			db.run(`INSERT INTO analyses(uid,video_id,batch_id,provider,model,profile,schema_version,prompt_version,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
				uid('a'), r.id, bid, o.provider, o.model ?? null, o.profile, TAXONOMY_VERSION, PROMPT_VERSION, 'queued', t);
			if (profile.usesProvider) db.run(`UPDATE videos SET analysis_status='queued' WHERE id=?`, r.id);
		}
		return bid;
	});
	if (o.startNow !== false) runner.kick();
	return { batchId, batchUid, queued: ok.length, skipped };
}

export function batchSummary(batchUid: string, db: DB = getDb()) {
	const b = db.get<any>('SELECT * FROM analysis_batches WHERE uid=?', batchUid);
	if (!b) return null;
	const counts = Object.fromEntries(db.all<any>('SELECT status, COUNT(*) n FROM analyses WHERE batch_id=? GROUP BY status', b.id).map((r) => [r.status, r.n]));
	const cost = db.value<number>(`SELECT COALESCE(SUM(json_extract(usage_json,'$.costUsd')),0) FROM analyses WHERE batch_id=?`, b.id) ?? 0;
	return { ...b, selection: parseJson(b.selection_json, {}), selection_json: undefined, counts, costUsd: cost };
}

export function listBatches(limit = 30, db: DB = getDb()) {
	return db.all<any>('SELECT uid FROM analysis_batches ORDER BY id DESC LIMIT ?', limit).map((r) => batchSummary(r.uid, db));
}

export function setBatchState(batchUid: string, state: 'running' | 'paused' | 'cancelled', db: DB = getDb()) {
	const b = db.get<any>('SELECT id,status FROM analysis_batches WHERE uid=?', batchUid);
	if (!b) throw new Error('unknown batch');
	if (['completed', 'cancelled'].includes(b.status)) throw new Error(`batch already ${b.status}`);
	db.tx(() => {
		db.run('UPDATE analysis_batches SET status=? WHERE id=?', state, b.id);
		if (state === 'cancelled') {
			db.run(`UPDATE analyses SET status='cancelled', error='cancelled before start', completed_at=? WHERE batch_id=? AND status='queued'`, now(), b.id);
			resetQueuedFlags(db);
		}
	});
	if (state === 'cancelled') runner.abortBatch(b.id);
	if (state === 'running') runner.kick();
}

export function cancelAnalysis(analysisUid: string, db: DB = getDb()) {
	const a = db.get<any>('SELECT id,status,video_id FROM analyses WHERE uid=?', analysisUid);
	if (!a) throw new Error('unknown analysis');
	if (a.status === 'queued') db.run(`UPDATE analyses SET status='cancelled', error='cancelled before start', completed_at=? WHERE id=?`, now(), a.id);
	else if (['preparing', 'running'].includes(a.status)) runner.abort(a.id);
	else throw new Error(`analysis already ${a.status}`);
	resetQueuedFlags(db);
}

/** A manual retry is a NEW analysis row linked to the failed one; it never happens automatically. */
export async function retryAnalysis(analysisUid: string, db: DB = getDb()) {
	const a = db.get<any>('SELECT * FROM analyses WHERE uid=?', analysisUid);
	if (!a) throw new Error('unknown analysis');
	if (!['failed', 'cancelled'].includes(a.status)) throw new Error(`only failed/cancelled analyses can be retried (this one is ${a.status})`);
	const v = db.get<any>('SELECT uid FROM videos WHERE id=?', a.video_id)!;
	const r = await createBatch({ uids: [v.uid], description: `retry of ${analysisUid}` }, { provider: a.provider, profile: a.profile, model: a.model ?? undefined, reanalyse: true });
	db.run('UPDATE analyses SET retry_of=?, retries=? WHERE batch_id=?', a.id, (a.retries ?? 0) + 1, r.batchId);
	return r;
}

function resetQueuedFlags(db: DB) {
	db.run(`UPDATE videos SET analysis_status = CASE WHEN current_analysis_id IS NOT NULL THEN 'analysed' ELSE 'none' END
		WHERE analysis_status='queued' AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.video_id=videos.id AND a.status IN ('queued','preparing','running'))`);
}

// ---------------------------------------------------------------------------------------------------------------

class AnalysisRunner {
	private active = new Map<number, AbortController>();
	private timer: NodeJS.Timeout | null = null;
	private db: DB | null = null;
	private pumping = false;

	/** Start the idle watcher (server mode). A 15 s cheap query; the process is otherwise idle. */
	watch(db: DB = getDb()) {
		this.db = db;
		this.recoverStale(db);
		if (!this.timer) {
			this.timer = setInterval(() => this.kick(), 15_000);
			this.timer.unref();
		}
		this.kick();
	}
	stopWatching() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Analyses claimed by a runner process that no longer exists become failed (never silently retried). */
	recoverStale(db: DB) {
		for (const a of db.all<any>(`SELECT id, claimed_by FROM analyses WHERE status IN ('preparing','running')`)) {
			const [host, pid] = String(a.claimed_by ?? '').split(':');
			let alive = false;
			if (host === hostname() && pid) {
				try {
					process.kill(Number(pid), 0);
					alive = Number(pid) === process.pid ? this.active.has(a.id) : true;
				} catch {
					alive = false;
				}
			}
			if (!alive) db.run(`UPDATE analyses SET status='failed', error='interrupted: the runner process ended before this finished (not retried automatically)', completed_at=? WHERE id=?`, now(), a.id);
		}
		resetQueuedFlags(db);
	}

	abort(id: number) {
		this.active.get(id)?.abort();
	}
	abortBatch(batchId: number) {
		const db = this.db ?? getDb();
		for (const a of db.all<any>(`SELECT id FROM analyses WHERE batch_id=? AND status IN ('preparing','running')`, batchId)) this.active.get(a.id)?.abort();
	}

	kick() {
		queueMicrotask(() => void this.pump());
	}

	private async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			const db = this.db ?? getDb();
			const s = getSettings(db).analysis;
			// adopt batches that were queued by another process (CLI --queue-only) once a runner is watching
			if (this.timer) db.run(`UPDATE analysis_batches SET status='running', started_at=COALESCE(started_at,?) WHERE status='queued'`, now());
			while (this.active.size < s.maxConcurrency) {
				const row = db.get<any>(
					`SELECT a.id FROM analyses a JOIN analysis_batches b ON b.id=a.batch_id
					 WHERE a.status='queued' AND b.status='running'
					   AND (SELECT COUNT(*) FROM analyses x WHERE x.batch_id=a.batch_id AND x.status IN ('preparing','running')) < b.concurrency
					 ORDER BY a.id LIMIT 1`);
				if (!row) break;
				const claimed = db.run(`UPDATE analyses SET status='preparing', claimed_by=?, heartbeat_at=?, started_at=? WHERE id=? AND status='queued'`, WHO, now(), now(), row.id);
				if (Number(claimed.changes) !== 1) continue;
				const ac = new AbortController();
				this.active.set(row.id, ac);
				void this.execute(db, row.id, ac).finally(() => {
					this.active.delete(row.id);
					this.kick();
				});
			}
		} finally {
			this.pumping = false;
		}
	}

	/** Resolves when nothing is queued or running for these batches (foreground CLI use). */
	async drain(batchIds: number[], onTick?: () => void) {
		const db = this.db ?? getDb();
		for (;;) {
			this.kick();
			const left = db.value<number>(`SELECT COUNT(*) FROM analyses WHERE batch_id IN (${batchIds.join(',')}) AND status IN ('queued','preparing','running')`) ?? 0;
			const paused = db.value<number>(`SELECT COUNT(*) FROM analysis_batches WHERE id IN (${batchIds.join(',')}) AND status='paused'`) ?? 0;
			onTick?.();
			if (left === 0 || (paused && this.active.size === 0 && !db.value(`SELECT 1 FROM analysis_batches WHERE id IN (${batchIds.join(',')}) AND status='running'`))) return;
			await new Promise((r) => setTimeout(r, 700));
		}
	}

	private async execute(db: DB, id: number, ac: AbortController) {
		const a = db.get<any>('SELECT * FROM analyses WHERE id=?', id)!;
		const v = db.get<any>(`SELECT v.*, c.username AS creator FROM videos v LEFT JOIN creators c ON c.id=v.creator_id WHERE v.id=?`, a.video_id)!;
		const profile = getProfile(a.profile);
		const abs = absPath(db, v);
		let prep: Awaited<ReturnType<typeof prepareEvidence>> | null = null;
		// Poll the DB so a cancel from another process (dashboard/CLI/MCP) reaches this runner.
		const watchdog = setInterval(() => {
			db.run('UPDATE analyses SET heartbeat_at=? WHERE id=?', now(), id);
			const st = db.value<string>('SELECT b.status FROM analysis_batches b WHERE b.id=?', a.batch_id);
			if (st === 'cancelled') ac.abort();
		}, 2000);
		const finish = (status: string, fields: Record<string, any> = {}) => {
			const cols = Object.keys(fields);
			db.run(`UPDATE analyses SET status=?, completed_at=?${cols.map((c) => `, ${c}=?`).join('')} WHERE id=?`, status, now(), ...cols.map((c) => fields[c]), id);
		};
		try {
			if (!abs) throw new Error('video file path unknown');
			if (!profile.usesProvider) {
				const p = await probe(abs, ac.signal);
				db.run('UPDATE videos SET duration_s=COALESCE(duration_s,?),width=COALESCE(width,?),height=COALESCE(height,?),fps=COALESCE(fps,?),video_codec=COALESCE(video_codec,?),audio_codec=COALESCE(audio_codec,?),has_audio=COALESCE(has_audio,?),file_size=COALESCE(file_size,?) WHERE id=?',
					p.duration_s, p.width, p.height, p.fps, p.video_codec, p.audio_codec, p.has_audio ? 1 : 0, p.size, v.id);
				await ensureThumbnail(db, { id: v.id, uid: v.uid, abs, duration_s: p.duration_s });
				finish('completed', { result_json: JSON.stringify({ level: 0, facts: p }), summary: 'Index only (no AI)', input_json: JSON.stringify({ profile: 'index' }), usage_json: JSON.stringify({ ms: 0, costUsd: 0 }) });
				return;
			}
			db.run(`UPDATE videos SET analysis_status='running' WHERE id=?`, v.id);
			const provider = getProvider(a.provider);
			const info = (await detectProviders()).find((p) => p.id === a.provider);
			if (!info?.available) throw new Error(`provider ${a.provider} is not available: ${info?.detail}`);
			prep = await prepareEvidence({ uid: v.uid, abs, duration_s: v.duration_s, width: v.width, height: v.height }, profile, ac.signal);
			if (ac.signal.aborted) throw new Error('cancelled');
			if (!prep.frames.length) throw new Error('could not extract any frames from the video file');
			db.run(`UPDATE analyses SET status='running', input_json=? WHERE id=?`, JSON.stringify(prep.input), id);
			const readMode = a.provider === 'claude' || a.provider === 'antigravity' ? 'read-files' : 'attached';
			const prompt = buildPrompt({ ...v, source_kind: v.source_kind, has_audio: v.has_audio == null ? null : !!v.has_audio }, profile, prep, readMode);
			const images = [...(prep.sheet ? [prep.sheet.path] : []), ...prep.frames.map((f) => f.path)];
			const settings = getSettings(db).analysis.providers[a.provider];
			const resp = await provider.run(
				{ prompt: prep.sheet && readMode === 'attached' ? prompt.replace('contact sheet', 'contact sheet (attached FIRST, before frame 1)') : prompt, images, schema: RESULT_JSON_SCHEMA, model: a.model || undefined, timeoutMs: (settings?.timeoutS ?? profile.timeoutS) * 1000, workdir: prep.workdir },
				ac.signal
			);
			if (ac.signal.aborted) throw new Error('cancelled');
			const { result, problems } = normaliseResult(resp.json);
			if (!result) {
				finish('failed', { raw_output: resp.text.slice(0, 20000), error: `agent output was not usable: ${problems.join('; ')}`, model: resp.model ?? a.model, usage_json: JSON.stringify(resp.usage) });
				this.afterOutcome(db, a, v.id, false);
				return;
			}
			db.tx(() => {
				finish('completed', {
					result_json: JSON.stringify(result), raw_output: resp.text.slice(0, 20000), model: resp.model ?? a.model, useful: result.research.useful, relevance: result.research.relevance,
					confidence: result.research.confidence, summary: result.summary,
					evidence_json: JSON.stringify([...result.categories, ...result.techniques, ...result.observations].map((l) => ({ key: l.key, evidence: l.evidence }))),
					usage_json: JSON.stringify({ ...resp.usage, problems }), error: problems.length ? `normalised with notes: ${problems.join('; ').slice(0, 500)}` : null
				});
				const ins = (kind: string, l: any) => db.run(`INSERT INTO video_labels(video_id,analysis_id,kind,key,confidence,evidence_json,status,created_at) VALUES (?,?,?,?,?,?,'active',?)`, v.id, id, kind, l.key, l.confidence, JSON.stringify({ certainty: l.certainty, evidence: l.evidence }), now());
				result.categories.forEach((l) => ins('category', l));
				result.techniques.forEach((l) => ins('technique', l));
				result.observations.forEach((l) => ins('observation', l));
				db.run(`UPDATE videos SET current_analysis_id=?, analysis_status='analysed', updated_at=? WHERE id=?`, id, now(), v.id);
				rebuildCurrent(v.id, db);
			});
			this.afterOutcome(db, a, v.id, true);
		} catch (e: any) {
			const cancelled = ac.signal.aborted || e.message === 'cancelled';
			finish(cancelled ? 'cancelled' : 'failed', { error: cancelled ? 'cancelled by user' : String(e.message ?? e).slice(0, 800) });
			this.afterOutcome(db, a, v.id, false);
		} finally {
			clearInterval(watchdog);
			prep?.cleanup();
		}
	}

	private afterOutcome(db: DB, a: any, videoId: number, success: boolean) {
		// restore the video's flag: analysed if it ever had a good result, else none/failed
		const cur = db.get<any>('SELECT current_analysis_id FROM videos WHERE id=?', videoId);
		const stillQueued = db.value<number>(`SELECT COUNT(*) FROM analyses WHERE video_id=? AND status IN ('queued','preparing','running')`, videoId) ?? 0;
		if (!stillQueued) db.run(`UPDATE videos SET analysis_status=? WHERE id=?`, cur?.current_analysis_id ? 'analysed' : success ? 'analysed' : getProfile(a.profile).usesProvider ? 'failed' : 'none', videoId);
		// batch stop conditions
		const b = db.get<any>('SELECT * FROM analysis_batches WHERE id=?', a.batch_id);
		if (!b || ['cancelled', 'completed'].includes(b.status)) return;
		const ok = db.value<number>(`SELECT COUNT(*) FROM analyses WHERE batch_id=? AND status='completed'`, b.id) ?? 0;
		const cost = db.value<number>(`SELECT COALESCE(SUM(json_extract(usage_json,'$.costUsd')),0) FROM analyses WHERE batch_id=?`, b.id) ?? 0;
		let stop = '';
		if (b.max_success != null && ok >= b.max_success) stop = `stopped after ${ok} successful analyses (limit ${b.max_success})`;
		else if (b.max_cost_usd != null && cost >= b.max_cost_usd) stop = `stopped: cost USD ${cost.toFixed(2)} reached the limit USD ${b.max_cost_usd}`;
		if (stop) {
			db.run(`UPDATE analyses SET status='cancelled', error=?, completed_at=? WHERE batch_id=? AND status='queued'`, stop, now(), b.id);
			db.run(`UPDATE analysis_batches SET note=COALESCE(note||' · ','')||? WHERE id=?`, stop, b.id);
			resetQueuedFlags(db);
		}
		const left = db.value<number>(`SELECT COUNT(*) FROM analyses WHERE batch_id=? AND status IN ('queued','preparing','running')`, b.id) ?? 0;
		if (!left) db.run(`UPDATE analysis_batches SET status='completed', completed_at=? WHERE id=? AND status<>'cancelled'`, now(), b.id);
	}
}

export const runner = new AnalysisRunner();
