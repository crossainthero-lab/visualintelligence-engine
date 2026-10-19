import { json } from '@sveltejs/kit';
export const GET = ({ locals }) => json({ ok: true, collector: locals.collectorId, server: 'visual-intelligence', api: 1 });
