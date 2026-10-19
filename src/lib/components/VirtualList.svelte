<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	// Windowed grid/table: only the visible rows exist in the DOM, so 100k videos scroll like 100.
	let { total, getItem, need, item, placeholder, mode = 'grid', minCard = 176, rowH = 54, version = 0 }: {
		total: number;
		getItem: (i: number) => T | undefined;
		need: (from: number, to: number) => void;
		item: Snippet<[T, number]>;
		placeholder?: Snippet<[number]>;
		mode?: 'grid' | 'table';
		minCard?: number;
		rowH?: number;
		version?: number;
	} = $props();
	const gap = 10;
	let W = $state(900);
	let H = $state(600);
	let top = $state(0);
	const cols = $derived(mode === 'table' ? 1 : Math.max(1, Math.floor((W - gap) / (minCard + gap))));
	const cardW = $derived(mode === 'table' ? W : (W - gap * (cols + 1)) / cols);
	const rowHeight = $derived(mode === 'table' ? rowH : Math.round((cardW * 13) / 9 + 64 + gap));
	const rows = $derived(Math.ceil(total / cols));
	const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 2));
	const last = $derived(Math.min(rows - 1, Math.ceil((top + H) / rowHeight) + 2));
	$effect(() => {
		if (total > 0) need(first * cols, Math.min(total, (last + 1) * cols));
	});
	// `version` is read so the template re-evaluates when a page of data arrives
	const read = (i: number, _v: number) => getItem(i);
	const visibleRows = $derived(Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => first + k));
</script>

<div class="vlist" bind:clientWidth={W} bind:clientHeight={H} onscroll={(e) => (top = (e.currentTarget as HTMLElement).scrollTop)} role="list">
	<div style="height:{rows * rowHeight}px;position:relative">
		{#each visibleRows as r (r)}
			<div
				style="position:absolute;left:0;right:0;top:{r * rowHeight}px;height:{rowHeight}px;{mode === 'grid' ? `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}px;padding:${gap / 2}px ${gap}px 0` : ''}"
			>
				{#each Array.from({ length: cols }, (_, c) => r * cols + c).filter((i) => i < total) as i (i)}
					{@const it = read(i, version)}
					{#if it !== undefined}
						{@render item(it, i)}
					{:else if placeholder}
						{@render placeholder(i)}
					{:else}
						<div class="skel" style="height:{mode === 'table' ? rowH - 6 : rowHeight - gap - 4}px;border-radius:10px"></div>
					{/if}
				{/each}
			</div>
		{/each}
	</div>
</div>
