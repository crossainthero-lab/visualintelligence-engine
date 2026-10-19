// SQLite access (node:sqlite, no native addon): WAL, foreign keys, busy timeout, migrations with pre-migration backup.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupsDir, dbPath } from './paths.ts';
import { migrations } from './migrations/index.ts';

export type Param = SQLInputValue;
export type Row = Record<string, any>;

export class DB {
	readonly raw: DatabaseSync;
	readonly path: string;
	private depth = 0;
	private stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();

	constructor(path: string) {
		this.path = path;
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.raw = new DatabaseSync(path);
		this.raw.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 8000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000; PRAGMA mmap_size = 0;`);
	}

	private stmt(sql: string) {
		let s = this.stmts.get(sql);
		if (!s) {
			s = this.raw.prepare(sql);
			if (this.stmts.size > 300) this.stmts.clear();
			this.stmts.set(sql, s);
		}
		return s;
	}
	all<T extends Row = Row>(sql: string, ...p: Param[]): T[] {
		return this.stmt(sql).all(...p) as T[];
	}
	get<T extends Row = Row>(sql: string, ...p: Param[]): T | undefined {
		return this.stmt(sql).get(...p) as T | undefined;
	}
	run(sql: string, ...p: Param[]) {
		return this.stmt(sql).run(...p);
	}
	exec(sql: string) {
		this.raw.exec(sql);
	}
	value<T = any>(sql: string, ...p: Param[]): T | undefined {
		const r = this.stmt(sql).get(...p) as Row | undefined;
		return r ? (Object.values(r)[0] as T) : undefined;
	}

	/** Transaction with nesting (savepoints). Rolls back on throw. */
	tx<T>(fn: () => T): T {
		const top = this.depth === 0;
		const sp = `sp${this.depth}`;
		this.raw.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
		this.depth++;
		try {
			const r = fn();
			this.depth--;
			this.raw.exec(top ? 'COMMIT' : `RELEASE ${sp}`);
			return r;
		} catch (e) {
			this.depth--;
			try {
				this.raw.exec(top ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
			} catch {
				/* connection already rolled back */
			}
			throw e;
		}
	}

	close() {
		this.stmts.clear();
		try {
			this.raw.exec('PRAGMA optimize');
		} catch {
			/* ignore */
		}
		this.raw.close();
	}
}

export interface MigrateResult {
	applied: number[];
	current: number;
	backup?: string;
}

export function migrate(db: DB, opts: { backup?: boolean } = {}): MigrateResult {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
	const have = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
	const pending = migrations.filter((m) => !have.has(m.version)).sort((a, b) => a.version - b.version);
	const res: MigrateResult = { applied: [], current: Math.max(0, ...have) };
	if (!pending.length) return res;
	// Existing database with data: keep a consistent copy before changing its schema.
	if (have.size && opts.backup !== false && db.path !== ':memory:' && existsSync(db.path) && statSync(db.path).size > 0) {
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		res.backup = join(backupsDir(), `pre-migration-v${pending[0].version}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
		copyFileSync(db.path, res.backup);
	}
	for (const m of pending) {
		db.tx(() => {
			db.exec(m.sql);
			db.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)', m.version, m.name, new Date().toISOString());
		});
		res.applied.push(m.version);
		res.current = m.version;
	}
	return res;
}

let shared: DB | null = null;

/** Process-wide connection (dashboard server, CLI and MCP each have their own process but share the file). */
export function getDb(): DB {
	if (!shared) {
		shared = new DB(dbPath());
		migrate(shared);
	}
	return shared;
}

export function openMemoryDb(): DB {
	const d = new DB(':memory:');
	migrate(d, { backup: false });
	return d;
}

export function closeDb() {
	shared?.close();
	shared = null;
}

export const now = () => new Date().toISOString();
