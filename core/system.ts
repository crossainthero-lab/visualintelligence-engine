import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.ts';
import { diskFree } from './stats.ts';
import { dataDir, stateDirCollector, defaultSessionsDir } from './paths.ts';

let gpuCache: { at: number; v: any } | null = null;

async function gpu() {
	if (gpuCache && Date.now() - gpuCache.at < 8000) return gpuCache.v;
	let v: any = { available: false, note: 'no GPU interface found (not required: nothing in this app uses the GPU)' };
	const r = await run('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeoutMs: 4000 });
	if (r.code === 0 && r.stdout.trim()) {
		const [name, used, total, driver] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
		v = { available: true, vendor: 'nvidia', name, usedMB: Number(used), totalMB: Number(total), driver };
		// Are any of THIS app's processes holding GPU memory? (They never should.)
		const t = await run('nvidia-smi', [], { timeoutMs: 4000 });
		v.thisAppMB = t.stdout.split('\n').filter((l) => new RegExp(`\\s${process.pid}\\s`).test(l)).map((l) => Number(/(\d+)MiB/.exec(l)?.[1] ?? 0)).reduce((a, b) => a + b, 0);
	} else {
		for (const n of [0, 1, 2]) {
			const d = `/sys/class/drm/card${n}/device`;
			if (existsSync(`${d}/mem_info_vram_used`)) {
				v = { available: true, vendor: 'amd', name: `card${n}`, usedMB: Number(readFileSync(`${d}/mem_info_vram_used`, 'utf8')) / 1048576, totalMB: Number(readFileSync(`${d}/mem_info_vram_total`, 'utf8')) / 1048576 };
				break;
			}
		}
	}
	gpuCache = { at: Date.now(), v };
	return v;
}

function swap() {
	try {
		const m = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((x) => x[1]).map(([k, v]) => [k, parseInt(v)]));
		return { totalMB: Math.round(m.SwapTotal / 1024), usedMB: Math.round((m.SwapTotal - m.SwapFree) / 1024), availableMB: Math.round(m.MemAvailable / 1024) };
	} catch {
		return null;
	}
}

export function collectorState() {
	const lock = join(stateDirCollector(), 'collector.lock');
	let pid: number | null = null;
	try {
		pid = Number(/pid=(\d+)/.exec(readFileSync(lock, 'utf8'))?.[1]);
	} catch {
		/* no lock file */
	}
	let running = false;
	if (pid) {
		try {
			running = readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('collect_cli');
		} catch {
			running = false;
		}
	}
	return { running, pid: running ? pid : null };
}

export async function systemSnapshot() {
	const m = process.memoryUsage();
	return {
		at: new Date().toISOString(),
		app: { pid: process.pid, rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), uptimeS: Math.round(process.uptime()), node: process.version },
		host: { cpus: cpus().length, load1: loadavg()[0], totalMemMB: Math.round(totalmem() / 1048576), freeMemMB: Math.round(freemem() / 1048576), ...swap() },
		disk: { data: diskFree(dataDir()), sessions: diskFree(existsSync(defaultSessionsDir()) ? defaultSessionsDir() : dataDir()) },
		gpu: await gpu(),
		collector: collectorState(),
		listen: `${process.env.VIE_HOST ?? process.env.HOST ?? '127.0.0.1'}:${process.env.VIE_PORT ?? process.env.PORT ?? '(dev default)'}`,
		authRequired: !!process.env.VIE_AUTH_TOKEN
	};
}
