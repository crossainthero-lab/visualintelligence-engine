import { json } from '@sveltejs/kit';
import { overview } from '#core/stats.ts';

export const GET = ({ url }) => json(overview({ from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined }));
