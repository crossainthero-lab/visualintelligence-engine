// Server side of remote collection. A collector machine (the desktop) pushes finished videos and session records
// to this server. Transfers are content-addressed (sha256), resumable, idempotent and verified before they become
// visible, so interrupted uploads can never corrupt the library and the same file is never stored twice.
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { getDb, now } from './db.ts';
import { importOne, type ImportReport } from './importer.ts';
import { mediaDir } from './paths.ts';

const SHA = /^[0-9a-f]{64}$/;
const root = () => {
	const d = join(mediaDir(), 'ingest');
	mkdirSync(d, { recursive: true });
	return d;
};
export const blobRel = (sha: string, ext = 'mp4') => `${sha.slice(0, 2)}/${sha}.${ext}`;
const blobPath = (sha: string) => join(root(), blobRel(sha));
const partPath = (sha: string) => join(root(), `${sha.slice(0, 2)}`, `${sha}.part`);

export function haveBlobs(shas: string[]): { have: string[]; missing: string[] } {
	const have: string[] = [];
	const missing: string[] = [];
	for (const s of shas.slice(0, 5000)) {
		if (!SHA.test(s)) throw new Error('invalid sha256');
		(existsSync(blobPath(s)) ? have : missing).push(s);
	}
	return { have, missing };
}

/** Bytes already received for an in-progress upload (the client resumes from here). */
export function blobOffset(sha: string): number {
	if (!SHA.test(sha)) throw new Error('invalid sha256');
	if (existsSync(blobPath(sha))) return -1; // complete
	return existsSync(partPath(sha)) ? statSync(partPath(sha)).size : 0;
}

export async function appendBlob(sha: string, offset: number, chunk: Buffer, final: { size: number } | null): Promise<{ received: number; complete: boolean }> {
	if (!SHA.test(sha)) throw new Error('invalid sha256');
	if (existsSync(blobPath(sha))) return { received: statSync(blobPath(sha)).size, complete: true };
	const part = partPath(sha);
	mkdirSync(join(root(), sha.slice(0, 2)), { recursive: true });
	const cur = existsSync(part) ? statSync(part).size : 0;
	if (offset !== cur) throw Object.assign(new Error(`offset mismatch: server has ${cur} bytes`), { status: 409, received: cur });
	if (chunk.length > 16 * 1024 * 1024) throw new Error('chunk too large (max 16 MB)');
	appendFileSync(part, chunk);
	const received = cur + chunk.length;
	if (!final) return { received, complete: false };
	if (received !== final.size) throw Object.assign(new Error(`size mismatch: have ${received}, expected ${final.size}`), { status: 409, received });
	const h = createHash('sha256');
	await new Promise<void>((res, rej) => createReadStream(part).on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej));
	if (h.digest('hex') !== sha) {
		rmSync(part, { force: true }); // corrupt transfer: start over, never keep bad bytes
		throw Object.assign(new Error('sha256 mismatch after upload; discarded, retry from 0'), { status: 422, received: 0 });
	}
	const fd = openSync(part, 'r');
	try {
		(await import('node:fs')).fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(part, blobPath(sha));
	return { received, complete: true };
}

/** Upsert a collector's session (+ its videos). Media referenced by sha256 must already be uploaded unless metadataOnly. */
export function ingestSession(db: DB, collectorId: string, payload: { session: any; videos: any[]; metadataOnly?: boolean }) {
	const info = payload.session ?? {};
	const entries: any[] = payload.videos ?? [];
	const rawId = String(info.id ?? '');
	if (!/^[\w.-]{3,64}$/.test(rawId)) throw new Error('session.id missing or invalid');
	const sid = `${collectorId}/${rawId}`;
	const metadataOnly = !!payload.metadataOnly;
	const problems: string[] = [];
	for (const e of entries) {
		if (e.status === 'downloaded' && !metadataOnly) {
			if (!SHA.test(e.sha256 ?? '')) problems.push(`${e.id}: downloaded entry without sha256`);
			else if (!existsSync(blobPath(e.sha256))) problems.push(`${e.id}: blob ${e.sha256.slice(0, 12)} has not been uploaded`);
		}
	}
	if (problems.length) throw Object.assign(new Error(`${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} reference media not on the server: ${problems.slice(0, 3).join('; ')}`), { status: 409, problems });
	db.run('INSERT INTO media_roots(path,label,kind) VALUES (?,?,?) ON CONFLICT(path) DO NOTHING', root(), 'Ingested media', 'ingest');
	const rootId = db.value<number>('SELECT id FROM media_roots WHERE path=?', root())!;
	const rep = { warnings: [] as string[], videosNew: 0 } as unknown as ImportReport;
	const stamp = `push:${now()}`;
	db.tx(() => importOne(db, rootId, sid, '', { ...info, id: sid, status: info.status === 'running' ? 'interrupted' : info.status }, { videos: entries }, stamp, rep, {
		origin: collectorId,
		relFor: (e) => (e.sha256 ? blobRel(e.sha256) : null),
		remoteOnly: metadataOnly
	}));
	return { session: sid, entries: entries.length, newVideos: rep.videosNew, warnings: rep.warnings };
}

export { getDb };
