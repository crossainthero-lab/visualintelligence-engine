import { json } from '@sveltejs/kit';
import { findDuplicates, findOrphans, storageReport } from '#core/storage.ts';

export const GET = ({ url }) => {
	const r: any = storageReport();
	if (url.searchParams.get('inspect')) {
		r.orphans = findOrphans();
		r.duplicates = findDuplicates();
	}
	return json(r);
};
