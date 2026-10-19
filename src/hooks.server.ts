import type { Handle } from '@sveltejs/kit/hooks';
import { json, redirect } from '@sveltejs/kit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureReady } from '#lib/server/app.ts';
import { verifyCollectorToken } from '#lib/server/auth.ts';

const COOKIE = 'vie_session';

function authToken(): string | null {
	return process.env.VIE_AUTH_TOKEN?.trim() || null;
}
const sign = (t: string) => createHmac('sha256', t).update('vie-session-v1').digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Boot in the background so the first request is not delayed by the import; handlers await readiness where needed.
void ensureReady();

export const handle: Handle = async ({ event, resolve }) => {
	await ensureReady();
	event.locals.actor = 'ui';
	const { pathname } = event.url;
	const token = authToken();

	if (pathname === '/api/health') return resolve(event); // liveness only, no data

	// Paired collector machines authenticate with their own bearer token and may only use /api/ingest/*
	const bearer = event.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
	if (pathname.startsWith('/api/ingest/')) {
		const c = bearer ? verifyCollectorToken(bearer) : null;
		if (!c) return json({ error: 'collector token required (pair with `visualintelligence collectors pair`)' }, { status: 401 });
		event.locals.actor = 'collector';
		event.locals.collectorId = c;
		return resolve(event);
	}

	if (pathname === '/mcp') {
		const t = process.env.VIE_MCP_TOKEN?.trim();
		if (!t) return json({ error: 'remote MCP is disabled: set VIE_MCP_TOKEN on the server to enable it' }, { status: 403 });
		if (!bearer || !eq(bearer, t)) return json({ error: 'bearer token required' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
		return resolve(event);
	}

	if (token) {
		const cookie = event.cookies.get(COOKIE);
		const ok = (cookie && eq(cookie, sign(token))) || (bearer && eq(bearer, token));
		if (!ok && pathname !== '/login') {
			if (pathname.startsWith('/api/')) return json({ error: 'authentication required' }, { status: 401 });
			throw redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
		}
		if (pathname === '/login' && event.request.method === 'POST') {
			const form = await event.request.formData();
			if (eq(String(form.get('token') ?? ''), token)) {
				const next = String(form.get('next') || '/');
				const secure = event.url.protocol === 'https:' || event.request.headers.get('x-forwarded-proto') === 'https';
				const cookie = `${COOKIE}=${sign(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`;
				return new Response(null, { status: 303, headers: { location: next.startsWith('/') && !next.startsWith('//') ? next : '/', 'set-cookie': cookie } });
			}
			return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
		}
	}
	const res = await resolve(event);
	res.headers.set('x-content-type-options', 'nosniff');
	res.headers.set('referrer-policy', 'same-origin');
	res.headers.set('x-frame-options', 'SAMEORIGIN');
	return res;
};
