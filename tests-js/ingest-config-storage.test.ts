import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDb } from '../core/db.ts';
import { appendBlob, blobOffset, haveBlobs, ingestSession } from '../core/ingest.ts';
import { pairCollector, verifyCollectorToken, revokeCollector } from '../core/collectors.ts';
import { COLLECTOR_KEYS, readCollectorConfig, writeCollectorConfig } from '../core/collectorConfig.ts';
import { executeCleanup, planCleanup } from '../core/storage.ts';
import { thumbsDir } from '../core/paths.ts';
import { getSettings, setSettings } from '../core/settings.ts';
import { listVideos } from '../core/videos.ts';
import { entry, tmp } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('remote collector ingest', () => {
	const data = Buffer.alloc(300_000, 3);
	const h = sha(data);

	it('pairs a collector; token works once issued, dies when revoked; only the hash is stored', () => {
		const { id, token } = pairCollector('desktop');
		expect(verifyCollectorToken(token)).toBe(id);
		expect(getDb().value('SELECT token_hash FROM collectors WHERE id=?', id)).not.toContain(token);
		expect(verifyCollectorToken('vic_wrong')).toBeNull();
		revokeCollector(id);
		expect(verifyCollectorToken(token)).toBeNull();
	});

	it('resumes interrupted uploads, rejects offset gaps, and discards corrupt data', async () => {
		expect(haveBlobs([h]).missing).toEqual([h]);
		expect((await appendBlob(h, 0, data.subarray(0, 100_000), null)).received).toBe(100_000);
		expect(blobOffset(h)).toBe(100_000);
		await expect(appendBlob(h, 50, data.subarray(0, 10), null)).rejects.toMatchObject({ status: 409, received: 100_000 });
		await appendBlob(h, 100_000, data.subarray(100_000, 200_000), null);
		const r = await appendBlob(h, 200_000, data.subarray(200_000), { size: data.length });
		expect(r.complete).toBe(true);
		expect(haveBlobs([h]).have).toEqual([h]);
		expect(blobOffset(h)).toBe(-1);
		// idempotent re-upload
		expect((await appendBlob(h, 0, data, { size: data.length })).complete).toBe(true);
		// corrupt: right size, wrong bytes -> discarded, never visible
		const bad = Buffer.alloc(1000, 9);
		const fake = sha(Buffer.alloc(1000, 1));
		await expect(appendBlob(fake, 0, bad, { size: 1000 })).rejects.toMatchObject({ status: 422 });
		expect(haveBlobs([fake]).missing).toEqual([fake]);
		expect(blobOffset(fake)).toBe(0);
	});

	it('ingests a session, refuses entries whose media was not uploaded, and supports metadata-only sync', () => {
		const db = getDb();
		const e = entry('INGEST0001', { sha256: h, file: 'videos/0001.mp4', bytes: data.length });
		const missing = entry('INGEST0002', { sha256: 'e'.repeat(64) });
		expect(() => ingestSession(db, 'col_x', { session: { id: '2026-10-20_0900', status: 'completed' }, videos: [missing] })).toThrow(/not on the server|not been uploaded/);
		const r = ingestSession(db, 'col_x', { session: { id: '2026-10-20_0900', status: 'running' }, videos: [e] });
		expect(r.session).toBe('col_x/2026-10-20_0900');
		const v: any = db.get(`SELECT download_status, rel_path, file_size FROM videos WHERE platform_id='INGEST0001'`);
		expect(v.download_status).toBe('downloaded');
		expect(existsSync(join(db.value<string>(`SELECT path FROM media_roots WHERE kind='ingest'`)!, v.rel_path))).toBe(true);
		expect(db.value(`SELECT status FROM sessions WHERE id='col_x/2026-10-20_0900'`)).toBe('interrupted'); // a 'running' push is never trusted
		expect(db.value(`SELECT origin FROM sessions WHERE id='col_x/2026-10-20_0900'`)).toBe('col_x');
		ingestSession(db, 'col_x', { session: { id: '2026-10-20_0900', status: 'completed' }, videos: [e] });
		expect(db.value(`SELECT COUNT(*) FROM videos WHERE platform_id='INGEST0001'`)).toBe(1); // no duplicate
		ingestSession(db, 'col_y', { session: { id: '2026-10-20_1000', status: 'completed' }, videos: [entry('REMOTE0001', { sha256: 'd'.repeat(64) })], metadataOnly: true });
		expect(db.value(`SELECT download_status FROM videos WHERE platform_id='REMOTE0001'`)).toBe('remote');
		expect(listVideos({}).videos.some((x) => x.platform_id === 'REMOTE0001')).toBe(false); // not playable here, so not in the default library
	});
});

