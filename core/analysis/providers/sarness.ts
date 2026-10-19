import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../exec.ts';
import { repoRoot } from '../../paths.ts';
import { getSettings } from '../../settings.ts';
import type { Provider, ProviderInfo, ProviderRequest, ProviderResponse } from '../types.ts';
import { extractJson } from './common.ts';

// Sarness = the user's own self-hosted inference server (remote GPU box). This adapter only talks to its documented
// HTTP API (docs/API.md in the Sarness repo): /v1/health, /v1/llm/models, /v1/uploads, /v1/chat/conversations/*.
// No model is loaded or downloaded on THIS machine; the request is processed on the Sarness host.

interface Conn {
	base: string;
	token: string;
	profile: string;
	source: string;
}

function profiles(): any | null {
	try {
		return JSON.parse(readFileSync(join(homedir(), '.config', 'sarness', 'profiles.json'), 'utf8'));
	} catch {
		return null;
	}
}

async function readToken(profileId: string): Promise<{ token: string; source: string }> {
	if (process.env.VIE_SARNESS_TOKEN) return { token: process.env.VIE_SARNESS_TOKEN.trim(), source: 'VIE_SARNESS_TOKEN' };
	const file = process.env.VIE_SARNESS_TOKEN_FILE ?? join(homedir(), '.config', 'visualintelligence', 'sarness.token');
	if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), source: file };
	// Reuse the token Sarness Desktop already keeps in the OS keyring (service "sarness"); never written anywhere.
	const py = join(repoRoot(), '.venv', 'bin', 'python');
	const code = 'import sys,keyring;print(keyring.get_password("sarness",sys.argv[1]) or "")';
	for (const cmd of [existsSync(py) ? [py, '-I', '-c', code, profileId] : null, ['python3', '-I', '-c', code, profileId]]) {
		if (!cmd) continue;
		const r = await run(cmd[0], cmd.slice(1), { timeoutMs: 15_000 });
		if (r.code === 0 && r.stdout.trim()) return { token: r.stdout.trim(), source: 'OS keyring (Sarness Desktop entry)' };
	}
	return { token: '', source: 'none' };
}

export async function sarnessConn(): Promise<Conn | null> {
	const st = getSettings().sarness;
	const p = profiles();
	const prof = p?.profiles?.find((x: any) => x.id === p.active || x.name === st.profile) ?? p?.profiles?.[0];
	const base = (st.endpoint || (prof ? `${prof.scheme ?? 'http'}://${prof.host}:${prof.port}` : st.host ? `http://${st.host}:8742` : "")).replace(/\/$/, '');
	if (!base) return null;
	const { token, source } = await readToken(prof?.id ?? '');
	return { base, token, profile: prof?.name ?? '(none)', source };
}

async function api(c: Conn, path: string, init: RequestInit = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	signal?.addEventListener('abort', () => ac.abort(), { once: true });
	try {
		return await fetch(c.base + path, { ...init, headers: { ...(init.headers as any), Authorization: `Bearer ${c.token}` }, signal: ac.signal });
	} finally {
		clearTimeout(t);
	}
}

export interface SarnessModel {
	id: string;
	name?: string;
	vision?: boolean;
	loaded?: boolean;
	raw: any;
}

export async function sarnessModels(c: Conn): Promise<SarnessModel[]> {
	const r = await api(c, '/v1/llm/models');
	if (!r.ok) throw new Error(`/v1/llm/models → HTTP ${r.status}`);
	const j: any = await r.json();
	const list: any[] = Array.isArray(j) ? j : (j.models ?? j.data ?? []);
	return list.map((m) => ({ id: m.ref ?? m.id ?? m.model_ref ?? m.name, name: m.name ?? m.label, vision: m.vision ?? m.capabilities?.vision ?? m.meta?.vision, loaded: m.loaded, raw: m }));
}

