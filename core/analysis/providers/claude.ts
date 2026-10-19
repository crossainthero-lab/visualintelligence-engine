import { run } from '../../exec.ts';
import { getDb } from '../../db.ts';
import { getSettings } from '../../settings.ts';
import type { Provider, ProviderInfo, ProviderRequest, ProviderResponse } from '../types.ts';
import { cliVersion, extractJson } from './common.ts';

// Uses the installed `claude` CLI in print mode with the user's existing login. No API key is read or requested.
// Images are given as files the agent reads with its Read tool (Claude Code renders images natively).
export const claude: Provider = {
	id: 'claude',
	async detect(): Promise<ProviderInfo> {
		const s = getSettings().analysis.providers.claude;
		const { path, version } = await cliVersion(s?.command || 'claude');
		return {
			id: 'claude',
			label: 'Claude Code',
			kind: 'cli',
			available: !!path && s?.enabled !== false,
			authenticated: null,
			version: version ?? undefined,
			command: path ?? undefined,
			models: ['sonnet', 'opus', 'haiku'],
			defaultModel: s?.model || undefined,
			supports: { images: true, video: false, structured: true },
			detail: path ? `claude -p, existing CLI login; images via the Read tool` : 'claude CLI not found on PATH',
			verified: path ? 'tested' : 'unsupported',
			pricing: { known: true, note: 'The CLI reports total_cost_usd per call. A trivial call measured ~USD 0.10 here (mostly cached system prompt); expect ~USD 0.15–0.5 per image analysis.' }
		};
	},
	async run(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
		const s = getSettings(getDb()).analysis.providers.claude;
		const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--add-dir', req.workdir, '--max-turns', '12', '--no-session-persistence', '--permission-mode', 'dontAsk'];
		const model = req.model || s?.model;
		if (model) args.push('--model', model);
		const r = await run(s?.command || 'claude', args, { input: req.prompt, cwd: req.workdir, timeoutMs: req.timeoutMs, signal, maxOutput: 4_000_000 });
		if (r.aborted) throw new Error('cancelled');
		if (r.timedOut) throw new Error(`claude timed out after ${Math.round(req.timeoutMs / 1000)}s`);
		let env: any = null;
		try {
			env = JSON.parse(r.stdout);
		} catch {
			/* not json */
		}
		if (!env) throw new Error(`claude returned no JSON envelope (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
		if (env.is_error) throw new Error(`claude error: ${String(env.result ?? env.subtype).slice(0, 300)}`);
		const text = String(env.result ?? '');
		const mu = env.modelUsage ? Object.keys(env.modelUsage)[0] : undefined;
		return {
			text,
			json: extractJson(text),
			model: mu,
			usage: {
				costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null,
				inputTokens: (env.usage?.input_tokens ?? 0) + (env.usage?.cache_creation_input_tokens ?? 0) + (env.usage?.cache_read_input_tokens ?? 0),
				cachedTokens: env.usage?.cache_read_input_tokens,
				outputTokens: env.usage?.output_tokens,
				ms: env.duration_ms ?? r.ms,
				extra: { turns: env.num_turns }
			}
		};
	}
};
