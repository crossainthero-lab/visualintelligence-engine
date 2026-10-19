import { json } from '@sveltejs/kit';
import { detectProviders } from '#core/analysis/providers/index.ts';
import { profileList } from '#core/analysis/profiles.ts';

export const GET = async ({ url }) => json({ providers: await detectProviders(url.searchParams.has('refresh')), profiles: profileList() });
