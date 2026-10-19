<script lang="ts">
	let { rows, fmt = (n: number) => String(n) }: { rows: Array<{ label: string; n: number }>; fmt?: (n: number) => string } = $props();
	const max = $derived(Math.max(1, ...rows.map((r) => r.n)));
</script>

<div class="bars">
	{#each rows as r (r.label)}
		<div class="b">
			<span class="trunc" title={r.label}>{r.label}</span>
			<div class="track"><div class="fill" style:width="{(r.n / max) * 100}%"></div></div>
			<span class="num" style="text-align:right">{fmt(r.n)}</span>
		</div>
	{:else}
		<div class="faint">No data in this range.</div>
	{/each}
</div>
