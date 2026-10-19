import { json } from '@sveltejs/kit';
import { GROUPS, RESEARCH_AREAS, TAXONOMY_VERSION, allTerms } from '#core/taxonomy.ts';
import { allTags } from '#core/videos.ts';

export const GET = () => json({ version: TAXONOMY_VERSION, terms: allTerms(), groups: Object.keys(GROUPS), areas: RESEARCH_AREAS, tags: allTags() });
