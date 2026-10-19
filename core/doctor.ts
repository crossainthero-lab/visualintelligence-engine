// `visualintelligence doctor` — diagnostics only. Never calls an AI provider, never modifies anything.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db.ts';
import { run, hasBinary, which } from './exec.ts';
import { dataDir, dbPath, defaultSessionsDir, repoRoot, stateDirCollector } from './paths.ts';
import { systemSnapshot, collectorState } from './system.ts';
import { detectProviders } from './analysis/providers/index.ts';
import { getSettings } from './settings.ts';
import { sarnessConn } from './analysis/providers/sarness.ts';

export interface Check {
	area: string;
	name: string;
	status: 'ok' | 'warn' | 'fail' | 'info';
	detail: string;
}

export async function doctor(opts: { remote?: boolean } = {}): Promise<Check[]> {
	const out: Check[] = [];
	const add = (area: string, name: string, status: Check['status'], detail: string) => out.push({ area, name, status, detail });
	const db = getDb();

	// ---- database ----
	const ic = db.value<string>('PRAGMA integrity_check');
	add('database', 'integrity', ic === 'ok' ? 'ok' : 'fail', ic === 'ok' ? `${dbPath()} integrity_check ok` : String(ic));
	const fk = db.all('PRAGMA foreign_key_check');
	add('database', 'foreign keys', fk.length ? 'fail' : 'ok', fk.length ? `${fk.length} violation(s)` : 'no violations');
	add('database', 'schema', 'info', `version ${db.value('SELECT MAX(version) FROM schema_migrations')}; ${db.value('SELECT COUNT(*) FROM videos')} videos, ${db.value('SELECT COUNT(*) FROM sessions')} sessions`);
	const missing = db.value<number>('SELECT COUNT(*) FROM videos WHERE file_missing=1') ?? 0;
	add('database', 'media files', missing ? 'warn' : 'ok', missing ? `${missing} record(s) point at missing or zero-byte files (see Storage → Inspect)` : 'every downloaded record has a non-empty file');

	// ---- disk ----
	const sys = await systemSnapshot();
	const free = sys.disk.data.freeBytes;
	const pct = free && sys.disk.data.totalBytes ? free / sys.disk.data.totalBytes : null;
	add('disk', 'free space', free == null ? 'info' : free < 2e9 ? 'fail' : free < 6e9 || (pct ?? 1) < 0.05 ? 'warn' : 'ok', free == null ? 'unknown' : `${(free / 1e9).toFixed(1)} GB free (${Math.round((pct ?? 0) * 100)}%) at ${dataDir()}`);

	// ---- binaries ----
	const [maj, min] = process.versions.node.split('.').map(Number);
	add('binaries', 'node', maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'fail', `${process.version} (need >= 22.18)`);
	for (const b of ['ffmpeg', 'ffprobe']) add('binaries', b, hasBinary(b) ? 'ok' : 'fail', which(b) ?? 'not found (sudo apt install ffmpeg)');
	const venv = join(repoRoot(), '.venv', 'bin', 'python');
	add('binaries', 'collector venv', existsSync(venv) ? 'ok' : 'info', existsSync(venv) ? venv : 'not set up (only needed on the collecting machine: ./setup.sh)');
	if (existsSync(venv)) {
		const y = await run(venv, ['-m', 'yt_dlp', '--version'], { timeoutMs: 15000 });
		add('binaries', 'yt-dlp', y.code === 0 ? 'ok' : 'warn', y.code === 0 ? y.stdout.trim() : 'not importable in .venv');
		const pw = await run(venv, ['-c', 'from importlib.metadata import version;print(version("playwright"))'], { timeoutMs: 15000 });
		add('browser', 'playwright', pw.code === 0 ? 'ok' : 'warn', pw.code === 0 ? pw.stdout.trim() : 'not installed');
	}
	const chromes = existsSync(join(process.env.HOME ?? '', '.cache', 'ms-playwright')) ? readdirSync(join(process.env.HOME ?? '', '.cache', 'ms-playwright')).filter((d) => d.startsWith('chromium-')) : [];
	add('browser', 'playwright chromium', chromes.length ? 'ok' : 'info', chromes.length ? chromes.join(', ') : 'not installed (only needed for collecting)');

	// ---- collector environment / orphans ----
	const col = collectorState();
	add('collector', 'instance', 'info', col.running ? `a collector is running (pid ${col.pid})` : 'no collector running');
	const profile = join(stateDirCollector(), 'browser-profile');
	const orphans = await orphanBrowsers(profile);
	add('collector', 'orphaned browsers', orphans.length && !col.running ? 'warn' : 'ok', orphans.length && !col.running ? `${orphans.length} browser process(es) from an earlier collector are still running with the collector profile (pids ${orphans.slice(0, 6).join(', ')}). They will be cleaned up automatically at the next ./collect.sh start.` : 'none');
	const stale = db.value<number>(`SELECT COUNT(*) FROM sessions WHERE incomplete=1 AND recovered=1`) ?? 0;
	add('collector', 'sessions from crashes', stale ? 'warn' : 'ok', stale ? `${stale} session(s) ended without a clean shutdown (collector died: crash, kill or freeze)` : 'no crashed sessions recorded');
	const cookie = join(stateDirCollector(), 'cookies.txt');
	if (existsSync(cookie)) {
		const mode = statSync(cookie).mode & 0o777;
		add('collector', 'cookie file', mode & 0o077 ? 'fail' : col.running ? 'info' : 'warn', `${cookie} mode ${mode.toString(8)}${col.running ? '' : ' — left over from a run that did not exit cleanly (deleted at the next clean exit)'}`);
	}
	add('collector', 'sessions dir', existsSync(getSettings().collector.sessionsDir || defaultSessionsDir()) ? 'ok' : 'warn', getSettings().collector.sessionsDir || defaultSessionsDir());
	add('collector', 'config.toml', existsSync(join(repoRoot(), 'config.toml')) ? 'ok' : 'info', existsSync(join(repoRoot(), 'config.toml')) ? 'present' : 'absent: defaults in effect');

	// ---- analysis jobs ----
	const stuck = db.value<number>(`SELECT COUNT(*) FROM analyses WHERE status IN ('preparing','running')`) ?? 0;
	add('analysis', 'jobs in flight', 'info', `${stuck} running/preparing, ${db.value(`SELECT COUNT(*) FROM analyses WHERE status='queued'`)} queued, ${db.value(`SELECT COUNT(*) FROM analyses WHERE status='failed'`)} failed`);

	// ---- memory / gpu ----
	const h = sys.host as any;
	add('memory', 'available RAM', h.availableMB < 1200 ? 'fail' : h.availableMB < 3000 ? 'warn' : 'ok', `${(h.availableMB / 1024).toFixed(1)} GB available of ${(h.totalMemMB / 1024).toFixed(0)} GB; swap ${h.usedMB}/${h.totalMB} MB`);
	try {
		const psi = readFileSync('/proc/pressure/memory', 'utf8').split('\n')[0];
		const avg10 = Number(/avg10=([\d.]+)/.exec(psi)?.[1] ?? 0);
		add('memory', 'pressure (PSI)', avg10 > 15 ? 'warn' : 'ok', psi);
	} catch {
		/* no PSI */
	}
	add('gpu', 'device', 'info', sys.gpu.available ? `${sys.gpu.name}: ${Math.round(sys.gpu.usedMB)}/${Math.round(sys.gpu.totalMB)} MB used; this app holds ${sys.gpu.thisAppMB ?? 0} MB` : sys.gpu.note);
	if (hasBinary('journalctl')) {
		const j = await run('journalctl', ['-k', '--no-pager', '-q', '-g', "NVRM.*(can't alloc VA space|GPU is probably locked)"], { timeoutMs: 8000 });
		const n = j.stdout.split('\n').filter(Boolean).length;
		add('gpu', 'driver errors this boot', n ? 'warn' : 'ok', n ? `${n} NVIDIA VA-space / RC-watchdog line(s) in the kernel log since boot (the signature of the earlier desktop freezes)` : 'none');
	}

	// ---- providers ----
	for (const p of await detectProviders(true)) add('providers', p.id, p.available ? 'ok' : 'info', `${p.available ? 'available' : 'unavailable'} — ${p.detail}`);

	// ---- remote (optional, never calls a model) ----
	if (opts.remote) {
		const c = await sarnessConn();
		if (c) {
			const t0 = Date.now();
			try {
				const r = await fetch(c.base + '/v1/health', { signal: AbortSignal.timeout(6000) });
				add('remote', 'sarness health', r.ok ? 'ok' : 'warn', `${c.base} → HTTP ${r.status} in ${Date.now() - t0} ms`);
			} catch (e: any) {
				add('remote', 'sarness health', 'warn', `${c.base} unreachable: ${e.message}`);
			}
		}
	}
	return out;
}

async function orphanBrowsers(profile: string): Promise<number[]> {
	const pids: number[] = [];
	try {
		for (const d of readdirSync('/proc')) {
			if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
			try {
				if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(`--user-data-dir=${profile}`)) pids.push(Number(d));
			} catch {
				/* exited */
			}
		}
	} catch {
		/* not linux */
	}
	return pids;
}
