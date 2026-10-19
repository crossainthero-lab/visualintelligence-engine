import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { run } from '../../exec.ts';
import { getSettings } from '../../settings.ts';
import { tmpDir } from '../../paths.ts';
import type { Provider, ProviderInfo, ProviderRequest, ProviderResponse } from '../types.ts';
import { cliVersion, extractJson } from './common.ts';

function configuredModel(): string | undefined {
	try {
		const t = readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
		return /^\s*model\s*=\s*"([^"]+)"/m.exec(t)?.[1];
	} catch {
		return undefined;
	}
}

// Uses `codex exec` non-interactively with the CLI's existing login. Images are attached natively with -i.
// Sandbox is read-only: the agent can answer but not modify anything.
export const codex: Provider = {
	id: 'codex',
	async detect(): Promise<ProviderInfo> {
		const s = getSettings().analysis.providers.codex;
		const { path, version } = await cliVersion(s?.command || 'codex');
		return {
			id: 'codex',
			label: 'OpenAI Codex CLI',
			kind: 'cli',
			available: !!path && s?.enabled !== false,
			authenticated: null,
			version: version ?? undefined,
			command: path ?? undefined,
			models: [],
			defaultModel: s?.model || configuredModel(),
			supports: { images: true, video: false, structured: true },
			detail: path ? 'codex exec --output-schema, images attached with -i, read-only sandbox, existing CLI login' : 'codex CLI not found on PATH',
			verified: path ? 'tested' : 'unsupported',
			pricing: { known: false, note: 'Codex reports token usage but not price; cost is shown as unknown and cannot be limited by cost.' }
		};
	},
	async run(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
		const s = getSettings().analysis.providers.codex;
		const dir = mkdtempSync(join(tmpDir(), 'codex-'));
		const out = join(dir, 'last.txt');
		const schemaFile = join(dir, 'schema.json');
		// Codex's structured-output validator is strict; give it the strict variant of our schema.
		writeFileSync(schemaFile, JSON.stringify(req.schema));
		const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--output-schema', schemaFile, '-o', out, '--json', '-C', req.workdir];
		const model = req.model || s?.model;
		if (model) args.push('-m', model);
		for (const img of req.images) args.push('-i', img);
		args.push('-'); // prompt from stdin (the -i flag is variadic and would swallow a positional prompt)
		try {
			const r = await run(s?.command || 'codex', args, { input: req.prompt, timeoutMs: req.timeoutMs, signal, maxOutput: 4_000_000 });
			if (r.aborted) throw new Error('cancelled');
			if (r.timedOut) throw new Error(`codex timed out after ${Math.round(req.timeoutMs / 1000)}s`);
			let usage: any = {};
			let last = '';
			for (const line of r.stdout.split('\n')) {
				if (!line.startsWith('{')) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === 'turn.completed') usage = ev.usage ?? {};
					if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text;
					if (ev.type === 'error' || ev.type === 'turn.failed') throw new Error(`codex: ${JSON.stringify(ev.message ?? ev.error ?? ev).slice(0, 300)}`);
				} catch (e: any) {
					if (String(e.message).startsWith('codex:')) throw e;
				}
			}
			const text = existsSync(out) ? readFileSync(out, 'utf8') : last;
			if (r.code !== 0 && !text) throw new Error(`codex exited ${r.code}: ${r.stderr.split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ').slice(0, 300) || r.stderr.slice(0, 300)}`);
			return {
				text,
				json: extractJson(text),
				model: model || configuredModel(),
				usage: { costUsd: null, inputTokens: usage.input_tokens, cachedTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens, ms: r.ms, extra: { reasoning_tokens: usage.reasoning_output_tokens } }
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
};
