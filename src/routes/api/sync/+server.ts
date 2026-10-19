import { json } from '@sveltejs/kit';
import { syncSessions, lastImport } from '#lib/server/app.ts';

export const GET = () => json(lastImport);
export const POST = async ({ url }) => json(syncSessions(url.searchParams.has('force')));
