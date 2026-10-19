import { createHash, randomBytes } from 'node:crypto';
import { getDb, now } from './db.ts';

const h = (t: string) => createHash('sha256').update(t).digest('hex');

/** Creates a collector credential. The token is shown once; only its hash is stored. */
export function pairCollector(name: string): { id: string; token: string } {
	const id = 'col_' + randomBytes(5).toString('hex');
	const token = 'vic_' + randomBytes(24).toString('base64url');
	getDb().run('INSERT INTO collectors(id,name,token_hash,created_at) VALUES (?,?,?,?)', id, name, h(token), now());
	return { id, token };
}

export function verifyCollectorToken(token: string): string | null {
	if (!token.startsWith('vic_')) return null;
	const db = getDb();
	const r = db.get<{ id: string }>('SELECT id FROM collectors WHERE token_hash=? AND revoked=0', h(token));
	if (!r) return null;
	db.run('UPDATE collectors SET last_seen_at=? WHERE id=?', now(), r.id);
	return r.id;
}

export const listCollectors = () => getDb().all('SELECT id,name,created_at,last_seen_at,revoked FROM collectors ORDER BY created_at');
export const revokeCollector = (id: string) => getDb().run('UPDATE collectors SET revoked=1 WHERE id=?', id).changes;
