import { getDb } from '#core/db.ts';
import { exportResearch } from '#core/export.ts';

export const GET = ({ url }) => {
	const fmt = (url.searchParams.get('format') ?? 'json') as 'json' | 'jsonl' | 'csv';
	const body = exportResearch(getDb(), { format: fmt, onlyAnalysed: url.searchParams.get('all') !== '1' });
	const type = fmt === 'csv' ? 'text/csv' : fmt === 'jsonl' ? 'application/x-ndjson' : 'application/json';
	return new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="visual-intelligence-research.${fmt}"` } });
};
