import { createReadStream, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getDb } from '#core/db.ts';
import { tmpDir } from '#core/paths.ts';

// A consistent snapshot of the database (SQLite VACUUM INTO) — safe while the app is running.
export const GET = () => {
	const out = join(tmpDir(), `backup-${Date.now()}.sqlite`);
	getDb().exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
	const stream = createReadStream(out);
	stream.on('close', () => rmSync(out, { force: true }));
	return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { 'content-type': 'application/vnd.sqlite3', 'content-length': String(statSync(out).size), 'content-disposition': `attachment; filename="vie-backup-${new Date().toISOString().slice(0, 10)}.sqlite"` } });
};
