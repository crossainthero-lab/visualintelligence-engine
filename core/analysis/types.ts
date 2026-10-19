export type ProfileId = 'index' | 'quick' | 'standard' | 'deep';

export interface Profile {
	id: ProfileId;
	level: 0 | 1 | 2 | 3;
	label: string;
	description: string;
	usesProvider: boolean;
	frames: number;
	frameWidth: number;
	contactSheet: boolean;
	shots: boolean;
	perShotFrames: number; // max shots that get their own frame (deep)
	burstFrames: number; // consecutive frames around the strongest cut (deep)
	timeoutS: number;
}

export interface ProviderInfo {
	id: string;
	label: string;
	kind: 'cli' | 'http' | 'mcp';
	available: boolean;
	authenticated: boolean | null; // null = cannot tell without a billable call
	version?: string;
	command?: string;
	models: string[];
	defaultModel?: string;
	supports: { images: boolean; video: boolean; structured: boolean };
	detail: string;
	verified: 'tested' | 'unverified' | 'unsupported';
	pricing?: { known: boolean; note: string };
	remote?: boolean;
}

export interface FrameInfo {
	index: number;
	t: number;
	path: string;
}

export interface ProviderRequest {
	prompt: string;
	images: string[]; // absolute paths, in the order described by the prompt
	schema: object;
	model?: string;
	timeoutMs: number;
	workdir: string; // scratch directory the agent may read (frames live under it)
}

export interface ProviderResponse {
	text: string;
	json: any | null;
	model?: string;
	usage: { costUsd?: number | null; inputTokens?: number; outputTokens?: number; cachedTokens?: number; ms: number; remote?: boolean; extra?: Record<string, any> };
}

export interface Provider {
	id: string;
	detect(): Promise<ProviderInfo>;
	run(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}
