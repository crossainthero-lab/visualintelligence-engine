import type { Provider, ProviderInfo } from '../types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { antigravity } from './antigravity.ts';
import { sarness } from './sarness.ts';

// Adapter interface: { id, detect(): ProviderInfo, run(request, signal): response }. To add a provider, implement
// `Provider` (core/analysis/types.ts), add it here, and it appears in the dashboard, CLI and MCP automatically.
export const PROVIDERS: Record<string, Provider> = { claude, codex, antigravity, sarness };

export function getProvider(id: string): Provider {
	const p = PROVIDERS[id];
	if (!p) throw new Error(`unknown provider "${id}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
	return p;
}

let cache: { at: number; info: ProviderInfo[] } | null = null;
/** Detection never calls a model. Cached briefly so page loads stay cheap. */
export async function detectProviders(force = false): Promise<ProviderInfo[]> {
	if (!force && cache && Date.now() - cache.at < 30_000) return cache.info;
	const info = await Promise.all(Object.values(PROVIDERS).map((p) => p.detect().catch((e): ProviderInfo => ({ id: p.id, label: p.id, kind: 'cli', available: false, authenticated: null, models: [], supports: { images: false, video: false, structured: false }, detail: `detection failed: ${e.message}`, verified: 'unverified' }))));
	cache = { at: Date.now(), info };
	return info;
}
