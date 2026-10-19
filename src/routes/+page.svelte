<script lang="ts">
	import { api } from '#lib/api.ts';
	import { bytes, label, longDur, when } from '#lib/format.ts';
	import Bars from '#lib/components/Bars.svelte';
	import TimeChart from '#lib/components/TimeChart.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { toasts } from '#lib/selection.svelte.ts';

	type Range = '24h' | '7d' | '30d' | 'all' | 'custom';
	let range = $state<Range>('all');
	let from = $state('');
	let to = $state('');
	let data = $state<any>(null);
	let sys = $state<any>(null);
	let busy = $state(false);

	function bounds(): { from?: string; to?: string } {
		const now = Date.now();
		if (range === 'all') return {};
		if (range === 'custom') return { from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(+new Date(to) + 86400000).toISOString() : undefined };
		const ms = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[range];
		return { from: new Date(now - ms).toISOString() };
	}
	async function load() {
		const b = bounds();
		const q = new URLSearchParams();
		if (b.from) q.set('from', b.from);
		if (b.to) q.set('to', b.to);
		data = await api('/api/overview?' + q);
		sys = await api('/api/system');
	}
	$effect(() => {
		range; from; to;
		load().catch((e) => toasts.push(e.message, true));
	});
	async function sync() {
		busy = true;
		try {
			const r = await api('/api/sync', { method: 'POST' });
			toasts.push(`Synced: ${r.sessionsImported} session(s) updated, ${r.videosNew} new video(s)`);
			await load();
		} catch (e: any) {
			toasts.push(e.message, true);
		} finally {
			busy = false;
		}
	}
	const t = $derived(data?.totals);
</script>

<div class="page">
	<div class="pagehead">
		<div><h1>Overview</h1><p>Everything shown here is counted from your library database.</p></div>
		<div class="row">
			<div class="seg" role="group" aria-label="Date range">
				{#each [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All time'], ['custom', 'Custom']] as [k, l] (k)}
					<button aria-pressed={range === k} onclick={() => (range = k as Range)}>{l}</button>
				{/each}
			</div>
			{#if range === 'custom'}<input type="date" bind:value={from} aria-label="From" /><input type="date" bind:value={to} aria-label="To" />{/if}
			<button onclick={sync} disabled={busy} title="Re-read the collector's Scroll Sessions folder (read-only)"><Icon name="sync" size={14} />Sync sessions</button>
		</div>
	</div>

	{#if !data}
		<div class="grid kpis">{#each Array(8) as _, i (i)}<div class="card kpi skel" style="height:78px"></div>{/each}</div>
	{:else}
		{#if t.uniqueVideos === 0}
			<div class="card"><div class="empty"><b>No videos yet</b>Run <span class="mono">./collect.sh</span>, then press “Sync sessions”.</div></div>
		{/if}
		<div class="grid kpis">
			<div class="card kpi"><div class="l">Unique videos</div><div class="v num">{t.uniqueVideos.toLocaleString()}</div><div class="s">{t.downloadedFiles.toLocaleString()} downloaded files</div></div>
			<div class="card kpi"><div class="l">Collected today</div><div class="v num">{t.collectedToday}</div><div class="s">since local midnight</div></div>
			<div class="card kpi"><div class="l">Sessions</div><div class="v num">{t.sessions}</div><div class="s">{t.incompleteSessions} flagged incomplete</div></div>
			<div class="card kpi"><div class="l">Disk (originals)</div><div class="v num">{bytes(t.diskBytes)}</div><div class="s">{t.missingFiles} missing files</div></div>
			<div class="card kpi"><div class="l">Analysed</div><div class="v num">{t.analysed.toLocaleString()}</div><div class="s">{t.analysisPct}% of downloaded</div></div>
			<div class="card kpi"><div class="l">Unanalysed</div><div class="v num">{t.unanalysed.toLocaleString()}</div><div class="s"><a href="/library?analysis=unanalysed" style="color:var(--accent)">Browse →</a></div></div>
			<div class="card kpi"><div class="l">Pending / failed jobs</div><div class="v num">{t.pendingJobs} / {t.failedJobs}</div><div class="s"><a href="/analysis" style="color:var(--accent)">Analysis Studio →</a></div></div>
			<div class="card kpi"><div class="l">Duplicates avoided</div><div class="v num">{t.duplicatesAvoided}</div><div class="s">re-downloads prevented</div></div>
		</div>

		<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr));margin-top:12px">
			<section class="card"><header><h2>Videos collected per day</h2><span class="faint">{data.perDay.length} day(s)</span></header>
				<div class="body"><TimeChart points={data.perDay.map((p: any) => ({ day: p.day, v: p.videos }))} /></div></section>
			<section class="card"><header><h2>Storage growth</h2><span class="faint">cumulative</span></header>
				<div class="body"><TimeChart kind="line" fmt={bytes} points={data.storageGrowth.map((p: any) => ({ day: p.day, v: p.bytes }))} /></div></section>
			<section class="card"><header><h2>By collection source</h2></header>
				<div class="body"><Bars rows={data.bySource.map((r: any) => ({ label: label(r.source), n: r.n }))} /></div></section>
			<section class="card"><header><h2>By classification</h2><span class="faint">primary category</span></header>
				<div class="body"><Bars rows={data.byClassification.map((r: any) => ({ label: r.classification === 'unclassified' ? 'Not analysed yet' : label(r.classification), n: r.n }))} /></div></section>
		</div>

		{#if sys}
			<section class="card" style="margin-top:12px"><header><h2>This machine, right now</h2><span class="faint">{when(sys.at)}</span></header>
				<div class="body grid kpis" style="gap:14px">
					<div><div class="l muted">Dashboard process</div><div class="num"><b>{sys.app.rssMB} MB</b> RSS · up {longDur(sys.app.uptimeS)}</div></div>
					<div><div class="l muted">Free RAM</div><div class="num"><b>{(sys.host.availableMB / 1024).toFixed(1)} GB</b> of {(sys.host.totalMemMB / 1024).toFixed(0)} GB · swap {sys.host.usedMB} MB</div></div>
					<div><div class="l muted">Disk free (media)</div><div class="num"><b>{bytes(sys.disk.sessions.freeBytes)}</b></div></div>
					<div><div class="l muted">GPU</div><div class="num">{#if sys.gpu.available}<b>{sys.gpu.name}</b> · {Math.round(sys.gpu.usedMB)}/{Math.round(sys.gpu.totalMB)} MB · this app: {sys.gpu.thisAppMB ?? 0} MB{:else}<span class="faint">{sys.gpu.note}</span>{/if}</div></div>
					<div><div class="l muted">Collector</div><div>{#if sys.collector.running}<span class="badge ok"><span class="dot"></span>running (pid {sys.collector.pid})</span>{:else}<span class="badge">idle</span>{/if}</div></div>
				</div></section>
		{/if}
	{/if}
</div>
