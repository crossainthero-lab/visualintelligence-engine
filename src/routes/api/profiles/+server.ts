import { json } from '@sveltejs/kit';
import { profileList } from '#core/analysis/profiles.ts';

export const GET = () => json({ profiles: profileList() });
