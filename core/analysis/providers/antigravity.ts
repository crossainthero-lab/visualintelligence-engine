import { run } from '../../exec.ts';
import { getSettings } from '../../settings.ts';
import type { Provider, ProviderInfo, ProviderRequest, ProviderResponse } from '../types.ts';
import { cliVersion, extractJson } from './common.ts';

// Google Antigravity's `agy` CLI has a documented print mode (`agy -p --output-format json`, `agy models`).
// Verified on this machine with agy 1.4.2: it reads an image file from an --add-dir directory and returns JSON.
// Nothing is invented beyond that: no undocumented endpoints, no IDE automation.
export const antigravity: Provider = {
	id: 'antigravity',
	async detect(): Promise<ProviderInfo> {
		const s = getSettings().analysis.providers.antigravity;
		const { path, version } = await cliVersion(s?.command || 'agy');
		let models: string[] = [];
		if (path) {
			const r = await run(path, ['models'], { timeoutMs: 20_000 });
			if (r.code === 0) models = r.stdout.split('\n').map((l) => l.split('\t')[0].trim()).filter((m) => m && !/^fetching/i.test(m));
		}
		return {
			id: 'antigravity',
			label: 'Google Antigravity (agy)',
			kind: 'cli',
			available: !!path && s?.enabled === true,
			authenticated: null,
			version: version ?? undefined,
			command: path ?? undefined,
			models,
			defaultModel: s?.model || undefined,
			supports: { images: true, video: false, structured: true },
			detail: !path ? 'agy CLI not found on PATH' : s?.enabled === true ? 'agy -p --output-format json; images read from an --add-dir workspace' : 'installed but disabled — enable it in Settings → Analysis providers (it can use several model vendors, so you choose a model explicitly)',
			verified: path ? 'tested' : 'unsupported',
			pricing: { known: false, note: 'agy reports token counts only; price is unknown, so cost limits cannot be applied.' }
		};
	},
	async run(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
		const s = getSettings().analysis.providers.antigravity;
		const args = ['-p', req.prompt, '--output-format', 'json', '--add-dir', req.workdir, '--print-timeout', `${Math.round(req.timeoutMs / 1000)}s`];
		const model = req.model || s?.model;
		if (model) args.push('--model', model);
		const r = await run(s?.command || 'agy', args, { cwd: req.workdir, timeoutMs: req.timeoutMs + 15_000, signal, maxOutput: 4_000_000 });
		if (r.aborted) throw new Error('cancelled');
		if (r.timedOut) throw new Error(`agy timed out after ${Math.round(req.timeoutMs / 1000)}s`);
		let env: any = null;
		try {
			env = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '');
		} catch {
			/* handled below */
		}
		if (!env) throw new Error(`agy returned no JSON (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
		if (env.status && env.status !== 'SUCCESS') throw new Error(`agy status ${env.status}: ${String(env.response ?? '').slice(0, 300)}`);
		const text = String(env.response ?? '');
		return {
			text,
			json: extractJson(text),
			model: model || 'agy default',
			usage: { costUsd: null, inputTokens: env.usage?.input_tokens, outputTokens: env.usage?.output_tokens, cachedTokens: env.usage?.cache_read_tokens, ms: Math.round((env.duration_seconds ?? r.ms / 1000) * 1000), extra: { thinking_tokens: env.usage?.thinking_tokens, turns: env.num_turns } }
		};
	}
};
