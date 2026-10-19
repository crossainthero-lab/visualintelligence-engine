// End-to-end against the PRODUCTION build (npm run build first). Spawns real servers on random ports.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entry, makeSessions, tmp } from './helpers.ts';

const root = join(__dirname, '..');
const procs: ChildProcess[] = [];
// undici strips the Origin header; the login form needs a real browser-like POST
const postForm = (base: string, path: string, fields: Record<string, string>) => new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((res, rej) => {
	const body = new URLSearchParams(fields).toString();
	const u = new URL(base + path);
	const r = http.request({ host: u.hostname, port: u.port, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), origin: base } }, (m) => (m.resume(), res({ status: m.statusCode!, headers: m.headers })));
	r.on('error', rej);
	r.end(body);
});
const free = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

async function start(env: Record<string, string>, dataDir: string, sessions: string) {
	const port = await free();
	const p = spawn('node', ['bin/start.mjs'], { cwd: root, env: { ...process.env, VIE_DATA_DIR: dataDir, VIE_DB_PATH: join(dataDir, 'vie.sqlite'), VIE_SESSIONS_DIR: sessions, VIE_PORT: String(port), VIE_HOST: '127.0.0.1', VIE_CONFIG: join(dataDir, 'c.toml'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	procs.push(p);
	let out = '';
	p.stdout!.on('data', (d) => (out += d));
	p.stderr!.on('data', (d) => (out += d));
	for (let i = 0; i < 80; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, base: `http://127.0.0.1:${port}`, p, out: () => out }; } catch { /* not yet */ }
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error('server did not start: ' + out);
}

let sessions = '';
beforeAll(() => {
	if (!existsSync(join(root, 'build', 'index.js'))) throw new Error('run `npm run build` first');
	sessions = tmp('vie-sess-');
	makeSessions(sessions, [{ id: '2026-10-19_1000', entries: ['AAAAA11111', 'BBBBB22222'].map((c, i) => entry(c, { file: `videos/000${i + 1}.mp4`, sha256: undefined })), files: {} }]);
	for (let i = 1; i <= 2; i++) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x568:r=24:d=2', '-pix_fmt', 'yuv420p', join(sessions, '2026-10-19_1000', 'videos', `000${i}.mp4`)]);
});
afterAll(() => procs.forEach((p) => p.kill('SIGTERM')));

describe('network safety', () => {
	it('refuses a non-loopback bind without auth or an explicit trusted-LAN opt-in', async () => {
		const r = await new Promise<{ code: number | null; out: string }>((res) => {
			const p = spawn('node', ['bin/start.mjs'], { cwd: root, env: { ...process.env, VIE_HOST: '0.0.0.0', VIE_PORT: '0', VIE_AUTH_TOKEN: '', VIE_TRUSTED_LAN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			p.stdout!.on('data', (d) => (out += d)); p.stderr!.on('data', (d) => (out += d));
			p.on('close', (code) => res({ code, out }));
		});
		expect(r.code).toBe(2);
		expect(r.out).toMatch(/Refusing to listen/);
	});
});

describe('local mode (no credentials)', () => {
	it('serves the library, streams with Range, edits, and never starts analysis by itself', async () => {
		const data = tmp('vie-data-');
		const s = await start({}, data, sessions);
		const ov: any = await (await fetch(s.base + '/api/overview')).json();
		expect(ov.totals.downloadedFiles).toBe(2);
		const list: any = await (await fetch(s.base + '/api/videos')).json();
		const uid = list.videos[0].uid;
		const full = await fetch(`${s.base}/api/videos/${uid}/stream`);
		expect(full.headers.get('accept-ranges')).toBe('bytes');
		const part = await fetch(`${s.base}/api/videos/${uid}/stream`, { headers: { range: 'bytes=0-99' } });
		expect(part.status).toBe(206);
		expect((await part.arrayBuffer()).byteLength).toBe(100);
		expect((await fetch(`${s.base}/api/videos/${uid}/stream`, { headers: { range: 'bytes=99999999-' } })).status).toBe(416);
		const th = await fetch(`${s.base}/api/videos/${uid}/thumb`);
		expect(th.headers.get('content-type')).toBe('image/jpeg');
		const p = await fetch(`${s.base}/api/videos/${uid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bookmarked: true, addTags: ['x'] }) });
		expect(((await p.json()) as any).bookmarked).toBe(true);
		expect(((await (await fetch(s.base + '/api/videos?bookmarked=1')).json()) as any).total).toBe(1);
		await new Promise((r) => setTimeout(r, 800));
		const jobs: any = await (await fetch(s.base + '/api/analysis')).json();
		expect(jobs.analyses).toEqual([]); // idle: selecting / bookmarking / browsing starts nothing
		expect((await fetch(s.base + '/api/analysis/batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selection: { scope: 'uids', uids: [uid] }, provider: 'claude', profile: 'nope' }) })).status).toBe(400);
		for (const path of ['/', '/library', '/sessions', '/sessions/2026-10-19_1000', '/analysis', '/storage', '/settings']) expect((await fetch(s.base + path)).status, path).toBe(200);
		expect((await fetch(s.base + '/api/videos/nope')).status).toBe(404);
		expect((await fetch(s.base + '/api/ingest/ping')).status).toBe(401); // collectors need their own token even locally
		expect((await fetch(s.base + '/mcp', { method: 'POST' })).status).toBe(403); // remote MCP off unless configured
		const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(s.p.pid)]).toString()) / 1024;
		expect(rss).toBeLessThan(250);
	});
});

describe('authenticated mode', () => {
	it('requires the token everywhere except /api/health', async () => {
		const s = await start({ VIE_AUTH_TOKEN: 'correct-horse-battery-staple-1234' }, tmp('vie-data-'), sessions);
		expect((await fetch(s.base + '/api/health')).status).toBe(200);
		expect((await fetch(s.base + '/api/overview')).status).toBe(401);
		expect((await fetch(s.base + '/api/videos')).status).toBe(401);
		const page = await fetch(s.base + '/library', { redirect: 'manual' });
		expect(page.status).toBe(303);
		expect(page.headers.get('location')).toMatch(/^\/login/);
		expect((await fetch(s.base + '/api/overview', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
		expect((await fetch(s.base + '/api/overview', { headers: { authorization: 'Bearer correct-horse-battery-staple-1234' } })).status).toBe(200);
		const bad = await postForm(s.base, '/login', { token: 'nope' });
		expect(bad.headers.location).toMatch(/error=1/);
		const ok = await postForm(s.base, '/login', { token: 'correct-horse-battery-staple-1234', next: '/library' });
		expect(ok.status).toBe(303);
		const cookie = (ok.headers['set-cookie'] as string[])[0];
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/SameSite=Strict/i);
		expect((await fetch(s.base + '/api/overview', { headers: { cookie: cookie.split(';')[0] } })).status).toBe(200);
	});
});

describe('remote MCP', () => {
	it('is token-gated, read-only by default, and speaks MCP over HTTP', async () => {
		const s = await start({ VIE_MCP_TOKEN: 'mcp-secret-token-0123456789' }, tmp('vie-data-'), sessions);
		const rpc = (body: any, token?: string) => fetch(s.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
		expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
		expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).status).toBe(401);
		await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, 'mcp-secret-token-0123456789');
		const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'mcp-secret-token-0123456789');
		const j: any = await r.json();
		const names = j.result.tools.map((t: any) => t.name);
		expect(names).toContain('list_videos');
		expect(names).not.toContain('create_analysis_job');
		expect(names).not.toContain('bookmark_videos');
		const c = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_overview', arguments: {} } }, 'mcp-secret-token-0123456789')).json() as any;
		expect(JSON.parse(c.result.content[0].text).downloadedFiles).toBe(2);
	});
});

describe('remote collector push (Python client → server)', () => {
	it('uploads files once, resumes, dedupes, and the library plays them', async () => {
		const data = tmp('vie-data-');
		const s = await start({}, data, join(data, 'none'));
		const tok = JSON.parse(execFileSync('node', ['bin/visualintelligence.mjs', 'collectors', 'pair', 'desk', '--json'], { cwd: root, env: { ...process.env, VIE_DATA_DIR: data, VIE_DB_PATH: join(data, 'vie.sqlite') } }).toString());
		const stateDir = tmp('vie-state-');
		const env = { ...process.env, VIE_SERVER: s.base, VIE_COLLECTOR_TOKEN: tok.token, VIE_SESSIONS_DIR: sessions, VIE_STATE_DIR: stateDir, VIE_CONFIG: join(stateDir, 'none.toml') };
		const py = join(root, '.venv', 'bin', 'python');
		const run = (...a: string[]) => execFileSync(py, ['-m', 'vie.push', ...a], { cwd: root, env }).toString();
		expect(run('--check')).toMatch(/connected/);
		expect(run('--files')).toMatch(/2 entries, 1 uploaded, 1 already on server/) /* the two test clips are byte-identical: stored once */;
		const list: any = await (await fetch(s.base + '/api/videos')).json();
		expect(list.total).toBe(2);
		const v = await fetch(`${s.base}/api/videos/${list.videos[0].uid}/stream`, { headers: { range: 'bytes=0-9' } });
		expect(v.status).toBe(206);
		expect(run('--files', '2026-10-19_1000')).toMatch(/0 uploaded, 2 already on server/);
		expect(run('--files')).not.toMatch(/uploaded|entries/); // nothing changed: no work, no output
		expect(((await (await fetch(s.base + '/api/videos')).json()) as any).total).toBe(2);
		const bad = await fetch(s.base + '/api/ingest/ping', { headers: { authorization: 'Bearer vic_nope' } });
		expect(bad.status).toBe(401);
	});
});
