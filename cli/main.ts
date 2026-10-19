// visualintelligence CLI. Thin layer over the same core services the dashboard and MCP server use.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { getDb, closeDb } from '../core/db.ts';
import { importSessions } from '../core/importer.ts';
import { defaultSessionsDir, repoRoot, dbPath, dataDir } from '../core/paths.ts';
import { getSettings, setSettings } from '../core/settings.ts';
import { getVideo, listVideos, setNotes, addTags, removeTags, setBookmark, correctLabel, correctResearch } from '../core/videos.ts';
import { getSession, listSessions, sessionVideos } from '../core/sessions.ts';
import { storageReport, findOrphans, findDuplicates } from '../core/storage.ts';
import { overview } from '../core/stats.ts';
import { doctor } from '../core/doctor.ts';
import { collectorState, systemSnapshot } from '../core/system.ts';
import { detectProviders } from '../core/analysis/providers/index.ts';
import { testProvider } from '../core/analysis/test.ts';
import { profileList } from '../core/analysis/profiles.ts';
import { batchSummary, cancelAnalysis, createBatch, estimate, listBatches, retryAnalysis, runner, setBatchState } from '../core/analysis/runner.ts';
import { resolveSelection, type SelectionSpec } from '../core/analysis/select.ts';
import { exportResearch } from '../core/export.ts';
import { applyMediaLimits, generateMissingThumbnails, thumbProgress, pruneCache } from '../core/media.ts';
import { absPath } from '../core/videos.ts';
import { listCollectors, pairCollector, revokeCollector } from '../core/collectors.ts';
import { fmtBytes } from '../core/util.ts';

interface Args {
	_: string[];
	flags: Record<string, string | boolean | string[]>;
}

const BOOL = new Set(['json', 'yes', 'y', 'dry-run', 'bookmarked', 'reanalyse', 'queue-only', 'remote', 'force', 'help', 'h', 'unanalysed', 'analysed', 'dev', 'all', 'no-sync', 'stdin']);
function parse(argv: string[]): Args {
	const a: Args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i];
		if (t.startsWith('--')) {
			const [k, v] = t.slice(2).split(/=(.*)/s, 2);
			let val: string | boolean = v ?? true;
			if (v === undefined && !BOOL.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
			const prev = a.flags[k];
			a.flags[k] = prev === undefined ? val : ([] as string[]).concat(prev as any, val as string);
		} else if (t === '-h') a.flags.help = true;
		else if (t === '-y') a.flags.yes = true;
		else a._.push(t);
	}
	return a;
}
const f = (a: Args, k: string) => (Array.isArray(a.flags[k]) ? (a.flags[k] as string[]).at(-1) : (a.flags[k] as string | undefined));
const fl = (a: Args, k: string): string[] => (a.flags[k] === undefined ? [] : ([] as any[]).concat(a.flags[k]).map(String));
const has = (a: Args, k: string) => a.flags[k] !== undefined && a.flags[k] !== false;
const num = (s?: string) => (s == null ? undefined : Number(s));