export const sarness: Provider = {
	id: 'sarness',
	async detect(): Promise<ProviderInfo> {
		const s = getSettings().analysis.providers.sarness;
		const base: ProviderInfo = {
			id: 'sarness', label: 'Sarness (remote GPU server)', kind: 'http', available: false, authenticated: null, models: [],
			supports: { images: true, video: false, structured: false }, detail: '', verified: 'unverified', remote: true,
			pricing: { known: true, note: 'Self-hosted: no per-call price. Latency and GPU use are measured per run.' }
		};
		if (s?.enabled === false) return { ...base, detail: 'disabled in Settings' };
		const c = await sarnessConn();
		if (!c) return { ...base, detail: 'no Sarness profile found' };
		try {
			const h = await api(c, '/v1/health', {}, 6000);
			if (!h.ok) return { ...base, detail: `${c.base} answered HTTP ${h.status}` };
			const hj: any = await h.json().catch(() => ({}));
			if (!c.token) return { ...base, detail: `${c.base} is up (api ${hj.api_version ?? '?'}), but no API token was found (set VIE_SARNESS_TOKEN or ~/.config/visualintelligence/sarness.token, or use Sarness Desktop's keyring entry)` };
			let models: SarnessModel[] = [];
			try {
				models = await sarnessModels(c);
			} catch (e: any) {
				return { ...base, available: false, authenticated: false, detail: `${c.base} up, token rejected or models unreadable: ${e.message}` };
			}
			const vis = models.filter((m) => m.vision);
			return {
				...base, available: vis.length > 0, authenticated: true, models: models.map((m) => m.id), defaultModel: s?.model || vis[0]?.id,
				supports: { images: vis.length > 0, video: false, structured: false },
				detail: `${c.base} is reachable and the token works (profile ${c.profile}, token from ${c.source}). ${models.length} chat model(s): ${models.map((m) => m.id.replace(/^endpoint:[^:]+:/, '')).join(', ')}. ` +
					(vis.length ? `${vis.length} report vision support.` : 'None reports vision support, so frame-based analysis is unavailable until you load a vision model on the server (analysis never fakes it).'),
				verified: 'unverified'
			};
		} catch (e: any) {
			return { ...base, detail: `${c.base} unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
		}
	},

	async run(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
		const s = getSettings().analysis.providers.sarness;
		const c = await sarnessConn();
		if (!c?.token) throw new Error('Sarness: no API token available');
		const t0 = Date.now();
		const models = await sarnessModels(c);
		const modelRef = req.model || s?.model || models.find((m) => m.vision)?.id;
		if (!modelRef) throw new Error('Sarness: no vision-capable model reported by the server');
		// 1. upload frames
		const ids: string[] = [];
		for (const img of req.images) {
			const fd = new FormData();
			fd.append('file', new Blob([readFileSync(img)], { type: 'image/jpeg' }), img.split('/').pop()!);
			const r = await api(c, '/v1/uploads', { method: 'POST', body: fd }, 60_000, signal);
			if (!r.ok) throw new Error(`Sarness upload failed: HTTP ${r.status}`);
			ids.push(((await r.json()) as any).id);
		}
		// 2. a throwaway conversation (deleted afterwards)
		const cr = await api(c, '/v1/chat/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'visualintelligence analysis (temporary)', model_ref: modelRef, params: { temperature: 0.2, max_tokens: 3500, thinking: false } }) }, 20_000, signal);
		if (!cr.ok) throw new Error(`Sarness: could not create conversation (HTTP ${cr.status})`);
		const conv: any = await cr.json();
		const convId = conv.id ?? conv.conversation?.id;
		try {
			const gr = await api(c, `/v1/chat/conversations/${convId}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'send', content: req.prompt, attachments: ids, web_search: false }) }, req.timeoutMs, signal);
			if (!gr.ok || !gr.body) throw new Error(`Sarness generate failed: HTTP ${gr.status}`);
			let text = '';
			let stats: any = null;
			let err = '';
			const reader = gr.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const l of lines) {
					if (!l.startsWith('data:')) continue;
					try {
						const ev = JSON.parse(l.slice(5).trim());
						if (ev.type === 'delta') text += ev.content ?? '';
						else if (ev.type === 'error') err = ev.message;
						else if (ev.type === 'done') stats = ev.message?.stats ?? null;
					} catch {
						/* partial line */
					}
				}
			}
			if (err) throw new Error(`Sarness: ${err}`);
			return {
				text, json: extractJson(text), model: modelRef,
				usage: { costUsd: 0, inputTokens: stats?.prompt_tokens, outputTokens: stats?.completion_tokens, ms: Date.now() - t0, remote: true, extra: { tokens_per_s: stats?.tokens_per_s, ttft_s: stats?.ttft_s, elapsed_s: stats?.elapsed_s, finish_reason: stats?.finish_reason, server: c.base } }
			};
		} finally {
			await api(c, `/v1/chat/conversations/${convId}`, { method: 'DELETE' }, 10_000).catch(() => {});
		}
	}
};
