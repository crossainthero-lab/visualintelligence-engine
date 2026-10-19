<script lang="ts">
	import { api } from '#lib/api.ts';
	import { bytes, label, longDur, when } from '#lib/format.ts';
	import { toasts } from '#lib/selection.svelte.ts';
	let data = $state<any>(null);
	let status = $state('');
	$effect(() => {
		api('/api/sessions?limit=500' + (status ? '&status=' + status : '')).then((d) => (data = d)).catch((e) => toasts.push(e.message, true));
	});
	const tone = (s: string) => (s === 'completed' ? 'ok' : s === 'error' ? 'bad' : 'warn');
</script>

<div class="page">
	<div class="pagehead">
		<div><h1>Sessions</h1><p>Every scrolling run is recorded. Sessions that ended without a clean shutdown are flagged <span class="badge warn">incomplete</span> rather than guessed.</p></div>
		<div class="seg">{#each [['', 'All'], ['completed', 'Completed'], ['interrupted', 'Interrupted'], ['error', 'Error']] as [k, l] (k)}<button aria-pressed={status === k} onclick={() => (status = k)}>{l}</button>{/each}</div>
	</div>
	<div class="card" style="overflow:auto">
		{#if !data}
			<div class="body skel" style="height:240px"></div>
		{:else if !data.sessions.length}
			<div class="empty"><b>No sessions</b>Run ./collect.sh to create one.</div>
		{:else}
			<table class="t">
				<thead><tr><th>Session</th><th>Started</th><th class="r">Duration</th><th>Method</th><th>Source</th><th class="r">Seen</th><th class="r">Downloaded</th><th class="r">Dupes</th><th class="r">Failed</th><th class="r">New data</th><th class="r">Analysed</th><th>Status</th></tr></thead>
				<tbody>
					{#each data.sessions as s (s.id)}
						<tr>
							<td><a href="/sessions/{s.id}" class="mono" style="color:var(--accent)">{s.id}</a></td>
							<td class="num">{when(s.started_at)}</td>
							<td class="r num">{s.duration_s != null ? longDur(s.duration_s) : '—'}</td>
							<td>{label(s.mode)}</td>
							<td>{label(s.source_kind)}</td>
							<td class="r num">{s.encountered}</td>
							<td class="r num">{s.downloaded}</td>
							<td class="r num">{s.duplicates}</td>
							<td class="r num">{s.failed + s.unavailable}</td>
							<td class="r num">{bytes(s.bytes_downloaded)}</td>
							<td class="r num">{s.analysed}</td>
							<td><span class="badge {tone(s.status)}">{s.status}</span>{#if s.incomplete}<span class="badge warn" title={s.incomplete_reason} style="margin-left:4px">incomplete</span>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
