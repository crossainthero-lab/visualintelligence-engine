<script lang="ts">
	import { page } from '$app/state';
	import { api } from '#lib/api.ts';
	import { bytes, dur, label, longDur, res, when } from '#lib/format.ts';
	import { selection, toasts } from '#lib/selection.svelte.ts';
	import VideoDrawer from '#lib/components/VideoDrawer.svelte';

	const id = $derived(page.params.id);
	let d = $state<any>(null);
	let filter = $state('');
	let tab = $state<'videos' | 'log' | 'errors'>('videos');
	let log = $state<any>(null);
	let open = $state<string | null>(null);
	$effect(() => {
		d = null;
		api(`/api/sessions/${id}?limit=500${filter ? '&status=' + filter : ''}`).then((r) => (d = r)).catch((e) => toasts.push(e.message, true));
	});
	$effect(() => {
		if (tab === 'log' && !log) api(`/api/sessions/${id}?limit=1&log=1`).then((r) => (log = r.log));
	});
	const s = $derived(d?.session);
	const selectable = $derived((d?.videos.videos ?? []).filter((v: any) => v.download_status === 'downloaded').map((v: any) => v.uid));
	const allSel = $derived(selectable.length > 0 && selectable.every((u: string) => selection.has(u)));
</script>

<div class="page">
	<div class="pagehead">
		<div><a href="/sessions" class="faint">← Sessions</a><h1 class="mono" style="font-size:18px;margin-top:4px">{id}</h1></div>
		<div class="row">
			<a class="btn" href="/library?session={id}">Open in Library</a>
			<a class="btn primary" href="/analysis?session={id}">Analyse this session…</a>
		</div>
	</div>
	{#if !d}<div class="card skel" style="height:200px"></div>{:else}
		{#if s.incomplete}<div class="notice warn" style="margin-bottom:12px"><b>Incomplete record.</b> {s.incomplete_reason}. Counts reflect the last time the collector wrote its metadata.</div>{/if}
		<div class="grid kpis" style="margin-bottom:12px">
			<div class="card kpi"><div class="l">Started</div><div class="v" style="font-size:15px">{when(s.started_at)}</div><div class="s">{s.ended_at ? 'ended ' + when(s.ended_at) : 'no end recorded'}</div></div>
			<div class="card kpi"><div class="l">Duration</div><div class="v">{s.duration_s != null ? longDur(s.duration_s) : '—'}</div><div class="s">{s.incomplete ? 'estimated from last activity' : 'recorded'}</div></div>
			<div class="card kpi"><div class="l">Method</div><div class="v" style="font-size:15px">{label(s.mode)} · {label(s.source_kind)}</div><div class="s">{s.stop_reason ?? ''}</div></div>
			<div class="card kpi"><div class="l">Encountered</div><div class="v num">{s.encountered}</div><div class="s">{s.skipped} skipped · {s.queued} unfinished</div></div>
			<div class="card kpi"><div class="l">Downloaded</div><div class="v num">{s.downloaded}</div><div class="s">{s.duplicates} duplicates avoided</div></div>
			<div class="card kpi"><div class="l">Failed / unavailable</div><div class="v num">{s.failed} / {s.unavailable}</div></div>
			<div class="card kpi"><div class="l">New disk use</div><div class="v num">{bytes(s.disk_bytes_new)}</div><div class="s">{bytes(s.bytes_downloaded)} recorded by collector</div></div>
			{#if s.resources}<div class="card kpi"><div class="l">Peak (collector)</div><div class="v" style="font-size:15px">{Math.round(s.resources.peak?.owned_rss_mb ?? 0)} MB RAM</div><div class="s">GPU {Math.round(s.resources.peak?.owned_gpu_mb ?? 0)} MB · {s.resources.browser_recycles ?? 0} restarts</div></div>{/if}
		</div>

		<div class="row" style="margin-bottom:10px">
			<div class="seg">{#each [['videos', 'Videos'], ['errors', `Errors (${s.errors.length})`], ['log', 'Collector log']] as [k, l] (k)}<button aria-pressed={tab === k} onclick={() => (tab = k as any)}>{l}</button>{/each}</div>
			{#if tab === 'videos'}
				<select bind:value={filter} aria-label="Status"><option value="">All statuses</option>{#each ['downloaded', 'duplicate', 'skipped', 'failed', 'unavailable', 'queued', 'downloading'] as x (x)}<option value={x}>{x}</option>{/each}</select>
				<span class="grow"></span>
				<button disabled={!selectable.length} onclick={() => (allSel ? selection.removeMany(selectable) : selection.addMany(selectable))}>{allSel ? 'Deselect' : 'Select'} all downloaded ({selectable.length})</button>
			{/if}
		</div>

		{#if tab === 'videos'}
			<div class="card" style="overflow:auto"><table class="t">
				<thead><tr><th style="width:28px"></th><th>#</th><th></th><th>Creator</th><th>Caption</th><th class="r">Dur</th><th>Res</th><th class="r">Size</th><th>State</th><th>Analysis</th></tr></thead>
				<tbody>
					{#each d.videos.videos as v (v.uid)}
						<tr>
							<td>{#if v.download_status === 'downloaded'}<input type="checkbox" checked={selection.has(v.uid)} onchange={() => selection.toggle(v.uid)} aria-label="Select" />{/if}</td>
							<td class="faint num">{v.position}</td>
							<td>{#if v.has_thumb}<img src="/api/videos/{v.uid}/thumb" alt="" width="28" height="40" style="object-fit:cover;border-radius:3px;display:block" loading="lazy" />{/if}</td>
							<td><button class="ghost sm" onclick={() => (open = v.uid)}>@{v.creator ?? 'unknown'}</button></td>
							<td class="trunc muted" style="max-width:340px">{v.caption ?? ''}</td>
							<td class="r num">{dur(v.duration_s)}</td><td class="num">{res(v.width, v.height)}</td><td class="r num">{bytes(v.file_size)}</td>
							<td><span class="badge {v.session_status === 'downloaded' ? 'ok' : v.session_status === 'failed' ? 'bad' : ''}">{v.session_status}</span></td>
							<td>{v.analysis_status === 'analysed' ? label(v.cur_primary) : '—'}</td>
						</tr>
					{:else}<tr><td colspan="10" class="empty">No videos with this status.</td></tr>{/each}
				</tbody></table></div>
			<p class="faint" style="margin-top:8px">{d.videos.total} entr{d.videos.total === 1 ? 'y' : 'ies'}{d.videos.total > 500 ? ' (first 500 shown)' : ''}. Selecting only marks videos for the Studio; nothing is analysed until you start a job there.</p>
		{:else if tab === 'errors'}
			<div class="card">{#if !s.errors.length}<div class="empty">No errors were recorded for this session.</div>{:else}<table class="t"><thead><tr><th>Video</th><th>Status</th><th>Error</th></tr></thead><tbody>{#each s.errors as e (e.video + e.error)}<tr><td class="mono">{e.video}</td><td>{e.status}</td><td class="muted">{e.error}</td></tr>{/each}</tbody></table>{/if}</div>
		{:else}
			<div class="card"><div class="body">{#if !log}<div class="skel" style="height:120px"></div>{:else}{#if log.truncated}<p class="faint">Showing the last 64 KB.</p>{/if}<pre class="mono" style="margin:0;white-space:pre-wrap;max-height:520px;overflow:auto;color:var(--text2)">{log.text}</pre>{/if}</div></div>
		{/if}
	{/if}
</div>
{#if open}<VideoDrawer uid={open} onclose={() => (open = null)} onchanged={() => {}} />{/if}
