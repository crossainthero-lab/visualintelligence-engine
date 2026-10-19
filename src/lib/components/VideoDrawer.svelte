<script lang="ts">
	import { api } from '#lib/api.ts';
	import { bytes, dur, label, pct, res, when } from '#lib/format.ts';
	import Icon from './Icon.svelte';
	import { toasts } from '#lib/selection.svelte.ts';

	let { uid, onclose, onchanged, onnav }: { uid: string; onclose: () => void; onchanged: (v: any) => void; onnav?: (d: -1 | 1) => void } = $props();
	let v = $state<any>(null);
	let tax = $state<any>(null);
	let notes = $state('');
	let tagText = $state('');
	let hist = $state<any[]>([]);
	let addKind = $state('technique');
	let addKey = $state('');

	async function load() {
		v = await api('/api/videos/' + uid);
		notes = v.notes ?? '';
		hist = (await api('/api/analysis?video=' + uid)).analyses;
	}
	$effect(() => {
		uid;
		load().catch((e) => toasts.push(e.message, true));
	});
	$effect(() => {
		api('/api/taxonomy').then((t) => (tax = t));
	});
	async function patch(body: any) {
		try {
			v = await api('/api/videos/' + uid, { method: 'PATCH', json: body });
			notes = v.notes ?? '';
			onchanged(v);
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	function key(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
		if (e.key === 'Escape') onclose();
		if (e.key === 'ArrowLeft') onnav?.(-1);
		if (e.key === 'ArrowRight') onnav?.(1);
	}
	const labelsBy = (k: string) => (v?.labels ?? []).filter((l: any) => l.kind === k);
	const terms = $derived(tax?.terms?.[addKind] ?? []);
</script>

<svelte:window onkeydown={key} />
<button class="scrim" onclick={onclose} aria-label="Close" style="border:0;border-radius:0;padding:0"></button>
<aside class="drawer" aria-label="Video details">
	<header>
		<b class="trunc grow">@{v?.creator ?? '…'} <span class="faint mono">{v?.platform_id ?? ''}</span></b>
		{#if onnav}<button class="ghost sm" onclick={() => onnav(-1)} title="Previous (←)">←</button><button class="ghost sm" onclick={() => onnav(1)} title="Next (→)">→</button>{/if}
		<button class="ghost sm" onclick={onclose} aria-label="Close"><Icon name="close" size={14} /></button>
	</header>
	{#if !v}
		<div class="sec"><div class="skel" style="height:300px;border-radius:8px"></div></div>
	{:else}
		<div class="sec" style="padding-top:12px">
			{#if v.download_status === 'downloaded' && !v.file_missing}
				{#key uid}<!-- svelte-ignore a11y_media_has_caption --><video controls preload="metadata" poster="/api/videos/{uid}/thumb" src="/api/videos/{uid}/stream"></video>{/key}
			{:else}
				<div class="notice warn">No playable file: status <b>{v.download_status}</b>{v.file_missing ? ' (file missing on disk)' : ''}.</div>
			{/if}
			<div class="row">
				<button class:primary={v.bookmarked} onclick={() => patch({ bookmarked: !v.bookmarked })}><Icon name="star" size={14} />{v.bookmarked ? 'Bookmarked' : 'Bookmark'}</button>
				<a class="btn" href="/analysis?video={uid}"><Icon name="studio" size={14} />Analyse…</a>
				{#if v.url}<a class="btn" href={v.url} target="_blank" rel="noreferrer">Open original ↗</a>{/if}
			</div>
		</div>

		<div class="sec">
			<h3>Classification {#if v.analysis_status !== 'analysed'}<span class="badge" style="margin-left:6px">not analysed</span>{/if}</h3>
			{#if v.cur_summary}<p>{v.cur_summary}</p>{/if}
			{#if v.cur_useful}
				<div class="row">
					<span class="badge {v.cur_useful === 'useful' ? 'ok' : v.cur_useful === 'not_useful' ? 'bad' : 'warn'}">{label(v.cur_useful)}</span>
					<span class="muted">relevance {pct(v.cur_relevance)} · confidence {pct(v.cur_confidence)}</span>
					<select aria-label="Override verdict" onchange={(e) => patch({ research: { useful: e.currentTarget.value || null } })}>
						<option value="">Correct verdict…</option><option value="useful">Useful</option><option value="not_useful">Not useful</option><option value="uncertain">Uncertain</option>
					</select>
				</div>
			{/if}
			{#each ['category', 'technique', 'observation'] as k (k)}
				{#if labelsBy(k).length}
					<div><div class="faint" style="font-size:11.5px;margin-bottom:4px">{label(k)}s</div>
						<div class="chips">
							{#each labelsBy(k) as l (l.key)}
								<span class="badge {l.source === 'human' ? 'accent' : ''}" title="{l.source} · confidence {pct(l.confidence)}">{label(l.key)} <span class="faint">{pct(l.confidence)}</span>
									<button class="ghost sm" style="padding:0 2px" title="Remove this label (keeps the agent's original output)" onclick={() => patch({ label: { kind: k, key: l.key, action: 'reject' } })}>×</button></span>
							{/each}
						</div></div>
				{/if}
			{/each}
			<div class="row">
				<select bind:value={addKind} aria-label="Kind"><option value="category">Category</option><option value="technique">Technique</option><option value="observation">Observation</option></select>
				<select bind:value={addKey} aria-label="Label"><option value="">Add label…</option>{#each terms as t (t.key)}<option value={t.key}>{t.label}</option>{/each}</select>
				<button class="sm" disabled={!addKey} onclick={() => (patch({ label: { kind: addKind, key: addKey, action: 'add' } }), (addKey = ''))}>Add</button>
			</div>
			<p class="faint" style="font-size:11.5px">Your corrections are stored separately and never overwrite what the agent said.</p>
		</div>

		<div class="sec">
			<h3>Tags &amp; notes</h3>
			<div class="chips">
				{#each v.tags as t (t)}<span class="badge">{t} <button class="ghost sm" style="padding:0 2px" onclick={() => patch({ removeTags: [t] })}>×</button></span>{/each}
				<form class="row" onsubmit={(e) => (e.preventDefault(), tagText.trim() && (patch({ addTags: tagText.split(',') }), (tagText = '')))}><input placeholder="add tag, comma-separated" bind:value={tagText} style="width:200px" /></form>
			</div>
			<textarea placeholder="Personal notes…" bind:value={notes} onblur={() => notes !== (v.notes ?? '') && patch({ notes })}></textarea>
		</div>

		<div class="sec">
			<h3>Media</h3>
			<dl class="kv num">
				<dt>Duration</dt><dd>{dur(v.duration_s)}</dd>
				<dt>Resolution</dt><dd>{res(v.width, v.height)} {v.fps ? `· ${v.fps} fps` : ''}</dd>
				<dt>Codecs</dt><dd>{v.video_codec ?? 'unknown'} / {v.audio_codec ?? (v.has_audio === false ? 'no audio' : 'unknown')}</dd>
				<dt>Size</dt><dd>{bytes(v.file_size)}</dd>
				<dt>SHA-256</dt><dd class="mono">{v.sha256?.slice(0, 24) ?? 'unknown'}…</dd>
				<dt>Posted</dt><dd>{when(v.posted_at, false)}</dd>
				<dt>First collected</dt><dd>{when(v.first_collected_at)}</dd>
				<dt>Source</dt><dd>{label(v.source_kind)}</dd>
				<dt>Caption</dt><dd>{v.caption ?? 'unknown'}</dd>
			</dl>
		</div>

		<div class="sec">
			<h3>Seen in {v.sessions.length} session(s)</h3>
			{#each v.sessions as s (s.session_id)}
				<div class="row"><a href="/sessions/{s.session_id}" class="mono" style="color:var(--accent)">{s.session_id}</a>
					<span class="badge {s.status === 'downloaded' ? 'ok' : ''}">{s.status}</span>
					{#if s.source}<span class="faint">{label(s.source.kind)}{s.source.collection ? ' · ' + s.source.collection : ''}</span>{/if}</div>
			{/each}
		</div>

		<div class="sec">
			<h3>Analysis history</h3>
			{#each hist as a (a.uid)}
				<div class="row"><span class="badge {a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'bad' : ''}">{a.status}</span>
					<span class="mono">{a.provider}{a.model ? ' · ' + a.model : ''}</span><span class="faint">{a.profile} · {when(a.completed_at ?? a.created_at)}</span></div>
				{#if a.error}<div class="faint" style="font-size:11.5px">{a.error}</div>{/if}
			{:else}<span class="faint">Never analysed. Analysis only runs when you start it.</span>{/each}
		</div>
	{/if}
</aside>