const HELP = `visualintelligence — collect, organise, inspect and analyse videos with the agents you already have.
No command here calls an AI unless it is "analyse" (or "providers test"), and those only run when you ask.

USAGE  visualintelligence <command> [options]        (add --json for machine-readable output)

  status                               library, sessions, jobs, collector, resources at a glance
  sync [--force]                       read the collector's Scroll Sessions into the database (read-only)
  videos list [--q TEXT] [--creator U] [--session ID] [--analysis analysed|unanalysed] [--bookmarked]
              [--category K] [--technique K] [--min-relevance 0-1] [--sort collected|size|duration|relevance] [--limit N]
  videos show <id>                     one video, labels, sessions, history
  videos bookmark|unbookmark <id>...   videos tag <id> --add a,b | --remove a   videos note <id> --text "…"
  videos label <id> --kind category|technique|observation --key K [--reject]   (human correction)
  videos verdict <id> --useful useful|not_useful|uncertain [--relevance 0-1]
  sessions list | sessions show <id>
  storage [--inspect]                  disk usage by kind, filesystem, orphans & duplicates
  analyse (--video ID ...| --session ID | --next N | --creator U | --bookmarked | --ids-file F)
          --provider claude|codex|antigravity|sarness  --profile index|quick|standard|deep
          [--model M] [--limit N] [--max-success N] [--max-cost USD] [--concurrency N] [--reanalyse]
          [--dry-run] [--yes] [--queue-only]
  jobs list [--status S] | jobs show <batch|analysis uid> | jobs cancel|pause|resume <batch uid> | jobs cancel-one|retry <analysis uid>
  providers list | providers test <id> [--model M]       (test = one tiny image, an explicit billable-if-billed call)
  thumbnails [--limit N]               generate missing thumbnails (ffmpeg, CPU, niced, one at a time)
  export [--format json|jsonl|csv] [--all] [--out FILE]
  collectors pair <name> | collectors list | collectors revoke <id>   (remote collector credentials)
  doctor [--remote]                    diagnostics: database, disk, binaries, orphans, memory/GPU, providers
  serve [--dev] [--host H] [--port P]  start the dashboard (production build, or Vite dev with --dev)
  mcp                                  Model Context Protocol server on stdio
  backup [--out FILE]                  consistent database snapshot
`;

