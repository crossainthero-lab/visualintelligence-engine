<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.ts';
	import { bytes, dur, label, pct, res, when } from '#lib/format.ts';
	import { selection, toasts } from '#lib/selection.svelte.ts';
	import Icon from '#lib/components/Icon.svelte';
	import VirtualList from '#lib/components/VirtualList.svelte';
	import VideoDrawer from '#lib/components/VideoDrawer.svelte';

	const PAGE = 120;
	const P = $derived(page.url.searchParams);
	const P0 = page.url.searchParams;
	const filterQS = $derived.by(() => {
		const q = new URLSearchParams(P.toString());
		q.delete('open');
		return q.toString();
	});

	let view = $state<'grid' | 'table'>('grid');
	let showFilters = $state(false);
	let total = $state(0);
	let pages = $state.raw<Record<number, any[]>>({});
	let ver = $state(0);
	let inflight = new Set<number>();
	let gen = 0;
	let sessions = $state<any[]>([]);
	let tax = $state<any>(null);
	let open = $state<string | null>(null);
	let lastClicked = $state<number | null>(null);
	let search = $state(P0.get('q') ?? '');
	let timer: ReturnType<typeof setTimeout>;

	$effect(() => {
		try {
			view = (localStorage.getItem('vie-view') as any) || 'grid';
		} catch {
			/* ignore */
		}
		api('/api/sessions?limit=500').then((r) => (sessions = r.sessions));
		api('/api/taxonomy').then((t) => (tax = t));
	});
	function setView(v: 'grid' | 'table') {
		view = v;
		try {
			localStorage.setItem('vie-view', v);
		} catch {
			/* ignore */
		}
	}

	function setParam(k: string, v: string | null) {
		const q = new URLSearchParams(page.url.searchParams.toString());
		v ? q.set(k, v) : q.delete(k);
		goto('?' + q.toString(), { replace: true, reset: false });
	}
	function toggleList(k: string, v: string) {
		const cur = (P.get(k) ?? '').split(',').filter(Boolean);
		const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
		setParam(k, next.join(',') || null);
	}
	const has = (k: string, v: string) => (P.get(k) ?? '').split(',').includes(v);

	function onSearch(v: string) {
		search = v;
		clearTimeout(timer);
		timer = setTimeout(() => setParam('q', v.trim() || null), 250);
	}

	// ---- paged data source: only the visible window is fetched ---------------------------------------------------
	async function fetchPage(p: number) {
		if (pages[p] || inflight.has(p)) return;
		inflight.add(p);
		const my = gen;
		try {
			const r = await api(`/api/videos?${filterQS}&limit=${PAGE}&offset=${p * PAGE}`);
			if (my !== gen) return;
			total = r.total;
			pages = { ...pages, [p]: r.videos };
			ver++;
		} catch (e: any) {
			toasts.push(e.message, true);
		} finally {
			inflight.delete(p);
		}
	}
	$effect(() => {
		filterQS;
		untrack(() => {
			gen++;
			pages = {};
			inflight.clear();
			ver++;
			fetchPage(0);
		});
	});
	const getItem = (i: number) => pages[Math.floor(i / PAGE)]?.[i % PAGE];
	function need(from: number, to: number) {
		for (let p = Math.floor(from / PAGE); p <= Math.floor(Math.max(from, to - 1) / PAGE); p++) fetchPage(p);
	}

	function click(v: any, i: number, e: MouseEvent) {
		if (e.shiftKey && lastClicked != null) {
			const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
			const ids: string[] = [];
			for (let k = a; k <= b; k++) {
				const it = getItem(k);
				if (it) ids.push(it.uid);
			}
			selection.addMany(ids);
		} else if (e.metaKey || e.ctrlKey) {
			selection.toggle(v.uid);
		} else {
			open = v.uid;
			setParam('open', v.uid);
		}
		lastClicked = i;
	}
	function check(v: any, i: number, e: Event) {
		e.stopPropagation();
		if ((e as MouseEvent).shiftKey && lastClicked != null) click(v, i, e as MouseEvent);
		else (selection.toggle(v.uid), (lastClicked = i));
	}
	function drawerNav(d: -1 | 1) {
		const idx = [...Array(total).keys()].find((i) => getItem(i)?.uid === open);
		if (idx == null) return;
		const n = getItem(idx + d);
		if (n) open = n.uid;
	}
	function patched(v: any) {
		for (const [p, list] of Object.entries(pages)) {
			const k = list.findIndex((x) => x.uid === v.uid);
			if (k >= 0) {
				const copy = list.slice();
				copy[k] = { ...copy[k], ...v };
				pages = { ...pages, [p]: copy };
				ver++;
			}
		}
	}
	async function selectAllMatching() {
		const r = await api(`/api/videos?${filterQS}&uidsOnly=1&max=5000`);
		selection.addMany(r.uids);
		toasts.push(`Selected ${r.uids.length.toLocaleString()} video(s). Nothing will be analysed until you start it in the Studio.`);
	}
	async function bulk(action: string, tags?: string[]) {
		try {
			const r = await api('/api/videos/bulk', { method: 'POST', json: { uids: selection.list(), action, tags } });
			toasts.push(`${r.affected} video(s) updated`);
			gen++;
			pages = {};
			fetchPage(0);
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	let bulkTag = $state('');
	const activeFilters = $derived([...P.keys()].filter((k) => !['open', 'sort', 'dir'].includes(k)).length);
	const visibleSelected = $derived(selection.size);
	const mb = (n: string | null) => (n ? String(Number(n) / 1048576) : '');
</script>

<div class="page">
	<div class="pagehead">
		<div><h1>Video Library</h1><p class="num">{total.toLocaleString()} video{total === 1 ? '' : 's'}{activeFilters ? ' match your filters' : ''}</p></div>
		<div class="row">
			<div class="seg"><button aria-pressed={view === 'grid'} onclick={() => setView('grid')} title="Grid"><Icon name="grid" size={14} /></button><button aria-pressed={view === 'table'} onclick={() => setView('table')} title="Table"><Icon name="list" size={14} /></button></div>
		</div>
	</div>

	<div class="card" style="margin-bottom:12px">
		<div class="row" style="padding:10px 12px">
			<div class="row grow" style="position:relative;min-width:220px">
				<span style="position:absolute;left:9px;color:var(--text3)"><Icon name="search" size={14} /></span>
				<input style="width:100%;padding-left:30px" placeholder="Search caption, creator, id, notes, tags…" value={search} oninput={(e) => onSearch(e.currentTarget.value)} />
			</div>
			<div class="seg" role="group" aria-label="Analysis state">
				{#each [['', 'All'], ['analysed', 'Analysed'], ['unanalysed', 'Unanalysed']] as [k, l] (k)}<button aria-pressed={(P.get('analysis') ?? '') === k} onclick={() => setParam('analysis', k || null)}>{l}</button>{/each}
			</div>
			<select aria-label="Sort" value={P.get('sort') ?? 'collected'} onchange={(e) => setParam('sort', e.currentTarget.value === 'collected' ? null : e.currentTarget.value)}>
				<option value="collected">Collected</option><option value="posted">Posted</option><option value="size">File size</option><option value="duration">Duration</option><option value="resolution">Resolution</option><option value="relevance">Relevance</option><option value="creator">Creator</option>
			</select>
			<button class="ghost" onclick={() => setParam('dir', (P.get('dir') ?? 'desc') === 'desc' ? 'asc' : null)} title="Sort direction">{(P.get('dir') ?? 'desc') === 'desc' ? '↓' : '↑'}</button>
			<button onclick={() => (showFilters = !showFilters)} aria-expanded={showFilters}><Icon name="filter" size={14} />Filters{activeFilters ? ` · ${activeFilters}` : ''}</button>
			{#if activeFilters}<button class="ghost" onclick={() => goto('/library', { replace: true })}>Clear</button>{/if}
		</div>
		<div class="row" style="padding:0 12px 10px">
			<span class="faint">Quick:</span>
			<div class="chips">
				{#each [['motionGraphics', 'Motion graphics'], ['aiFilm', 'AI film'], ['threeD', '3D'], ['interestingTechnique', 'Interesting technique']] as [k, l] (k)}
					<button class="badge chip" aria-pressed={has('group', k)} onclick={() => toggleList('group', k)}>{l}</button>
				{/each}
				<button class="badge chip" aria-pressed={P.get('bookmarked') === '1'} onclick={() => setParam('bookmarked', P.get('bookmarked') === '1' ? null : '1')}><Icon name="star" size={11} />Bookmarked</button>
			</div>
		</div>
		{#if showFilters}
			<div class="filters">
				<label class="f">Session<select value={P.get('session') ?? ''} onchange={(e) => setParam('session', e.currentTarget.value || null)}><option value="">Any</option>{#each sessions as s (s.id)}<option value={s.id}>{s.id} · {s.downloaded} dl</option>{/each}</select></label>
				<label class="f">Creator<input value={P.get('creator') ?? ''} placeholder="username" onchange={(e) => setParam('creator', e.currentTarget.value.trim() || null)} /></label>
				<label class="f">Collected from<input type="date" value={P.get('from')?.slice(0, 10) ?? ''} onchange={(e) => setParam('from', e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : null)} /></label>
				<label class="f">Collected to<input type="date" value={P.get('to')?.slice(0, 10) ?? ''} onchange={(e) => setParam('to', e.currentTarget.value ? new Date(+new Date(e.currentTarget.value) + 864e5).toISOString() : null)} /></label>
				<label class="f">Min size (MB)<input type="number" min="0" value={mb(P.get('minSize'))} onchange={(e) => setParam('minSize', e.currentTarget.value ? String(Number(e.currentTarget.value) * 1048576) : null)} /></label>
				<label class="f">Max size (MB)<input type="number" min="0" value={mb(P.get('maxSize'))} onchange={(e) => setParam('maxSize', e.currentTarget.value ? String(Number(e.currentTarget.value) * 1048576) : null)} /></label>
				<label class="f">Min duration (s)<input type="number" min="0" value={P.get('minDuration') ?? ''} onchange={(e) => setParam('minDuration', e.currentTarget.value || null)} /></label>
				<label class="f">Max duration (s)<input type="number" min="0" value={P.get('maxDuration') ?? ''} onchange={(e) => setParam('maxDuration', e.currentTarget.value || null)} /></label>
				<label class="f">Min resolution<select value={P.get('minHeight') ?? ''} onchange={(e) => setParam('minHeight', e.currentTarget.value || null)}><option value="">Any</option><option value="720">720p+</option><option value="1080">1080p+</option><option value="1440">1440p+</option><option value="2160">4K</option></select></label>
				<label class="f">Verdict<select value={P.get('useful') ?? ''} onchange={(e) => setParam('useful', e.currentTarget.value || null)}><option value="">Any</option><option value="useful">Useful</option><option value="uncertain">Uncertain</option><option value="not_useful">Not useful</option></select></label>
				<label class="f">Min confidence %<input type="number" min="0" max="100" value={P.get('minConfidence') ? Number(P.get('minConfidence')) * 100 : ''} onchange={(e) => setParam('minConfidence', e.currentTarget.value ? String(Number(e.currentTarget.value) / 100) : null)} /></label>
				<label class="f">Min relevance %<input type="number" min="0" max="100" value={P.get('minRelevance') ? Number(P.get('minRelevance')) * 100 : ''} onchange={(e) => setParam('minRelevance', e.currentTarget.value ? String(Number(e.currentTarget.value) / 100) : null)} /></label>
				<label class="f">Source<select value={P.get('source') ?? ''} onchange={(e) => setParam('source', e.currentTarget.value || null)}><option value="">Any</option><option value="reels_feed">Reels feed</option><option value="saved">Saved</option><option value="creator">Creator</option></select></label>
				<label class="f">Tag<select value={P.get('tag') ?? ''} onchange={(e) => setParam('tag', e.currentTarget.value || null)}><option value="">Any</option>{#each tax?.tags ?? [] as t (t.name)}<option value={t.name}>{t.name} ({t.n})</option>{/each}</select></label>
				<div class="f" style="grid-column:1/-1">Classification (any of)
					<div class="chips">{#each tax?.terms.category ?? [] as t (t.key)}<button class="badge chip" aria-pressed={has('category', t.key)} onclick={() => toggleList('category', t.key)}>{t.label}</button>{/each}</div></div>
				<div class="f" style="grid-column:1/-1">Technique (any of)
					<div class="chips">{#each tax?.terms.technique ?? [] as t (t.key)}<button class="badge chip" aria-pressed={has('technique', t.key)} onclick={() => toggleList('technique', t.key)}>{t.label}</button>{/each}</div></div>
				<div class="f" style="grid-column:1/-1">Specific observations (any of)
					<div class="chips">{#each tax?.terms.observation ?? [] as t (t.key)}<button class="badge chip" aria-pressed={has('observation', t.key)} onclick={() => toggleList('observation', t.key)}>{t.label}</button>{/each}</div></div>
			</div>
		{/if}
	</div>

	{#if total === 0 && Object.keys(pages).length}
		<div class="card"><div class="empty"><b>No videos match</b>{activeFilters ? 'Try clearing a filter.' : 'Collect some videos, then press “Sync sessions” on the Overview.'}</div></div>
	{:else}
		<VirtualList {total} {getItem} {need} mode={view} version={ver} minCard={176}>
			{#snippet item(v: any, i: number)}
				{#if view === 'grid'}
					<div class="vcard" class:sel={selection.has(v.uid)} onclick={(e) => click(v, i, e)} onkeydown={(e) => e.key === 'Enter' && (open = v.uid)} role="button" tabindex="0" aria-label="Open video by {v.creator}">
						<label class="chk"><input type="checkbox" checked={selection.has(v.uid)} onclick={(e) => check(v, i, e)} aria-label="Select" /></label>
						{#if v.bookmarked}<span class="star"><Icon name="star" size={14} /></span>{/if}
						<div class="th" style={v.has_thumb ? `background-image:url(/api/videos/${v.uid}/thumb)` : ''}>
							{#if !v.has_thumb}<img src="/api/videos/{v.uid}/thumb" alt="" loading="lazy" style="display:none" onload={(e) => ((e.currentTarget.parentElement as HTMLElement).style.backgroundImage = `url(/api/videos/${v.uid}/thumb)`)} />{/if}
							<div class="tl">
								<span class="badge num">{dur(v.duration_s)}</span>
								{#if v.analysis_status === 'analysed'}<span class="badge ok">{label(v.cur_primary)}</span>{:else if v.analysis_status === 'queued' || v.analysis_status === 'running'}<span class="badge info">{v.analysis_status}</span>{:else if v.analysis_status === 'failed'}<span class="badge bad">failed</span>{/if}
							</div>
						</div>
						<div class="meta">
							<span class="c trunc">@{v.creator ?? 'unknown'}</span>
							<span class="faint trunc num">{res(v.width, v.height)} · {bytes(v.file_size)}</span>
							<span class="faint trunc">{when(v.first_collected_at, false)}{v.cur_relevance != null ? ` · rel ${pct(v.cur_relevance)}` : ''}</span>
						</div>
					</div>
				{:else}
					<div class="vrow" class:sel={selection.has(v.uid)} style="height:100%;grid-template-columns:22px 32px minmax(120px,1.1fr) minmax(0,2fr) 70px 110px 80px 130px 110px" onclick={(e) => click(v, i, e)} onkeydown={(e) => e.key === 'Enter' && (open = v.uid)} role="button" tabindex="0">
						<input type="checkbox" checked={selection.has(v.uid)} onclick={(e) => check(v, i, e)} aria-label="Select" />
						<div class="rt" style={v.has_thumb ? `background-image:url(/api/videos/${v.uid}/thumb)` : ''}></div>
						<span class="trunc"><b>@{v.creator ?? 'unknown'}</b> {#if v.bookmarked}<Icon name="star" size={11} />{/if}</span>
						<span class="trunc muted">{v.caption ?? ''}</span>
						<span class="num">{dur(v.duration_s)}</span><span class="num trunc">{res(v.width, v.height)}</span><span class="num">{bytes(v.file_size)}</span>
						<span class="trunc">{#if v.analysis_status === 'analysed'}<span class="badge ok">{label(v.cur_primary)}</span>{:else}<span class="badge">{v.analysis_status === 'none' ? 'not analysed' : v.analysis_status}</span>{/if}</span>
						<span class="faint num">{when(v.first_collected_at, false)}</span>
					</div>
				{/if}
			{/snippet}
		</VirtualList>
	{/if}

	{#if visibleSelected}
		<div class="tray" role="region" aria-label="Selection">
			<b class="num">{visibleSelected.toLocaleString()} selected</b>
			<button class="sm" onclick={selectAllMatching}>Select all {total.toLocaleString()} matching</button>
			<button class="sm" onclick={() => bulk('bookmark')}><Icon name="star" size={12} />Bookmark</button>
			<button class="sm" onclick={() => bulk('unbookmark')}>Unbookmark</button>
			<form class="row" onsubmit={(e) => (e.preventDefault(), bulkTag.trim() && (bulk('tag', bulkTag.split(',')), (bulkTag = '')))}>
				<input placeholder="tag selected…" bind:value={bulkTag} style="width:130px" />
			</form>
			<span class="grow"></span>
			<span class="faint">Selecting does not analyse anything.</span>
			<a class="btn primary" href="/analysis">Open in Analysis Studio →</a>
			<button class="ghost" onclick={() => selection.clear()}>Clear</button>
		</div>
	{/if}
</div>

{#if open}
	<VideoDrawer uid={open} onclose={() => ((open = null), setParam('open', null))} onchanged={patched} onnav={drawerNav} />
{/if}
