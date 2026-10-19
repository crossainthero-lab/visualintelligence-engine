import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DB, migrate, openMemoryDb } from '../core/db.ts';
import { migrations } from '../core/migrations/index.ts';
import { importSessions } from '../core/importer.ts';
import { listVideos } from '../core/videos.ts';
import { getSession, listSessions, sessionVideos } from '../core/sessions.ts';
import { overview } from '../core/stats.ts';
import { entry, makeSessions, tmp } from './helpers.ts';

let db: DB;
beforeEach(() => {
	db = openMemoryDb();
});

describe('migrations', () => {
	it('creates a fresh schema with foreign keys on', () => {
		expect(db.value('SELECT COUNT(*) FROM schema_migrations')).toBe(migrations.length);
		expect(db.value('PRAGMA foreign_keys')).toBe(1);
		expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
	});
	it('is idempotent', () => {
		expect(migrate(db).applied).toEqual([]);
	});
	it('rolls back a failing migration completely', () => {
		const d = new DB(':memory:');
		migrations.push({ version: 999, name: 'bad', sql: 'CREATE TABLE ok_before(a); CREATE TABLE ok_before(a);' });
		try {
			expect(() => migrate(d, { backup: false })).toThrow();
		} finally {
			migrations.pop();
		}
		expect(d.get(`SELECT name FROM sqlite_master WHERE name='ok_before'`)).toBeUndefined();
		expect(d.value('SELECT COUNT(*) FROM schema_migrations WHERE version=999')).toBe(0);
	});
});

