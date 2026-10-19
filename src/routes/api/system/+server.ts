import { json } from '@sveltejs/kit';
import { systemSnapshot } from '#core/system.ts';

export const GET = async () => json(await systemSnapshot());
