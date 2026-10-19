import { getDb } from '#core/db.ts';
import { collectorState } from '#core/system.ts';

export const load = () => {
	const db = getDb();
	return {
		videos: db.value<number>(`SELECT COUNT(*) FROM videos WHERE download_status='downloaded'`) ?? 0,
		sessions: db.value<number>('SELECT COUNT(*) FROM sessions') ?? 0,
		activeJobs: db.value<number>(`SELECT COUNT(*) FROM analyses WHERE status IN ('queued','preparing','running')`) ?? 0,
		collector: collectorState(),
		authRequired: !!process.env.VIE_AUTH_TOKEN
	};
};
