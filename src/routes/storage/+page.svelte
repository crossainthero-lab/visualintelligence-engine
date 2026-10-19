<script lang="ts">
	import { api } from '#lib/api.ts';
	import { bytes } from '#lib/format.ts';
	import { toasts } from '#lib/selection.svelte.ts';
	import TimeChart from '#lib/components/TimeChart.svelte';

	let r = $state<any>(null);
	let insp = $state<any>(null);
	let growth = $state<any>(null);
	let plan = $state<any>(null);
	let typed = $state('');
	let media = $state<any>(null);
	const colors = ['var(--accent)', 'var(--info)', 'var(--ok)', '#c084fc', '#f472b6', 'var(--text3)'];

	async function load() {
		r = await api('/api/storage');
		growth = (await api('/api/overview')).storageGrowth;
		media = await api('/api/media');
	}
	$effect(() => {
		load().catch((e) => toasts.push(e.message, true));
	});
	async function inspect() {
		insp = (await api('/api/storage?inspect=1')) ;
	}
	async function makePlan(kind: string) {
		try {
			plan = await api('/api/storage/cleanup', { method: 'POST', json: { kind } });
			typed = '';
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	async function execute() {
		try {
			const res = await api('/api/storage/cleanup', { method: 'POST', json: { planId: plan.id, confirm: typed } });
			toasts.push(`Deleted ${res.removed} file(s), freed ${bytes(res.bytes)}`);
			plan = null;
			await load();
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	async function genThumbs() {
		await api('/api/media', { method: 'POST', json: { action: 'thumbnails' } });
		toasts.push('Generating missing thumbnails in the background (one at a time, low priority)');
		setTimeout(load, 1500);
	}
	const total = $derived(r ? r.categories.reduce((a: number, c: any) => a + c.bytes, 0) : 0);
	const fs = $derived(r?.filesystem?.mediaRoot);
</script>

<div class="page">
	<div class="pagehead"><div><h1>Storage</h1><p>Measured from the files on disk, not estimated.</p></div></div>
	{#if !r}<div class="card skel" style="height:200px"></div>{:else}
		<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
			<section class="card">
				<header><h2>Usage by kind</h2><span class="num"><b>{bytes(total)}</b> total</span></header>
				<div class="body grid" style="gap:12px">
					<div class="meter" style="height:12px">{#each r.categories as c, i (c.key)}<i style="width:{total ? (c.bytes / total) * 100 : 0}%;background:{colors[i]}" title="{c.label}: {bytes(c.bytes)}"></i>{/each}</div>
					<table class="t"><tbody>{#each r.categories as c, i (c.key)}<tr><td style="width:14px"><span class="dot" style="color:{colors[i]}"></span></td><td>{c.label}</td><td class="r num">{c.files.toLocaleString()} file(s)</td><td class="r num"><b>{bytes(c.bytes)}</b></td></tr>{/each}</tbody></table>
				</div>
			</section>
			<section class="card">
				<header><h2>Filesystem</h2></header>
				<div class="body grid" style="gap:12px">
					{#if fs?.totalBytes}
						<div class="meter" style="height:12px"><i style="width:{((fs.totalBytes - fs.freeBytes) / fs.totalBytes) * 100}%;background:{fs.freeBytes / fs.totalBytes < 0.05 ? 'var(--bad)' : 'var(--accent)'}"></i></div>
						<div class="num"><b>{bytes(fs.freeBytes)}</b> free of {bytes(fs.totalBytes)} ({Math.round((fs.freeBytes / fs.totalBytes) * 100)}%)</div>
						{#if fs.freeBytes / fs.totalBytes < 0.05}<div class="notice bad">Disk is nearly full. The collector pauses at 6 GB free and stops at 2 GB (configurable in Settings).</div>{/if}
					{/if}
					<div class="faint">Media root: <span class="mono">{r.roots[0]?.path ?? 'none'}</span></div>
				</div>
			</section>
			<section class="card" style="grid-column:1/-1"><header><h2>Growth</h2><span class="faint">cumulative original media</span></header><div class="body"><TimeChart kind="line" fmt={bytes} points={(growth ?? []).map((p: any) => ({ day: p.day, v: p.bytes }))} /></div></section>
		</div>

		<section class="card" style="margin-top:12px">
			<header><h2>Maintenance</h2></header>
			<div class="body grid" style="gap:10px">
				<div class="row"><button onclick={genThumbs}>Generate missing thumbnails</button><span class="faint">{media ? `${media.thumbs.running ? `running ${media.thumbs.done}/${media.thumbs.total}` : 'idle'}` : ''}</span></div>
				<div class="row"><button onclick={() => makePlan('cache')}>Clear caches…</button><span class="faint">frames, contact sheets, shot data, proxies ({bytes(media?.cache.bytes)}) — regenerated on demand</span></div>
				<div class="row"><button onclick={() => makePlan('thumbnails')}>Delete thumbnails…</button><span class="faint">regenerated automatically</span></div>
				<div class="row"><button onclick={() => makePlan('temp')}>Clear temporary files…</button></div>
				<div class="row"><button onclick={inspect}>Inspect orphans &amp; duplicates</button><span class="faint">read-only scan</span></div>
				<p class="faint">Every delete shows the exact files first and needs a typed confirmation. Original videos are never deleted from this page.</p>
			</div>
		</section>

		{#if insp}
			<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr));margin-top:12px">
				<section class="card"><header><h2>Missing files</h2><span class="faint">{insp.orphans.missingFiles.length}</span></header>
					<div class="body">{#each insp.orphans.missingFiles as m (m.uid)}<div class="mono">{m.rel_path}</div>{:else}<span class="faint">Every database record has its file on disk.</span>{/each}</div></section>
				<section class="card"><header><h2>Orphan files</h2><span class="faint">{insp.orphans.orphanFiles.length}</span></header>
					<div class="body grid" style="gap:8px">{#each insp.orphans.orphanFiles.slice(0, 30) as o (o.path)}<div class="mono trunc">{o.path} · {bytes(o.bytes)}</div>{:else}<span class="faint">No media files without a collector record.</span>{/each}
						{#if insp.orphans.orphanFiles.length}<button class="danger sm" onclick={() => makePlan('orphan-files')}>Review deletion…</button>{/if}</div></section>
				<section class="card"><header><h2>Duplicate content</h2><span class="faint">{insp.duplicates.length} group(s)</span></header>
					<div class="body grid" style="gap:8px">{#each insp.duplicates as g (g.sha256)}<div><span class="mono faint">{g.sha256.slice(0, 12)}…</span> × {g.n}{#each g.videos as v (v.uid)}<div class="mono" style="padding-left:12px">{v.platform_id} · @{v.creator} · {bytes(v.file_size)}</div>{/each}</div>{:else}<span class="faint">No two videos share identical bytes.</span>{/each}</div></section>
			</div>
		{/if}
	{/if}
</div>

{#if plan}
	<button class="scrim" onclick={() => (plan = null)} aria-label="Cancel" style="border:0;border-radius:0;padding:0"></button>
	<div class="modal" role="dialog" aria-label="Confirm deletion">
		<h2>This will delete {plan.fileCount.toLocaleString()} file(s) · {bytes(plan.bytes)}</h2>
		<p class="muted">{plan.note}</p>
		<div class="mono" style="max-height:220px;overflow:auto;background:var(--bg2);padding:8px;border-radius:6px">{#each plan.sample as f (f)}<div class="trunc">{f}</div>{/each}{#if plan.fileCount > plan.sample.length}<div class="faint">…and {plan.fileCount - plan.sample.length} more</div>{/if}</div>
		<label class="f">Type <b class="mono">delete {plan.fileCount}</b> to confirm<input bind:value={typed} autocomplete="off" /></label>
		<div class="row" style="justify-content:flex-end"><button onclick={() => (plan = null)}>Cancel</button><button class="danger" disabled={typed !== `delete ${plan.fileCount}`} onclick={execute}>Delete</button></div>
	</div>
{/if}
