<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.ts';
	import { ago, bytes, label, pct, when } from '#lib/format.ts';
	import { selection, toasts } from '#lib/selection.svelte.ts';
	import Icon from '#lib/components/Icon.svelte';
	import VideoDrawer from '#lib/components/VideoDrawer.svelte';

	type Scope = 'uids' | 'session' | 'filter' | 'next' | 'bookmarked' | 'creator';
	const q0 = page.url.searchParams;
	let scope = $state<Scope>(q0.get('session') ? 'session' : q0.get('filter') ? 'filter' : q0.get('video') ? 'uids' : selection.size ? 'uids' : 'next');
	let session = $state(q0.get('session') ?? '');
	let creator = $state('');
	let nextN = $state(10);
	let limitN = $state<number | ''>('');
	let onlyUn = $state(true);
	const filterStr = q0.get('filter') ?? '';
	let provider = $state('');
	let profile = $state('quick');
	let model = $state('');
	let concurrency = $state(1);
	let maxSuccess = $state<number | ''>('');
	let maxCost = $state<number | ''>('');
	let reanalyse = $state(false);

	let providers = $state<any[]>([]);
	let detected = $state(false);
	let profiles = $state<any[]>([]);
	let sessions = $state<any[]>([]);
	let batches = $state<any[]>([]);
	let analyses = $state<any[]>([]);
	let est = $state<any>(null);
	let estErr = $state('');
	let starting = $state(false);
	let confirm = $state(false);
	let testing = $state('');
	let testResult = $state<Record<string, any>>({});
	let open = $state<string | null>(null);
	let tab = $state<'queue' | 'done' | 'failed'>('queue');
	let max = $state(3);

	if (q0.get('video')) selection.addMany([q0.get('video')!]);

	$effect(() => {
		api('/api/profiles').then((r) => (profiles = r.profiles));
		api('/api/providers').then((r) => {
			providers = r.providers;
			detected = true;
			if (!provider) provider = r.providers.find((p: any) => p.available)?.id ?? '';
		});
		api('/api/sessions?limit=500').then((r) => (sessions = r.sessions));
		api('/api/settings').then((s) => (max = s.analysis.maxConcurrency));
	});
	const prov = $derived(providers.find((p) => p.id === provider));
	const prof = $derived(profiles.find((p) => p.id === profile));
	const needsProvider = $derived(prof?.usesProvider !== false);

	function selectionSpec(): any {
		const lim = limitN === '' ? undefined : Number(limitN);
		switch (scope) {
			case 'uids': return { scope, uids: selection.list() };
			case 'session': return { scope, session, onlyUnanalysed: onlyUn, limit: lim };
			case 'filter': return { scope, filter: filterStr, limit: lim };
			case 'next': return { scope, n: Number(nextN) || 10, session: session || undefined };
			case 'bookmarked': return { scope, onlyUnanalysed: onlyUn, limit: lim };
			case 'creator': return { scope, creator, onlyUnanalysed: onlyUn, limit: lim };
		}
	}
	const specOk = $derived(scope === 'uids' ? selection.size > 0 : scope === 'session' ? !!session : scope === 'creator' ? !!creator.trim() : true);

	let estTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		// re-estimate whenever the request changes; estimating never calls a provider
		JSON.stringify([selectionSpec(), provider, profile, selection.size, onlyUn]);
		clearTimeout(estTimer);
		est = null;
		estErr = '';
		if (!specOk || (needsProvider && !provider)) return;
		estTimer = setTimeout(async () => {
			try {
				est = await api('/api/analysis/estimate', { method: 'POST', json: { selection: selectionSpec(), provider: provider || 'none', profile } });
			} catch (e: any) {
				estErr = e.message;
			}
		}, 300);
	});

	async function refresh() {
		const [b, a] = await Promise.all([api('/api/analysis/batches'), api('/api/analysis?limit=150')]);
		batches = b.batches;
		analyses = a.analyses;
	}
	let pollTimer: ReturnType<typeof setTimeout>;
	const active = $derived(batches.some((b) => ['running', 'queued'].includes(b.status) && (b.counts.queued || b.counts.preparing || b.counts.running)));
	$effect(() => {
		refresh().catch(() => {});
		return () => clearTimeout(pollTimer);
	});
	$effect(() => {
		// poll only while something is actually running
		active;
		clearTimeout(pollTimer);
		if (active) pollTimer = setTimeout(() => refresh().catch(() => {}), 2000);
	});
	$effect(() => {
		batches;
		analyses;
		untrack(() => active && (clearTimeout(pollTimer), (pollTimer = setTimeout(() => refresh().catch(() => {}), 2000))));
	});

	async function start() {
		starting = true;
		confirm = false;
		try {
			const r = await api('/api/analysis/batches', { method: 'POST', json: { selection: selectionSpec(), provider: needsProvider ? provider : 'none', profile, model: model || undefined, concurrency, maxSuccess: maxSuccess || undefined, maxCostUsd: maxCost || undefined, reanalyse } });
			toasts.push(`Started: ${r.queued} queued${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
			await refresh();
		} catch (e: any) {
			toasts.push(e.message, true);
		} finally {
			starting = false;
		}
	}
	function requestStart() {
		if (needsProvider && ((est?.videos ?? 0) > 15 || est?.estimatedCostUsd == null)) confirm = true;
		else start();
	}
	async function act(b: any, action: string) {
		try {
			await api(`/api/analysis/batches/${b.uid}`, { method: 'POST', json: { action } });
			await refresh();
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	async function aAct(a: any, action: string) {
		try {
			await api(`/api/analysis/${a.uid}`, { method: 'POST', json: { action } });
			await refresh();
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	async function testProv(id: string) {
		testing = id;
		try {
			testResult[id] = await api(`/api/providers/${id}`, { method: 'POST', json: { model: model || undefined } });
		} catch (e: any) {
			testResult[id] = { ok: false, error: e.message };
		} finally {
			testing = '';
		}
	}
	const costLabel = (u: any) => (u?.costUsd == null ? '—' : u.remote ? 'self-hosted' : '$' + u.costUsd.toFixed(3));
	const shown = $derived(analyses.filter((a) => (tab === 'queue' ? ['queued', 'preparing', 'running'].includes(a.status) : tab === 'done' ? a.status === 'completed' : ['failed', 'cancelled'].includes(a.status))));
	const counts = $derived({ queue: analyses.filter((a) => ['queued', 'preparing', 'running'].includes(a.status)).length, done: analyses.filter((a) => a.status === 'completed').length, failed: analyses.filter((a) => ['failed', 'cancelled'].includes(a.status)).length });
</script>

<div class="page">
	<div class="pagehead">
		<div><h1>Analysis Studio</h1><p>Analysis uses agents you already have (Claude Code, Codex, Antigravity, Sarness). It never starts by itself: you choose the videos, the depth and the agent, then press Start.</p></div>
		<div class="row"><a class="btn" href="/api/analysis/export?format=json">Export JSON</a><a class="btn" href="/api/analysis/export?format=csv">CSV</a><a class="btn" href="/api/analysis/export?format=jsonl">JSONL</a></div>
	</div>

	<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start">
		<section class="card">
			<header><h2>1 · Which videos</h2><span class="faint">explicit only</span></header>
			<div class="body grid" style="gap:10px">
				<div class="chips">
					{#each [['uids', `Selected (${selection.size})`], ['session', 'A session'], ['next', 'Next N unanalysed'], ['bookmarked', 'Bookmarked'], ['creator', 'A creator'], ...(filterStr ? [['filter', 'Current filter']] : [])] as [k, l] (k)}
						<button class="badge chip" aria-pressed={scope === k} onclick={() => (scope = k as Scope)}>{l}</button>
					{/each}
				</div>
				{#if scope === 'uids'}
					<p class="muted">{selection.size ? `${selection.size} video(s) you selected in the Library or a session.` : 'Nothing selected yet. Pick videos in the Library (checkbox, or shift-click ranges).'}</p>
					<div class="row"><a class="btn sm" href="/library">Choose in Library</a>{#if selection.size}<button class="sm ghost" onclick={() => selection.clear()}>Clear selection</button>{/if}</div>
				{:else if scope === 'session' || scope === 'next'}
					<label class="f">Session{scope === 'next' ? ' (optional)' : ''}<select bind:value={session}><option value="">{scope === 'next' ? 'Any session' : 'Choose…'}</option>{#each sessions as s (s.id)}<option value={s.id}>{s.id} · {s.downloaded} downloaded, {s.analysed} analysed</option>{/each}</select></label>
				{/if}
				{#if scope === 'next'}<label class="f">How many<input type="number" min="1" max="500" bind:value={nextN} /></label><p class="faint">Newest unanalysed videos first.</p>{/if}
				{#if scope === 'creator'}<label class="f">Creator username<input bind:value={creator} placeholder="e.g. studio.lubi" /></label>{/if}
				{#if scope === 'filter'}<p class="muted">All videos matching the Library filter you came from.</p>{/if}
				{#if ['session', 'bookmarked', 'creator', 'filter'].includes(scope)}
					<div class="row"><label class="f" style="grid-auto-flow:column;align-items:center;gap:6px"><input type="checkbox" bind:checked={onlyUn} />only unanalysed</label>
						<label class="f" style="grid-auto-flow:column;align-items:center;gap:6px">first<input type="number" min="1" bind:value={limitN} placeholder="all" style="width:70px" /></label></div>
				{/if}
			</div>
		</section>

		<section class="card">
			<header><h2>2 · Depth</h2></header>
			<div class="body grid" style="gap:8px">
				{#each profiles as p (p.id)}
					<label class="notice" style="cursor:pointer;display:grid;grid-template-columns:18px 1fr;gap:8px;{profile === p.id ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
						<input type="radio" name="profile" value={p.id} bind:group={profile} />
						<span><b>{p.label}</b><br /><span class="muted">{p.description}</span>{#if p.usesProvider}<br /><span class="faint">{p.frames}{p.perShotFrames ? ' + ' + p.perShotFrames + ' per-shot' : ''} frame(s) @ {p.frameWidth}px{p.contactSheet ? ' + contact sheet' : ''}{p.shots ? ' + shot detection' : ''}</span>{/if}</span>
					</label>
				{/each}
			</div>
		</section>

		<section class="card">
			<header><h2>3 · Agent</h2><button class="ghost sm" onclick={() => api('/api/providers?refresh=1').then((r) => (providers = r.providers))}><Icon name="sync" size={12} />Re-detect</button></header>
			<div class="body grid" style="gap:8px">
				{#if !needsProvider}<div class="notice">This depth runs locally with no agent.</div>{/if}
				{#each providers as p (p.id)}
					<div class="notice" style="display:grid;gap:5px;{provider === p.id && needsProvider ? 'border-color:var(--accent)' : ''};{p.available ? '' : 'opacity:.75'}">
						<label class="row" style="cursor:{p.available ? 'pointer' : 'default'}">
							<input type="radio" name="prov" value={p.id} bind:group={provider} disabled={!p.available || !needsProvider} />
							<b>{p.label}</b>
							<span class="badge {p.available ? 'ok' : 'bad'}"><span class="dot"></span>{p.available ? 'available' : 'unavailable'}</span>
							{#if p.version}<span class="faint mono">{p.version}</span>{/if}
							{#if p.remote}<span class="badge info">remote GPU</span>{/if}
						</label>
						<span class="muted" style="font-size:12px">{p.detail}</span>
						{#if p.pricing}<span class="faint" style="font-size:11.5px">{p.pricing.note}</span>{/if}
						{#if p.available}
							<div class="row">
								<button class="sm" disabled={!!testing} onclick={() => testProv(p.id)}>{testing === p.id ? 'Testing…' : 'Test with one tiny image'}</button>
								{#if testResult[p.id]}
									{#if testResult[p.id].ok}<span class="badge {testResult[p.id].imageUnderstanding ? 'ok' : 'warn'}">{testResult[p.id].imageUnderstanding ? 'sees images' : 'answered, but image check failed'} · {(testResult[p.id].wallMs / 1000).toFixed(1)}s · {costLabel(testResult[p.id].usage)}</span>{:else}<span class="badge bad" title={testResult[p.id].error}>failed: {String(testResult[p.id].error).slice(0, 80)}</span>{/if}
								{/if}
							</div>
						{/if}
					</div>
				{:else}{#if !detected}<div class="notice">Detecting installed agents…</div>{/if}{/each}
				{#if needsProvider && prov?.models?.length}
					<label class="f">Model<select bind:value={model}><option value="">{prov.defaultModel ? `default (${prov.defaultModel})` : 'provider default'}</option>{#each prov.models as m (m)}<option value={m}>{m}</option>{/each}</select></label>
				{/if}
			</div>
		</section>

		<section class="card">
			<header><h2>4 · Limits &amp; start</h2></header>
			<div class="body grid" style="gap:10px">
				<div class="row">
					<label class="f">Parallel jobs<input type="number" min="1" {max} bind:value={concurrency} /></label>
					<label class="f">Stop after N successes<input type="number" min="1" bind:value={maxSuccess} placeholder="no limit" /></label>
					<label class="f">Stop at cost (USD)<input type="number" min="0" step="0.5" bind:value={maxCost} placeholder="no limit" disabled={prov && !prov.pricing?.known} title={prov && !prov.pricing?.known ? 'This provider does not report prices' : ''} /></label>
				</div>
				<label class="row"><input type="checkbox" bind:checked={reanalyse} />Re-analyse videos that already have a result (previous results are kept)</label>
				<div class="notice" style="min-height:64px">
					{#if estErr}<span style="color:var(--bad)">{estErr}</span>
					{:else if !specOk}Choose the videos first.
					{:else if !est}Estimating…
					{:else}
						<b class="num">{est.videos}</b> video(s) {est.skipped ? `(${est.skipped} skipped: no file)` : ''}{est.alreadyAnalysed && !reanalyse && needsProvider ? `, ${est.alreadyAnalysed} already analysed will be skipped` : ''} · {est.description}<br />
						{#if needsProvider}<span class="num">{est.providerCalls}</span> agent call(s) · ~{est.framesPerVideo} images each ·
							cost {est.estimatedCostUsd != null ? '≈ $' + est.estimatedCostUsd : 'unknown'} · time {est.estimatedSeconds != null ? '≈ ' + Math.round(est.estimatedSeconds / 60) + ' min' : 'unknown'}<br /><span class="faint">{est.note}</span>{:else}<span class="faint">{est.note}</span>{/if}
					{/if}
				</div>
				<button class="primary" style="justify-content:center;padding:8px" disabled={starting || !specOk || (needsProvider && !provider) || !est || !!estErr || est.videos === 0} onclick={requestStart}>
					<Icon name="play" size={13} />Start {profile === 'index' ? 'indexing' : 'analysis'}{est ? ` of ${est.videos - (reanalyse || !needsProvider ? 0 : est.alreadyAnalysed)} video(s)` : ''}{needsProvider && prov ? ` with ${prov.label}` : ''}
				</button>
			</div>
		</section>
	</div>

	<section class="card" style="margin-top:14px">
		<header>
			<h2>Batches</h2><span class="faint">{active ? 'live' : 'idle'}</span>
		</header>
		{#if !batches.length}<div class="empty"><b>Nothing has been analysed yet</b>Pick a few videos above and press Start. Try one first to calibrate cost and time.</div>
		{:else}
			<table class="t"><thead><tr><th>Started</th><th>Request</th><th>Agent</th><th>Depth</th><th>Progress</th><th class="r">Cost</th><th>State</th><th></th></tr></thead>
				<tbody>{#each batches as b (b.uid)}
					{@const c = b.counts}
					{@const total = Object.values(c).reduce((a: number, x: any) => a + x, 0)}
					<tr>
						<td class="num">{ago(b.created_at)}</td>
						<td class="trunc" style="max-width:260px" title={b.note ?? ''}>{b.selection.description}{b.note ? ' · ' + b.note : ''}</td>
						<td>{b.provider}{b.model ? ' · ' + b.model : ''}</td><td>{b.profile}</td>
						<td style="min-width:170px"><div class="meter"><i style="width:{((c.completed ?? 0) / Math.max(total, 1)) * 100}%;background:var(--ok)"></i><i style="width:{(((c.running ?? 0) + (c.preparing ?? 0)) / Math.max(total, 1)) * 100}%;background:var(--accent)"></i><i style="width:{((c.failed ?? 0) / Math.max(total, 1)) * 100}%;background:var(--bad)"></i></div>
							<span class="faint num">{c.completed ?? 0} done · {(c.running ?? 0) + (c.preparing ?? 0)} running · {c.queued ?? 0} queued · {c.failed ?? 0} failed{c.cancelled ? ` · ${c.cancelled} cancelled` : ''}</span></td>
						<td class="r num">{b.costUsd ? '$' + b.costUsd.toFixed(2) : '—'}</td>
						<td><span class="badge {b.status === 'running' ? 'info' : b.status === 'completed' ? 'ok' : b.status === 'cancelled' ? 'bad' : 'warn'}">{b.status}</span></td>
						<td class="r"><div class="row" style="justify-content:flex-end">
							{#if b.status === 'running'}<button class="sm" onclick={() => act(b, 'pause')} title="Stop starting new jobs; running ones finish">Pause</button>{/if}
							{#if b.status === 'paused'}<button class="sm" onclick={() => act(b, 'resume')}>Resume</button>{/if}
							{#if ['running', 'paused', 'queued'].includes(b.status)}<button class="sm danger" onclick={() => act(b, 'cancel')} title="Cancel queued jobs and abort running ones">Cancel</button>{/if}
						</div></td>
					</tr>{/each}</tbody></table>
		{/if}
	</section>

	<section class="card" style="margin-top:14px">
		<header>
			<div class="seg">{#each [['queue', 'Queue'], ['done', 'Completed'], ['failed', 'Failed / cancelled']] as [k, l] (k)}<button aria-pressed={tab === k} onclick={() => (tab = k as any)}>{l} ({counts[k as 'queue']})</button>{/each}</div>
		</header>
		<div style="overflow:auto">
			<table class="t"><thead><tr><th>Video</th><th>Agent</th><th>Depth</th><th>Result</th><th class="r">Relevance</th><th class="r">Cost</th><th>When</th><th></th></tr></thead>
				<tbody>{#each shown as a (a.uid)}
					<tr>
						<td><button class="ghost sm" onclick={() => (open = a.video_uid)}>@{a.creator ?? 'unknown'}</button></td>
						<td>{a.provider}{a.model ? ' · ' + a.model : ''}</td><td>{a.profile}</td>
						<td class="trunc" style="max-width:360px">{#if a.status === 'completed'}<span class="badge {a.useful === 'useful' ? 'ok' : a.useful === 'not_useful' ? 'bad' : 'warn'}">{label(a.useful)}</span> <span class="muted">{a.summary}</span>{:else if a.error}<span style="color:var(--bad)" title={a.error}>{a.error}</span>{:else}<span class="badge info">{a.status}</span>{/if}</td>
						<td class="r num">{pct(a.relevance)}</td><td class="r num">{costLabel(a.usage)}</td><td class="num">{ago(a.completed_at ?? a.created_at)}</td>
						<td class="r">{#if ['queued', 'preparing', 'running'].includes(a.status)}<button class="sm danger" onclick={() => aAct(a, 'cancel')}>Cancel</button>{:else if ['failed', 'cancelled'].includes(a.status)}<button class="sm" onclick={() => aAct(a, 'retry')} title="Creates a new, explicit retry">Retry</button>{/if}</td>
					</tr>{:else}<tr><td colspan="8" class="empty">Nothing here.</td></tr>{/each}</tbody></table>
		</div>
	</section>
</div>

{#if confirm}
	<button class="scrim" onclick={() => (confirm = false)} aria-label="Cancel" style="border:0;border-radius:0;padding:0"></button>
	<div class="modal" role="dialog" aria-label="Confirm analysis">
		<h2>Confirm: this will call an external agent</h2>
		<p><b class="num">{est?.providerCalls}</b> request(s) to <b>{prov?.label}</b> ({prof?.label}).
			{#if est?.estimatedCostUsd != null}Estimated cost ≈ <b>${est.estimatedCostUsd}</b> (from {est.basedOnPastRuns} earlier run(s)).{:else}<b>Cost is unknown</b>: there is no earlier run to calibrate from. Consider setting “Stop after N successes”, or run one video first.{/if}
			{maxCost ? `Hard stop at $${maxCost}.` : ''}{maxSuccess ? ` Stops after ${maxSuccess} success(es).` : ''}</p>
		<p class="muted">Nothing is retried automatically. You can pause or cancel at any time.</p>
		<div class="row" style="justify-content:flex-end"><button onclick={() => (confirm = false)}>Back</button><button class="primary" onclick={start}>Start</button></div>
	</div>
{/if}
{#if open}<VideoDrawer uid={open} onclose={() => (open = null)} onchanged={() => refresh()} />{/if}