describe('import from Scroll Sessions', () => {
	it('imports sessions, dedupes videos across sessions and keeps provenance', () => {
		const root = tmp();
		makeSessions(root, [
			{ id: '2026-10-19_1000', entries: [entry('AAAAA11111'), entry('BBBBB22222', { file: 'videos/0002.mp4', source: { kind: 'saved', collection: 'All posts' } })], files: { '0001.mp4': 100, '0002.mp4': 200 } },
			{ id: '2026-10-19_1100', entries: [entry('AAAAA11111', { status: 'duplicate', file: undefined }), entry('CCCCC33333', { status: 'skipped', file: undefined })] }
		]);
		const r = importSessions(db, root);
		expect(r.sessionsImported).toBe(2);
		expect(r.videosTotal).toBe(3);
		expect(r.filesOnDisk).toBe(2);
		expect(listVideos({}, db).total).toBe(2); // downloaded only by default
		expect(listVideos({ downloadStatus: 'all' }, db).total).toBe(3);
		const a: any = db.get(`SELECT provenance_json FROM videos WHERE platform_id='AAAAA11111'`);
		expect(JSON.parse(a.provenance_json).map((p: any) => p.session)).toEqual(['2026-10-19_1000', '2026-10-19_1100']);
		expect(db.value(`SELECT COUNT(*) FROM session_videos WHERE video_id=(SELECT id FROM videos WHERE platform_id='AAAAA11111')`)).toBe(2);
		const s = getSession('2026-10-19_1100', db)!;
		expect(s.duplicates).toBe(1);
		expect(sessionVideos('2026-10-19_1100', {}, db).total).toBe(2);
	});

	it('is incremental and idempotent; never duplicates rows', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', entries: [entry('AAAAA11111')], files: { '0001.mp4': 10 } }]);
		importSessions(db, root);
		const again = importSessions(db, root);
		expect(again.sessionsUnchanged).toBe(1);
		expect(importSessions(db, root, { force: true }).videosTotal).toBe(1);
		expect(db.value('SELECT COUNT(*) FROM session_videos')).toBe(1);
	});

	it('flags crashed sessions as incomplete instead of inventing an end time', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', info: { status: 'running', ended_at: null, pid: 99999999 }, entries: [entry('AAAAA11111'), entry('BBBBB22222', { status: 'downloading', file: undefined })], files: { '0001.mp4': 10 } }]);
		importSessions(db, root);
		const s = getSession('2026-10-19_1000', db)!;
		expect(s.status).toBe('interrupted');
		expect(s.incomplete).toBe(true);
		expect(s.recovered).toBe(true);
		expect(s.incomplete_reason).toMatch(/crash|kill|freeze/);
		expect(db.value(`SELECT download_status FROM videos WHERE platform_id='BBBBB22222'`)).toBe('queued');
	});

	it('marks missing and zero-byte files instead of trusting metadata', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', entries: [entry('AAAAA11111'), entry('BBBBB22222', { file: 'videos/0002.mp4' }), entry('CCCCC33333', { file: 'videos/0003.mp4' })], files: { '0001.mp4': 10, '0002.mp4': 0 } }]);
		const r = importSessions(db, root);
		expect(r.filesMissing).toBe(2);
		expect(listVideos({}, db).total).toBe(1);
		expect(overview({}, db).totals.missingFiles).toBe(2);
	});

	it('reports orphan files without touching them', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', entries: [entry('AAAAA11111')], files: { '0001.mp4': 10, '0099.mp4': 5 } }]);
		expect(importSessions(db, root).orphanFiles).toEqual(['2026-10-19_1000/videos/0099.mp4']);
	});

	it('survives invalid / truncated metadata', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', entries: [entry('AAAAA11111')], files: { '0001.mp4': 10 } }]);
		mkdirSync(join(root, '2026-10-19_1200', 'videos'), { recursive: true });
		writeFileSync(join(root, '2026-10-19_1200', 'metadata.json'), '{"videos": [{"id": "X"');
		writeFileSync(join(root, '2026-10-19_1200', 'session.json'), 'not json');
		const r = importSessions(db, root);
		expect(r.sessionsImported).toBe(2);
		expect(getSession('2026-10-19_1200', db)!.incomplete).toBe(true);
		expect(listVideos({}, db).total).toBe(1);
	});

	it('links identical content under different ids without merging them', () => {
		const root = tmp();
		makeSessions(root, [{ id: '2026-10-19_1000', entries: [entry('AAAAA11111', { sha256: 'f'.repeat(64) }), entry('BBBBB22222', { sha256: 'f'.repeat(64), file: 'videos/0002.mp4' })], files: { '0001.mp4': 10, '0002.mp4': 10 } }]);
		importSessions(db, root);
		expect(db.value('SELECT COUNT(*) FROM videos')).toBe(2);
		expect(db.value('SELECT COUNT(*) FROM videos WHERE content_dup_of IS NOT NULL')).toBe(1);
	});
});

describe('queries at scale', () => {
	it('filters and pages a 60k-video library quickly', () => {
		db.exec(`INSERT INTO creators(username) SELECT 'c' || value FROM (WITH RECURSIVE c(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM c WHERE value<500) SELECT value FROM c)`);
		db.tx(() => {
			const st = db.raw.prepare(`INSERT INTO videos(uid,platform_id,creator_id,caption,first_collected_at,file_size,duration_s,width,height,download_status,analysis_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'downloaded', ?, 'x','x')`);
			for (let i = 0; i < 60000; i++) st.run(`v_${i}`, `P${i}`, 1 + (i % 500), `clip ${i} motion`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, 1000 + i, 5 + (i % 60), 1080, 1920, i % 7 === 0 ? 'analysed' : 'none');
		});
		const t0 = performance.now();
		const a = listVideos({ q: 'motion', analysis: 'analysed', sort: 'size', limit: 60, offset: 3000 }, db);
		const b = listVideos({ creator: 'c42', minDuration: 20, limit: 50 }, db);
		const ms = performance.now() - t0;
		expect(a.total).toBe(Math.ceil(60000 / 7));
		expect(a.videos).toHaveLength(60);
		expect(b.total).toBeGreaterThan(0);
		expect(ms).toBeLessThan(1500);
		expect(listSessions({}, db).total).toBe(0);
	});
});
