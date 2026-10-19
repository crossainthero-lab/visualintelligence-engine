// Bounded, cancellable child processes. Every spawn here has a timeout, an optional AbortSignal, a stdout cap
// and (for media work) lowered CPU/IO priority. Nothing here ever shells out through a shell string.
import { spawn, execFileSync } from 'node:child_process';

export interface RunOpts {
	timeoutMs?: number;
	signal?: AbortSignal;
	input?: string;
	maxOutput?: number;
	nice?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}
export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	ms: number;
}

const have = new Map<string, boolean>();
export function hasBinary(name: string): boolean {
	if (!have.has(name)) {
		try {
			execFileSync('which', [name], { stdio: 'ignore' });
			have.set(name, true);
		} catch {
			have.set(name, false);
		}
	}
	return have.get(name)!;
}

export function which(name: string): string | null {
	try {
		return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

export function run(cmd: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
	let c = cmd;
	let a = args;
	if (o.nice && hasBinary('nice')) {
		a = ['-n', String(o.nice), cmd, ...args];
		c = 'nice';
		if (hasBinary('ionice')) {
			a = ['-c', '3', 'nice', ...a];
			c = 'ionice';
		}
	}
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = spawn(c, a, { stdio: ['pipe', 'pipe', 'pipe'], cwd: o.cwd, env: o.env, detached: true });
		const max = o.maxOutput ?? 8_000_000;
		let out = '';
		let err = '';
		let timedOut = false;
		let aborted = false;
		let done = false;
		const kill = () => {
			try {
				process.kill(-child.pid!, 'SIGTERM');
			} catch {
				/* gone */
			}
			setTimeout(() => {
				try {
					process.kill(-child.pid!, 'SIGKILL');
				} catch {
					/* gone */
				}
			}, 3000).unref();
		};
		const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), o.timeoutMs) : null;
		const onAbort = () => ((aborted = true), kill());
		if (o.signal?.aborted) onAbort();
		o.signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (d) => {
			if (out.length < max) out += d.toString();
		});
		child.stderr.on('data', (d) => {
			if (err.length < 200_000) err += d.toString();
		});
		child.on('error', (e) => {
			err += String(e);
		});
		child.on('close', (code) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			o.signal?.removeEventListener('abort', onAbort);
			resolve({ code, stdout: out, stderr: err, timedOut, aborted, ms: Date.now() - t0 });
		});
		if (o.input != null) child.stdin.end(o.input);
		else child.stdin.end();
	});
}

/** Simple counting semaphore: hard cap on concurrent heavy children. */
export class Semaphore {
	private waiting: Array<() => void> = [];
	private active = 0;
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async acquire() {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise<void>((r) => this.waiting.push(r));
		this.active++;
	}
	release() {
		this.active--;
		const n = this.waiting.shift();
		if (n) n();
	}
	async with<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
	get running() {
		return this.active;
	}
	get queued() {
		return this.waiting.length;
	}
}
