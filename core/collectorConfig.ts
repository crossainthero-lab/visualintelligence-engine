// Read/write a whitelisted subset of the Python collector's config.toml. Line-oriented so comments and every other
// key in the file are left exactly as they were. Collector changes apply the next time ./collect.sh starts.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.ts';

type Spec = { section: string; key: string; type: 'int' | 'float' | 'bool' | 'str' | 'enum'; min?: number; max?: number; options?: string[]; label: string; help: string; def: any };

// NOTE: defaults mirror vie/config.py and vie/resources.py LIMIT_DEFAULTS (tests/ checks the key sets stay in sync).
export const COLLECTOR_KEYS: Spec[] = [
	{ section: 'collector', key: 'mode', type: 'enum', options: ['fast', 'normal'], label: 'Default collection mode', help: 'fast = no LLM, ever. normal = LLM-steered browsing (only when selected).', def: 'fast' },
	{ section: 'collector', key: 'download_workers', type: 'int', min: 1, max: 4, label: 'Concurrent downloads', help: 'Hard-capped at 4 by the collector.', def: 2 },
	{ section: 'collector', key: 'queue_max', type: 'int', min: 4, max: 200, label: 'Download queue limit', help: 'Browsing pauses when this many downloads wait.', def: 40 },
	{ section: 'collector', key: 'download_nice', type: 'int', min: 0, max: 19, label: 'Download CPU niceness', help: 'Higher = politer to the desktop.', def: 10 },
	{ section: 'browser', key: 'gpu', type: 'enum', options: ['software', 'auto'], label: 'Browser rendering', help: 'software keeps Chromium off the GPU (recommended; see docs/RESOURCES.md).', def: 'software' },
	{ section: 'browser', key: 'max_tabs', type: 'int', min: 1, max: 6, label: 'Max browser tabs', help: 'Surplus tabs are closed.', def: 3 },
	{ section: 'browser', key: 'recycle_after_reels', type: 'int', min: 0, max: 1000, label: 'Restart browser every N reels', help: '0 disables.', def: 60 },
	{ section: 'browser', key: 'recycle_after_min', type: 'int', min: 0, max: 600, label: 'Restart browser every N minutes', help: '0 disables.', def: 20 },
	{ section: 'limits', key: 'pause_mem_available_mb', type: 'int', min: 512, max: 65536, label: 'Pause below free RAM (MB)', help: 'Browsing waits until memory recovers.', def: 3000 },
	{ section: 'limits', key: 'stop_mem_available_mb', type: 'int', min: 256, max: 65536, label: 'Stop below free RAM (MB)', help: 'Everything is saved, then the collector stops.', def: 1200 },
	{ section: 'limits', key: 'pause_swap_used_pct', type: 'int', min: 1, max: 100, label: 'Pause above swap use (%)', help: '', def: 40 },
	{ section: 'limits', key: 'stop_swap_used_pct', type: 'int', min: 1, max: 100, label: 'Stop above swap use (%)', help: '', def: 80 },
	{ section: 'limits', key: 'pause_disk_free_gb', type: 'int', min: 1, max: 1000, label: 'Pause below free disk (GB)', help: '', def: 6 },
	{ section: 'limits', key: 'stop_disk_free_gb', type: 'int', min: 1, max: 1000, label: 'Stop below free disk (GB)', help: '', def: 2 },
	{ section: 'limits', key: 'pause_gpu_used_pct', type: 'int', min: 10, max: 100, label: 'Pause above GPU memory use (%)', help: 'Whole-GPU use, any vendor that exposes it.', def: 85 },
	{ section: 'limits', key: 'recycle_owned_gpu_mb', type: 'int', min: 100, max: 24000, label: 'Restart browser above GPU MB', help: 'Only counts the collector browser.', def: 1200 },
	{ section: 'limits', key: 'recycle_owned_rss_mb', type: 'int', min: 500, max: 64000, label: 'Restart browser above RAM MB', help: 'Only counts the collector browser.', def: 3500 },
	{ section: 'limits', key: 'stop_on_gpu_driver_errors', type: 'bool', label: 'Stop on GPU driver errors', help: 'NVIDIA VA-space / RC-watchdog lines in the kernel log during the run.', def: true }
];