describe('collector config editing', () => {
	it('changes only whitelisted keys, preserves comments and unknown content, validates ranges', () => {
		const cfg = process.env.VIE_CONFIG!;
		writeFileSync(cfg, `# my notes\n[collector]\nmode = "fast"   # keep fast\ndownload_workers = 2\nsecret_thing = "x"\n\n[llm]\nmodel = "q"\n`);
		const w = writeCollectorConfig({ 'collector.download_workers': 3, 'browser.max_tabs': 2, 'limits.stop_on_gpu_driver_errors': false });
		const t = readFileSync(cfg, 'utf8');
		expect(t).toContain('# my notes');
		expect(t).toContain('mode = "fast"   # keep fast');
		expect(t).toContain('download_workers = 3');
		expect(t).toContain('secret_thing = "x"');
		expect(t).toContain('[browser]\nmax_tabs = 2');
		expect(t).toContain('[limits]\nstop_on_gpu_driver_errors = false');
		expect(w.fields.find((f: any) => f.key === 'download_workers')!.value).toBe(3);
		expect(() => writeCollectorConfig({ 'collector.download_workers': 99 })).toThrow(/1\.\.4/);
		expect(() => writeCollectorConfig({ 'llm.model': 'evil' })).toThrow(/cannot be changed/);
	});
	it('key set matches the Python resource limits', () => {
		const py = readFileSync(join(__dirname, '..', 'vie', 'resources.py'), 'utf8');
		const block = py.slice(py.indexOf('LIMIT_DEFAULTS = {'), py.indexOf('}', py.indexOf('LIMIT_DEFAULTS = {')));
		for (const k of COLLECTOR_KEYS.filter((k) => k.section === 'limits')) expect(block).toContain(`"${k.key}"`);
	});
	it('reads defaults when the file is absent', () => {
		expect(readCollectorConfig().fields.length).toBe(COLLECTOR_KEYS.length);
	});
});

describe('settings & cleanup safety', () => {
	it('validates settings', () => {
		expect(() => setSettings({ analysis: { concurrency: 99 } })).toThrow(/concurrency/);
		expect(getSettings().analysis.concurrency).toBe(1);
		expect(setSettings({ media: { thumbWidth: 400 } }).media.thumbWidth).toBe(400);
	});
	it('cleanup needs the exact plan + typed confirmation and only deletes inside managed folders', () => {
		mkdirSync(thumbsDir(), { recursive: true });
		writeFileSync(join(thumbsDir(), 'a.jpg'), 'x');
		writeFileSync(join(thumbsDir(), 'b.jpg'), 'y');
		const outside = join(tmp(), 'precious.txt');
		writeFileSync(outside, 'keep');
		const plan = planCleanup('thumbnails');
		const n = plan.fileCount;
		expect(n).toBeGreaterThanOrEqual(2);
		expect(() => executeCleanup(plan.id, 'yes')).toThrow(/exactly/);
		expect(() => executeCleanup('bogus', 'delete ' + n)).toThrow(/unknown or expired/);
		expect(existsSync(join(thumbsDir(), 'a.jpg'))).toBe(true);
		expect(executeCleanup(plan.id, 'delete ' + n).removed).toBe(n);
		expect(existsSync(outside)).toBe(true);
	});
});
