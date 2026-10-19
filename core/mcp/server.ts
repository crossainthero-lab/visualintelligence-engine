// Model Context Protocol server. Same services as the dashboard and CLI; no shell access, no file access outside the
// library, no deletion. Read-only tools are separate from write/action tools and can be switched off entirely.
import { readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../db.ts';
import { getVideo, listVideos, videoAbsByUid, setBookmark, addTags, correctLabel, correctResearch, setNotes } from '../videos.ts';
import { getSession, listSessions, sessionVideos } from '../sessions.ts';
import { storageReport } from '../storage.ts';
import { overview } from '../stats.ts';
import { allTerms, TAXONOMY_VERSION } from '../taxonomy.ts';
import { ensureThumbnail, thumbFile, extractFrames, evenTimes } from '../media.ts';
import { batchSummary, cancelAnalysis, createBatch, estimate, listBatches, runner } from '../analysis/runner.ts';
import { resolveSelection } from '../analysis/select.ts';
import { detectProviders } from '../analysis/providers/index.ts';
import { exportRecords } from '../export.ts';
import { parseJson } from '../util.ts';

export interface McpOptions {
	write: boolean; // register write/action tools at all
	transport: 'stdio' | 'http';
}

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const err = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: String((e as Error).message ?? e) }] });
const guard = <A,>(fn: (a: A) => unknown | Promise<unknown>) => async (a: A) => {
	try {
		return text(await fn(a));
	} catch (e) {
		return err(e);
	}
};
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