const out = (a: Args, data: unknown, text?: string) => {
	if (has(a, 'json')) console.log(JSON.stringify(data, null, 2));
	else console.log(text ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
};
function table(rows: Array<Record<string, any>>, cols: string[]): string {
	if (!rows.length) return '(none)';
	const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
	const line = (r: Record<string, any>) => cols.map((c, i) => String(r[c] ?? '').slice(0, 60).padEnd(w[i])).join('  ');
	return [cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '), ...rows.map(line)].join('\n');
}
const fail = (msg: string): never => {
	throw new Error(msg);
};

export async function main(argv: string[]): Promise<number> {
	const a = parse(argv);
	const [cmd, sub] = a._;
	if (!cmd || has(a, 'help')) {
		console.log(HELP);
		return cmd || has(a, 'help') ? 0 : 1;
	}
	try {
		if (cmd === 'help') return (console.log(HELP), 0);
		if (cmd === 'serve') return await serve(a);
		if (cmd === 'mcp') {
			const { runMcpStdio } = await import('../core/mcp/server.ts');
			await runMcpStdio();
			return 0;
		}
		const db = getDb();
		applyMediaLimits(db);
		// keep the DB current with the collector's folder without being asked, cheaply (mtime-stamped, incremental)
		if (!has(a, 'no-sync') && !['sync', 'doctor', 'backup'].includes(cmd)) {
			try {
				importSessions(db, getSettings(db).collector.sessionsDir || defaultSessionsDir());
			} catch {
				/* the folder may not exist on a server */
			}
		}
		switch (cmd) {
			case 'status': return await status(a);
			case 'sync': {
				const r = importSessions(db, f(a, 'dir') ?? (getSettings(db).collector.sessionsDir || defaultSessionsDir()), { force: has(a, 'force') });
				out(a, r, `Synced ${r.sessionsDir}\n  sessions: ${r.sessionsFound} found, ${r.sessionsImported} imported/updated, ${r.sessionsUnchanged} unchanged, ${r.sessionsIncomplete} flagged incomplete\n  videos: ${r.videosTotal} unique (${r.videosNew} new); files on disk: ${r.filesOnDisk} (${fmtBytes(r.bytesOnDisk)}); missing/empty: ${r.filesMissing}; orphans: ${r.orphanFiles.length}${r.warnings.length ? '\n  warnings:\n    ' + r.warnings.slice(0, 10).join('\n    ') : ''}`);
				return 0;
			}
			case 'videos': return videos(a, sub);
			case 'sessions': return sessions(a, sub);
			case 'storage': {
				const r: any = storageReport(db);
				if (has(a, 'inspect')) (r.orphans = findOrphans(db)), (r.duplicates = findDuplicates(db));
				out(a, r, r.categories.map((c: any) => `${c.label.padEnd(48)} ${fmtBytes(c.bytes).padStart(10)}  ${c.files} file(s)`).join('\n') + `\nfree on media filesystem: ${fmtBytes(r.filesystem.mediaRoot.freeBytes)} of ${fmtBytes(r.filesystem.mediaRoot.totalBytes)}` + (r.orphans ? `\nmissing files: ${r.orphans.missingFiles.length}; orphan files: ${r.orphans.orphanFiles.length}; duplicate-content groups: ${r.duplicates.length}` : ''));
				return 0;
			}
			case 'analyse': case 'analyze': return await analyse(a);
			case 'jobs': return await jobs(a, sub);
			case 'providers': return await providers(a, sub);
			case 'thumbnails': {
				await generateMissingThumbnails(db, (v) => absPath(db, v), num(f(a, 'limit')) ?? 100000);
				const t0 = Date.now();
				while (thumbProgress().running) {
					process.stderr.write(`\r  thumbnails ${thumbProgress().done}/${thumbProgress().total}`);
					await new Promise((r) => setTimeout(r, 500));
				}
				out(a, thumbProgress(), `\nthumbnails done: ${thumbProgress().done} created, ${thumbProgress().failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
				return 0;
			}
			case 'export': {
				const fmt = (f(a, 'format') ?? 'json') as 'json' | 'jsonl' | 'csv';
				const body = exportResearch(db, { format: fmt, onlyAnalysed: !has(a, 'all') });
				if (f(a, 'out')) (await import('node:fs')).writeFileSync(f(a, 'out')!, body);
				else process.stdout.write(body);
				return 0;
			}
			case 'collectors': {
				if (sub === 'pair') {
					const r = pairCollector(a._[2] ?? fail('usage: collectors pair <name>'));
					out(a, r, `Collector "${a._[2]}" paired.\n  id:    ${r.id}\n  token: ${r.token}\n\nThis token is shown once. On the collecting machine set:\n  VIE_SERVER=http://<server>:<port>  VIE_COLLECTOR_TOKEN=${r.token}`);
				} else if (sub === 'revoke') out(a, { revoked: revokeCollector(a._[2] ?? fail('usage: collectors revoke <id>')) });
				else out(a, listCollectors(), table(listCollectors() as any, ['id', 'name', 'created_at', 'last_seen_at', 'revoked']));
				return 0;
			}
			case 'doctor': {
				const checks = await doctor({ remote: has(a, 'remote') });
				out(a, checks, checks.map((c) => `${{ ok: '  ok ', warn: ' WARN', fail: ' FAIL', info: ' info' }[c.status]}  ${c.area.padEnd(10)} ${c.name.padEnd(22)} ${c.detail}`).join('\n') + `\n\n${checks.filter((c) => c.status === 'fail').length} failing, ${checks.filter((c) => c.status === 'warn').length} warning(s). doctor never calls an AI.`);
				return checks.some((c) => c.status === 'fail') ? 2 : 0;
			}
			case 'backup': {
				const dest = f(a, 'out') ?? join(dataDir(), 'backups', `vie-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
				db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
				out(a, { path: dest }, `Backup written: ${dest}`);
				return 0;
			}
			case 'settings': {
				if (sub === 'set') return (out(a, setSettings(JSON.parse(a._[2] ?? fail('usage: settings set \'{"media":{"thumbWidth":400}}\''))), 'ok'), 0);
				out(a, getSettings(db));
				return 0;
			}
			default:
				console.error(`unknown command "${cmd}"\n`);
				console.log(HELP);
				return 1;
		}
	} catch (e: any) {
		if (has(a, 'json')) console.log(JSON.stringify({ error: e.message }));
		else console.error(`error: ${e.message}`);
		return 1;
	} finally {
		closeDbSoon();
	}
}
const closeDbSoon = () => setTimeout(() => closeDb(), 0).unref();

async function status(a: Args) {
	const db = getDb();
	const o = overview({}, db);
	const sys = await systemSnapshot();
	const data = { db: dbPath(), totals: o.totals, collector: collectorState(), host: sys.host, gpu: sys.gpu, batches: listBatches(3, db) };
	const t = o.totals;
	out(a, data, `Library   ${t.uniqueVideos} unique videos · ${t.downloadedFiles} files · ${fmtBytes(t.diskBytes)} · ${t.sessions} sessions (${t.incompleteSessions} incomplete)
Analysis  ${t.analysed} analysed · ${t.unanalysed} unanalysed (${t.analysisPct}%) · ${t.pendingJobs} pending · ${t.failedJobs} failed
Problems  ${t.missingFiles} missing/empty files · ${t.duplicatesAvoided} duplicate downloads avoided
Collector ${data.collector.running ? 'running (pid ' + data.collector.pid + ')' : 'idle'}
Machine   ${(sys.host as any).availableMB} MB RAM available · disk free ${fmtBytes(sys.disk.data.freeBytes)} · GPU ${sys.gpu.available ? sys.gpu.name + ' ' + Math.round(sys.gpu.usedMB) + '/' + Math.round(sys.gpu.totalMB) + ' MB' : 'n/a'}
Database  ${dbPath()}`);
	return 0;
}

function videos(a: Args, sub?: string) {
	const db = getDb();
	if (sub === 'list' || !sub) {
		const r = listVideos({
			q: f(a, 'q'), creator: f(a, 'creator'), sessionId: f(a, 'session'), analysis: f(a, 'analysis') as any ?? (has(a, 'unanalysed') ? 'unanalysed' : has(a, 'analysed') ? 'analysed' : undefined),
			bookmarked: has(a, 'bookmarked') ? true : undefined, category: f(a, 'category')?.split(','), technique: f(a, 'technique')?.split(','), minRelevance: num(f(a, 'min-relevance')),
			sort: f(a, 'sort') as any, dir: f(a, 'dir') as any, limit: num(f(a, 'limit')) ?? 25, offset: num(f(a, 'offset')), downloadStatus: f(a, 'status')
		}, db);
		out(a, r, table(r.videos.map((v: any) => ({ id: v.uid, creator: '@' + (v.creator ?? '?'), dur: v.duration_s ? v.duration_s.toFixed(1) + 's' : '', res: v.width ? `${v.width}x${v.height}` : '', size: fmtBytes(v.file_size), state: v.analysis_status, class: v.cur_primary ?? '', collected: (v.first_collected_at ?? '').slice(0, 16) })), ['id', 'creator', 'dur', 'res', 'size', 'state', 'class', 'collected']) + `\n${r.videos.length} of ${r.total}`);
		return 0;
	}
	const ids = a._.slice(2);
	if (sub === 'show') {
		const v = getVideo(ids[0] ?? fail('usage: videos show <id>'), db) ?? fail('video not found');
		out(a, v, JSON.stringify(v, null, 2));
	} else if (sub === 'bookmark' || sub === 'unbookmark') out(a, { updated: setBookmark(ids, sub === 'bookmark', db) });
	else if (sub === 'tag') {
		addTags(ids.slice(0, 1), fl(a, 'add').flatMap((s) => s.split(',')), 'human', db);
		if (has(a, 'remove')) removeTags(ids.slice(0, 1), fl(a, 'remove').flatMap((s) => s.split(',')), db);
		out(a, 'ok');
	} else if (sub === 'note') {
		setNotes(ids[0], f(a, 'text') ?? '', db);
		out(a, 'ok');
	} else if (sub === 'label') {
		correctLabel(ids[0], (f(a, 'kind') ?? fail('--kind required')) as any, f(a, 'key') ?? fail('--key required'), has(a, 'reject') ? 'reject' : 'add', f(a, 'note'), db);
		out(a, 'ok');
	} else if (sub === 'verdict') {
		correctResearch(ids[0], { useful: f(a, 'useful') as any, relevance: num(f(a, 'relevance')) }, f(a, 'note'), db);
		out(a, 'ok');
	} else fail('unknown videos subcommand');
	return 0;
}

function sessions(a: Args, sub?: string) {
	if (sub === 'show') {
		const id = a._[2] ?? fail('usage: sessions show <id>');
		const s = getSession(id) ?? fail('session not found');
		const v = sessionVideos(id, { limit: num(f(a, 'limit')) ?? 20 });
		out(a, { session: s, videos: v }, `${id}  ${s.status}${s.incomplete ? ' (INCOMPLETE: ' + s.incomplete_reason + ')' : ''}\n  started ${s.started_at}  ended ${s.ended_at ?? '—'}  duration ${s.duration_s != null ? Math.round(s.duration_s) + 's' : '—'}\n  mode ${s.mode} · source ${s.source_kind} · stop: ${s.stop_reason ?? '—'}\n  encountered ${s.encountered} · downloaded ${s.downloaded} · duplicates ${s.duplicates} · failed ${s.failed} · unavailable ${s.unavailable} · skipped ${s.skipped} · unfinished ${s.queued}\n  new data ${fmtBytes(s.disk_bytes_new)}\n\n` + table(v.videos.map((x: any) => ({ '#': x.position, id: x.uid, creator: '@' + (x.creator ?? '?'), state: x.session_status, size: fmtBytes(x.file_size) })), ['#', 'id', 'creator', 'state', 'size']));
		return 0;
	}
	const r = listSessions({ limit: num(f(a, 'limit')) ?? 100, status: f(a, 'status') });
	out(a, r, table(r.sessions.map((s: any) => ({ id: s.id, status: s.status + (s.incomplete ? '*' : ''), mode: s.mode, source: s.source_kind, seen: s.encountered, down: s.downloaded, dupes: s.duplicates, fail: s.failed + s.unavailable, new: fmtBytes(s.bytes_downloaded), analysed: s.analysed })), ['id', 'status', 'mode', 'source', 'seen', 'down', 'dupes', 'fail', 'new', 'analysed']) + '\n* = incomplete record');
	return 0;
}

async function analyse(a: Args) {
	const db = getDb();
	const provider = f(a, 'provider') ?? '';
	const profile = f(a, 'profile') ?? getSettings(db).analysis.defaultProfile;
	if (profile !== 'index' && !provider) fail('--provider is required (claude, codex, antigravity, sarness); run "providers list"');
	let spec: SelectionSpec;
	const lim = num(f(a, 'limit'));
	const vids = fl(a, 'video');
	if (vids.length) spec = { scope: 'uids', uids: vids.flatMap((s) => s.split(',')) };
	else if (f(a, 'ids-file')) spec = { scope: 'uids', uids: (await import('node:fs')).readFileSync(f(a, 'ids-file')!, 'utf8').split(/\s+/).filter(Boolean) };
	else if (has(a, 'stdin')) spec = { scope: 'uids', uids: (await import('node:fs')).readFileSync(0, 'utf8').split(/\s+/).filter(Boolean) };
	else if (f(a, 'session') && !f(a, 'next')) spec = { scope: 'session', session: f(a, 'session')!, limit: lim, onlyUnanalysed: !has(a, 'reanalyse') };
	else if (f(a, 'next')) spec = { scope: 'next', n: Number(f(a, 'next')), session: f(a, 'session'), creator: f(a, 'creator') };
	else if (f(a, 'creator')) spec = { scope: 'creator', creator: f(a, 'creator')!, limit: lim, onlyUnanalysed: !has(a, 'reanalyse') };
	else if (has(a, 'bookmarked')) spec = { scope: 'bookmarked', limit: lim, onlyUnanalysed: !has(a, 'reanalyse') };
	else return fail('choose what to analyse: --video ID, --session ID, --next N, --creator U, --bookmarked, --ids-file F (nothing is ever selected implicitly)');
	const sel = resolveSelection(spec, db);
	const est = estimate(sel.uids, provider || 'none', profile, db);
	const summary = `${sel.description}: ${est.videos} video(s)${est.alreadyAnalysed && !has(a, 'reanalyse') && profile !== 'index' ? ` (${est.alreadyAnalysed} already analysed, will be skipped)` : ''}, ${est.providerCalls} agent call(s) via ${provider || 'no agent'} · ${profile}; cost ${est.estimatedCostUsd != null ? '≈ $' + est.estimatedCostUsd : 'unknown'}; time ${est.estimatedSeconds != null ? '≈ ' + est.estimatedSeconds + 's' : 'unknown'}`;
	if (has(a, 'dry-run')) return (out(a, { selection: sel, estimate: est }, `DRY RUN — nothing started.\n${summary}\n${est.note}`), 0);
	if (est.providerCalls > 0 && !has(a, 'yes')) {
		if (!process.stdin.isTTY) fail(`refusing to call an external agent non-interactively without --yes.\n${summary}`);
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		const ans = await rl.question(`${summary}\n${est.note}\nStart? [y/N] `);
		rl.close();
		if (!/^y(es)?$/i.test(ans.trim())) return (console.error('Cancelled. Nothing was started.'), 1);
	}
	const r = await createBatch(sel, { provider: provider || 'none', profile, model: f(a, 'model'), concurrency: num(f(a, 'concurrency')), maxSuccess: num(f(a, 'max-success')), maxCostUsd: num(f(a, 'max-cost')), reanalyse: has(a, 'reanalyse'), startNow: !has(a, 'queue-only') });
	if (has(a, 'queue-only')) return (out(a, r, `Queued ${r.queued} analyses in batch ${r.batchUid}. A running dashboard (npm run start/dev) will pick it up within ~15 s.`), 0);
	let last = '';
	await runner.drain([r.batchId], () => {
		const b = batchSummary(r.batchUid)!;
		const c = b.counts as any;
		const line = `  ${c.completed ?? 0} done · ${(c.running ?? 0) + (c.preparing ?? 0)} running · ${c.queued ?? 0} queued · ${c.failed ?? 0} failed · $${b.costUsd.toFixed(3)}`;
		if (line !== last && !has(a, 'json')) process.stderr.write('\r' + line.padEnd(80));
		last = line;
	});
	const b = batchSummary(r.batchUid)!;
	const rows = db.all<any>(`SELECT a.uid, v.uid vuid, a.status, a.error, a.summary, a.useful, a.relevance, json_extract(a.usage_json,'$.costUsd') cost, json_extract(a.usage_json,'$.ms') ms FROM analyses a JOIN videos v ON v.id=a.video_id WHERE a.batch_id=?`, r.batchId);
	out(a, { batch: b, analyses: rows }, '\n' + rows.map((x) => `${x.vuid}  ${x.status}${x.status === 'completed' ? `  ${x.useful} rel=${x.relevance}  ${x.ms ? (x.ms / 1000).toFixed(1) + 's' : ''}  ${x.cost != null ? '$' + Number(x.cost).toFixed(3) : ''}\n    ${x.summary}` : '  ' + (x.error ?? '')}`).join('\n') + `\nbatch ${r.batchUid}: ${b.status}${b.note ? ' — ' + b.note : ''}`);
	return rows.some((x) => x.status === 'failed') ? 3 : 0;
}

async function jobs(a: Args, sub?: string) {
	const db = getDb();
	const id = a._[2];
	if (!sub || sub === 'list') {
		const rows = db.all<any>(`SELECT a.uid, v.uid vuid, a.provider, a.profile, a.status, a.created_at, substr(COALESCE(a.error,''),1,50) err FROM analyses a JOIN videos v ON v.id=a.video_id ${f(a, 'status') ? `WHERE a.status='${String(f(a, 'status')).replace(/[^a-z_]/g, '')}'` : ''} ORDER BY a.id DESC LIMIT ${num(f(a, 'limit')) ?? 30}`);
		const b = listBatches(10, db);
		out(a, { batches: b, analyses: rows }, `BATCHES\n${table(b.map((x: any) => ({ batch: x.uid, status: x.status, agent: x.provider, depth: x.profile, request: x.selection.description, done: x.counts.completed ?? 0, failed: x.counts.failed ?? 0, queued: x.counts.queued ?? 0 })), ['batch', 'status', 'agent', 'depth', 'done', 'failed', 'queued', 'request'])}\n\nANALYSES\n${table(rows.map((r) => ({ job: r.uid, video: r.vuid, agent: r.provider, depth: r.profile, status: r.status, error: r.err })), ['job', 'video', 'agent', 'depth', 'status', 'error'])}`);
	} else if (sub === 'show') {
		const b = batchSummary(id ?? fail('usage: jobs show <uid>'));
		out(a, b ?? db.get('SELECT * FROM analyses WHERE uid=?', id) ?? fail('not found'));
	} else if (['cancel', 'pause', 'resume'].includes(sub)) {
		setBatchState(id ?? fail('batch uid required'), sub === 'cancel' ? 'cancelled' : sub === 'pause' ? 'paused' : 'running', db);
		out(a, batchSummary(id), `batch ${id}: ${sub} requested`);
	} else if (sub === 'cancel-one') (cancelAnalysis(id ?? fail('analysis uid required'), db), out(a, 'ok'));
	else if (sub === 'retry') {
		const r = await retryAnalysis(id ?? fail('analysis uid required'), db);
		await runner.drain([r.batchId]);
		out(a, r);
	} else fail('unknown jobs subcommand');
	return 0;
}

async function providers(a: Args, sub?: string) {
	if (sub === 'test') {
		const id = a._[2] ?? fail('usage: providers test <id>');
		console.error(`Running one tiny test call against ${id}…`);
		const r = await testProvider(id, f(a, 'model'));
		out(a, r, r.ok ? `${id}: OK in ${((r as any).wallMs / 1000).toFixed(1)}s — image understanding: ${(r as any).imageUnderstanding ? 'yes' : 'NO'} · answer ${JSON.stringify((r as any).answer)} · model ${(r as any).model ?? '?'} · cost ${(r as any).usage?.costUsd ?? 'unknown'}` : `${id}: FAILED — ${(r as any).error}`);
		return r.ok ? 0 : 1;
	}
	const p = await detectProviders(true);
	out(a, { providers: p, profiles: profileList() }, table(p.map((x) => ({ id: x.id, available: x.available ? 'yes' : 'no', version: x.version ?? '', images: x.supports.images ? 'yes' : 'no', verified: x.verified, detail: x.detail.slice(0, 90) })), ['id', 'available', 'version', 'images', 'verified', 'detail']));
	return 0;
}

async function serve(a: Args) {
	const root = repoRoot();
	const env = { ...process.env, ...(f(a, 'host') ? { VIE_HOST: f(a, 'host') } : {}), ...(f(a, 'port') ? { VIE_PORT: f(a, 'port') } : {}) };
	const script = has(a, 'dev') ? 'bin/dev.mjs' : 'bin/start.mjs';
	const child = spawn(process.execPath, [join(root, script)], { stdio: 'inherit', env, cwd: root });
	for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => child.kill(s));
	return await new Promise<number>((res) => child.on('close', (c) => res(c ?? 0)));
}