const path = () => process.env.VIE_CONFIG ?? join(repoRoot(), 'config.toml');

function parseScalar(raw: string): any {
	const v = raw.replace(/\s+#.*$/, '').trim();
	if (v === 'true') return true;
	if (v === 'false') return false;
	if (/^-?\d+$/.test(v)) return Number(v);
	if (/^-?\d*\.\d+$/.test(v)) return Number(v);
	return v.replace(/^"(.*)"$/, '$1');
}

function readFile(): string {
	const p = path();
	if (existsSync(p)) return readFileSync(p, 'utf8');
	const ex = join(repoRoot(), 'config.example.toml');
	return existsSync(ex) ? readFileSync(ex, 'utf8') : '';
}

export function readCollectorConfig() {
	const lines = readFile().split('\n');
	let section = '';
	const found: Record<string, any> = {};
	for (const l of lines) {
		const sec = /^\s*\[([\w.]+)\]/.exec(l);
		if (sec) {
			section = sec[1];
			continue;
		}
		const kv = /^\s*([\w]+)\s*=\s*(.+)$/.exec(l);
		if (kv) found[`${section}.${kv[1]}`] = parseScalar(kv[2]);
	}
	return { path: path(), exists: existsSync(path()), fields: COLLECTOR_KEYS.map((s) => ({ ...s, value: found[`${s.section}.${s.key}`] ?? s.def, isDefault: !(`${s.section}.${s.key}` in found) })) };
}

export function writeCollectorConfig(patch: Record<string, any>) {
	const specs = new Map(COLLECTOR_KEYS.map((s) => [`${s.section}.${s.key}`, s]));
	const fmt = (s: Spec, v: any): string => {
		if (s.type === 'bool') return v ? 'true' : 'false';
		if (s.type === 'enum') {
			if (!s.options!.includes(String(v))) throw new Error(`${s.key} must be one of ${s.options!.join(', ')}`);
			return `"${v}"`;
		}
		const n = Number(v);
		if (!isFinite(n) || (s.type === 'int' && !Number.isInteger(n))) throw new Error(`${s.key} must be a number`);
		if ((s.min != null && n < s.min) || (s.max != null && n > s.max)) throw new Error(`${s.key} must be ${s.min}..${s.max}`);
		return String(n);
	};
	let lines = readFile().split('\n');
	for (const [k, v] of Object.entries(patch)) {
		const s = specs.get(k);
		if (!s) throw new Error(`setting "${k}" cannot be changed from here`);
		const val = fmt(s, v);
		let section = '';
		let done = false;
		let sectionEnd = -1;
		lines = lines.map((l, i) => {
			const sec = /^\s*\[([\w.]+)\]/.exec(l);
			if (sec) {
				if (section === s.section && sectionEnd < 0) sectionEnd = i;
				section = sec[1];
				return l;
			}
			if (!done && section === s.section && new RegExp(`^\\s*${s.key}\\s*=`).test(l)) {
				done = true;
				const comment = /(\s+#.*)$/.exec(l)?.[1] ?? '';
				return `${s.key} = ${val}${comment}`;
			}
			return l;
		});
		if (!done) {
			if (section === s.section && sectionEnd < 0) lines.push(`${s.key} = ${val}`);
			else if (sectionEnd >= 0) lines.splice(sectionEnd, 0, `${s.key} = ${val}`);
			else lines.push('', `[${s.section}]`, `${s.key} = ${val}`);
		}
	}
	const tmp = path() + '.tmp';
	writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
	renameSync(tmp, path());
	return readCollectorConfig();
}