export function buildMcpServer(o: McpOptions): McpServer {
	const s = new McpServer({ name: 'visual-intelligence', version: '0.2.0' }, {
		instructions: 'Visual Intelligence research library. Read tools are safe. Write tools change only human-curated data (bookmarks, tags, label corrections) — except create_analysis_job, which calls an external agent and costs money/time: only use it when the user explicitly asked for analysis, with explicit video ids.'
	});

	// ---------------- resources ----------------
	s.registerResource('taxonomy', 'vie://taxonomy', { title: 'Classification taxonomy', description: `Versioned label keys (${TAXONOMY_VERSION})`, mimeType: 'application/json' },
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ version: TAXONOMY_VERSION, terms: allTerms() }) }] }));
	s.registerResource('video-metadata', new ResourceTemplate('vie://video/{uid}/metadata', { list: undefined }), { title: 'Video metadata', mimeType: 'application/json' },
		async (uri, { uid }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(getVideo(String(uid))) }] }));
	s.registerResource('video-thumbnail', new ResourceTemplate('vie://video/{uid}/thumbnail', { list: undefined }), { title: 'Video thumbnail (JPEG)', mimeType: 'image/jpeg' },
		async (uri, { uid }) => {
			const t = await thumb(String(uid));
			return { contents: [{ uri: uri.href, mimeType: 'image/jpeg', blob: t }] };
		});

	// ---------------- read-only tools ----------------
	const filterShape = {
		q: z.string().optional().describe('text search over caption, creator, id, notes, tags'),
		creator: z.string().optional(),
		session: z.string().optional().describe('session id'),
		analysis: z.enum(['analysed', 'unanalysed', 'any']).optional(),
		category: z.array(z.string()).optional(),
		technique: z.array(z.string()).optional(),
		bookmarked: z.boolean().optional(),
		min_relevance: z.number().min(0).max(1).optional(),
		sort: z.enum(['collected', 'size', 'duration', 'relevance', 'creator', 'resolution', 'posted']).optional(),
		limit: z.number().int().min(1).max(100).optional(),
		offset: z.number().int().min(0).optional()
	};
	const toFilter = (a: any) => ({ q: a.q, creator: a.creator, sessionId: a.session, analysis: a.analysis, category: a.category, technique: a.technique, bookmarked: a.bookmarked, minRelevance: a.min_relevance, sort: a.sort, limit: a.limit ?? 25, offset: a.offset });
	const slim = (v: any) => ({ id: v.uid, creator: v.creator, caption: v.caption?.slice(0, 160), duration_s: v.duration_s, resolution: v.width ? `${v.width}x${v.height}` : null, size: v.file_size, collected: v.first_collected_at, analysis: v.analysis_status, primary_class: v.cur_primary, relevance: v.cur_relevance, useful: v.cur_useful, bookmarked: v.bookmarked, tags: v.tags });

	s.registerTool('list_videos', { description: 'List downloaded videos with optional filters. Returns compact records; use get_video for detail.', inputSchema: filterShape, annotations: { title: 'List videos', ...readOnly } },
		guard((a: any) => { const r = listVideos(toFilter(a)); return { total: r.total, videos: r.videos.map(slim) }; }));
	s.registerTool('search_videos', { description: 'Search videos by text (caption, creator, notes, tags, analysis summary).', inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }, annotations: { title: 'Search videos', ...readOnly } },
		guard((a: any) => { const r = listVideos({ q: a.query, limit: a.limit ?? 20 }); return { total: r.total, videos: r.videos.map(slim) }; }));
	s.registerTool('get_video', { description: 'Full metadata for one video: media facts, sessions, current labels, corrections.', inputSchema: { id: z.string() }, annotations: { title: 'Get video', ...readOnly } },
		guard((a: any) => getVideo(a.id) ?? Promise.reject(new Error('video not found'))));
	s.registerTool('get_thumbnail', { description: 'The thumbnail image of a video.', inputSchema: { id: z.string() }, annotations: { title: 'Get thumbnail', ...readOnly } },
		async (a: any) => { try { return { content: [{ type: 'image' as const, data: await thumb(a.id), mimeType: 'image/jpeg' }] }; } catch (e) { return err(e); } });
	s.registerTool('get_frames', { description: 'Extract up to 8 still frames (JPEG, 512px wide) from a video at given seconds, or evenly spaced. CPU only; cached.', inputSchema: { id: z.string(), times: z.array(z.number().min(0)).max(8).optional(), count: z.number().int().min(1).max(8).optional() }, annotations: { title: 'Get frames', ...readOnly } },
		async (a: any) => {
			try {
				const v = videoAbsByUid(a.id) ?? fail('video not found');
				const times = a.times?.length ? a.times : evenTimes(v.duration_s ?? 0, a.count ?? 4);
				const frames = await extractFrames(v, times, 512);
				return { content: [{ type: 'text' as const, text: `frames at: ${frames.map((f) => f.t.toFixed(2) + 's').join(', ')}` }, ...frames.map((f) => ({ type: 'image' as const, data: readFileSync(f.path).toString('base64'), mimeType: 'image/jpeg' }))] };
			} catch (e) { return err(e); }
		});
	s.registerTool('list_sessions', { description: 'Collection (scrolling) sessions, newest first.', inputSchema: { limit: z.number().int().min(1).max(200).optional(), status: z.string().optional() }, annotations: { title: 'List sessions', ...readOnly } },
		guard((a: any) => listSessions({ limit: a.limit ?? 30, status: a.status }).sessions.map((x: any) => ({ id: x.id, status: x.status, incomplete: x.incomplete, mode: x.mode, source: x.source_kind, started: x.started_at, duration_s: x.duration_s, encountered: x.encountered, downloaded: x.downloaded, duplicates: x.duplicates, failed: x.failed, new_bytes: x.bytes_downloaded }))));
	s.registerTool('get_session', { description: 'One session with its videos.', inputSchema: { id: z.string(), limit: z.number().int().min(1).max(200).optional() }, annotations: { title: 'Get session', ...readOnly } },
		guard((a: any) => ({ session: getSession(a.id) ?? fail('session not found'), videos: sessionVideos(a.id, { limit: a.limit ?? 50 }).videos.map((v: any) => ({ id: v.uid, creator: v.creator, status: v.session_status, size: v.file_size })) })));
	s.registerTool('get_overview', { description: 'Library totals: videos, sessions, disk, analysed/unanalysed, jobs.', inputSchema: {}, annotations: { title: 'Overview', ...readOnly } }, guard(() => overview({}).totals));
	s.registerTool('get_storage_stats', { description: 'Disk usage by kind and free space.', inputSchema: {}, annotations: { title: 'Storage stats', ...readOnly } }, guard(() => storageReport()));
	s.registerTool('get_taxonomy', { description: 'All valid classification keys (categories, techniques, observations).', inputSchema: {}, annotations: { title: 'Taxonomy', ...readOnly } }, guard(() => ({ version: TAXONOMY_VERSION, terms: allTerms() })));
	s.registerTool('inspect_classifications', { description: 'Current labels of a video (agent + human) and its analysis history.', inputSchema: { id: z.string() }, annotations: { title: 'Inspect classifications', ...readOnly } },
		guard((a: any) => {
			const v: any = getVideo(a.id) ?? fail('video not found');
			return { labels: v.labels, verdict: { useful: v.cur_useful, relevance: v.cur_relevance, confidence: v.cur_confidence }, corrections: v.corrections, history: getDb().all('SELECT a.uid, a.provider, a.model, a.profile, a.status, a.completed_at FROM analyses a JOIN videos v ON v.id=a.video_id WHERE v.uid=? ORDER BY a.id', a.id) };
		}));
	s.registerTool('list_analysis_jobs', { description: 'Analysis batches and their counts.', inputSchema: { limit: z.number().int().min(1).max(100).optional() }, annotations: { title: 'List jobs', ...readOnly } }, guard((a: any) => listBatches(a.limit ?? 20)));
	s.registerTool('get_analysis_job', { description: 'One batch (by batch uid) or one analysis (by analysis uid).', inputSchema: { uid: z.string() }, annotations: { title: 'Get job', ...readOnly } },
		guard((a: any) => batchSummary(a.uid) ?? getDb().get('SELECT uid,provider,model,profile,status,error,summary,useful,relevance,confidence,created_at,completed_at FROM analyses WHERE uid=?', a.uid) ?? fail('not found')));
	s.registerTool('get_analysis_result', { description: 'The full structured result of the current analysis of a video (labels with evidence, research verdict, limitations).', inputSchema: { id: z.string() }, annotations: { title: 'Analysis result', ...readOnly } },
		guard((a: any) => { const r = getDb().get<any>(`SELECT a.uid,a.provider,a.model,a.profile,a.schema_version,a.completed_at,a.result_json,a.input_json FROM analyses a JOIN videos v ON v.current_analysis_id=a.id WHERE v.uid=?`, a.id); return r ? { ...r, result: parseJson(r.result_json, null), evidence_given: parseJson(r.input_json, null), result_json: undefined, input_json: undefined } : fail('no analysis for this video'); }));
	s.registerTool('list_providers', { description: 'Which analysis agents are available on this machine (detection only, no model call).', inputSchema: {}, annotations: { title: 'Providers', ...readOnly } },
		guard(async () => (await detectProviders()).map((p) => ({ id: p.id, available: p.available, version: p.version, images: p.supports.images, models: p.models.slice(0, 20), detail: p.detail }))));
	s.registerTool('estimate_analysis', { description: 'Estimate workload/cost of analysing explicit videos. Calls no agent.', inputSchema: { ids: z.array(z.string()).min(1).max(500), provider: z.string(), profile: z.enum(['index', 'quick', 'standard', 'deep']) }, annotations: { title: 'Estimate analysis', ...readOnly } },
		guard((a: any) => estimate(a.ids, a.provider, a.profile)));
	s.registerTool('export_research', { description: 'Structured research export (analysed videos with labels, evidence, corrections).', inputSchema: { ids: z.array(z.string()).max(200).optional(), only_analysed: z.boolean().optional() }, annotations: { title: 'Export research', ...readOnly } },
		guard((a: any) => exportRecords(getDb(), { uids: a.ids, onlyAnalysed: a.only_analysed ?? true }).slice(0, 200)));

	if (!o.write) return s;

	// ---------------- write / action tools (curated data + explicit analysis requests) ----------------
	const w = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
	s.registerTool('bookmark_videos', { description: 'Bookmark or unbookmark videos.', inputSchema: { ids: z.array(z.string()).min(1).max(500), on: z.boolean() }, annotations: { title: 'Bookmark', ...w, idempotentHint: true } }, guard((a: any) => ({ updated: setBookmark(a.ids, a.on) })));
	s.registerTool('tag_videos', { description: 'Add tags to videos.', inputSchema: { ids: z.array(z.string()).min(1).max(500), tags: z.array(z.string().min(1).max(40)).min(1).max(10) }, annotations: { title: 'Tag', ...w, idempotentHint: true } }, guard((a: any) => (addTags(a.ids, a.tags, 'agent'), { ok: true })));
	s.registerTool('set_notes', { description: 'Replace the personal notes of a video.', inputSchema: { id: z.string(), notes: z.string().max(5000) }, annotations: { title: 'Set notes', ...w, idempotentHint: true } }, guard((a: any) => (setNotes(a.id, a.notes), { ok: true })));
	s.registerTool('correct_classification', { description: 'Add or reject a label as a human correction (the original agent output is preserved). Use get_taxonomy for valid keys.', inputSchema: { id: z.string(), kind: z.enum(['category', 'technique', 'observation']), key: z.string(), action: z.enum(['add', 'reject', 'clear']), note: z.string().max(500).optional() }, annotations: { title: 'Correct classification', ...w } },
		guard((a: any) => (correctLabel(a.id, a.kind, a.key, a.action, a.note), { ok: true })));
	s.registerTool('set_research_verdict', { description: 'Override whether a video is useful for research, and/or its relevance score.', inputSchema: { id: z.string(), useful: z.enum(['useful', 'not_useful', 'uncertain']).optional(), relevance: z.number().min(0).max(1).optional(), note: z.string().max(500).optional() }, annotations: { title: 'Set verdict', ...w } },
		guard((a: any) => (correctResearch(a.id, { useful: a.useful, relevance: a.relevance }, a.note), { ok: true })));
	s.registerTool('create_analysis_job', {
		description: 'ACTION: start an analysis of explicit videos with an external agent (Claude Code / Codex / Antigravity / Sarness). Consumes the user\'s agent quota or money. Only call when the user explicitly asked, pass explicit ids, and set confirm=true. Check estimate_analysis first.',
		inputSchema: { ids: z.array(z.string()).min(1).max(100), provider: z.string(), profile: z.enum(['index', 'quick', 'standard', 'deep']), model: z.string().optional(), max_success: z.number().int().min(1).optional(), max_cost_usd: z.number().min(0).optional(), reanalyse: z.boolean().optional(), confirm: z.literal(true) },
		annotations: { title: 'Create analysis job', readOnlyHint: false, destructiveHint: false, openWorldHint: true }
	}, guard(async (a: any) => {
		const r = await createBatch(resolveSelection({ scope: 'uids', uids: a.ids }), { provider: a.provider, profile: a.profile, model: a.model, maxSuccess: a.max_success, maxCostUsd: a.max_cost_usd, reanalyse: a.reanalyse, note: 'created via MCP' });
		runner.watch();
		return r;
	}));
	s.registerTool('cancel_analysis_job', { description: 'Cancel an analysis (analysis uid).', inputSchema: { uid: z.string() }, annotations: { title: 'Cancel analysis', ...w, idempotentHint: true } }, guard((a: any) => (cancelAnalysis(a.uid), { ok: true })));
	return s;
}

function fail(m: string): never {
	throw new Error(m);
}

async function thumb(uid: string): Promise<string> {
	const v = videoAbsByUid(uid) ?? fail('video not found');
	const p = (await ensureThumbnail(getDb(), v)) ?? fail('thumbnail unavailable');
	return readFileSync(p ?? thumbFile(uid)).toString('base64');
}

export async function runMcpStdio() {
	const write = process.env.VIE_MCP_READONLY !== '1';
	const server = buildMcpServer({ write, transport: 'stdio' });
	await server.connect(new StdioServerTransport());
	process.stderr.write(`[visual-intelligence mcp] stdio ready (${write ? 'read+write' : 'read-only'}); database ${getDb().path}\n`);
	await new Promise<void>((res) => process.stdin.on('close', res));
}
