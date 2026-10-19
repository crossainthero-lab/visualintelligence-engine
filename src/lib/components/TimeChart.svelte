<script lang="ts">
	// Plain-SVG bar (daily counts) or area (cumulative) chart. No library.
	let { points, kind = 'bar', fmt = (n: number) => String(n) }: { points: Array<{ day: string; v: number }>; kind?: 'bar' | 'line'; fmt?: (n: number) => string } = $props();
	const W = 640, H = 160, L = 38, B = 20, T = 8;
	const max = $derived(Math.max(1, ...points.map((p) => p.v)));
	const x = (i: number) => L + (points.length <= 1 ? (W - L) / 2 : (i / (points.length - 1)) * (W - L - 8));
	const y = (v: number) => T + (1 - v / max) * (H - T - B);
	const bw = $derived(Math.max(3, Math.min(34, (W - L - 8) / Math.max(points.length, 1) - 6)));
	const path = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '));
	let hover = $state<number | null>(null);
</script>

{#if points.length === 0}
	<div class="faint" style="padding:30px 0;text-align:center">No data in this range.</div>
{:else}
	<svg class="chart" viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="chart">
		<line class="axis" x1={L} x2={W - 4} y1={H - B} y2={H - B} />
		<line class="axis" x1={L} x2={W - 4} y1={T} y2={T} stroke-dasharray="2 4" />
		<text x={L - 6} y={T + 4} text-anchor="end">{fmt(max)}</text>
		<text x={L - 6} y={H - B + 3} text-anchor="end">0</text>
		<text x={L} y={H - 4}>{points[0].day.slice(5)}</text>
		<text x={W - 6} y={H - 4} text-anchor="end">{points.at(-1)!.day.slice(5)}</text>
		{#if kind === 'bar'}
			{#each points as p, i (p.day)}
				<rect class="bar" x={x(i) - bw / 2} y={y(p.v)} width={bw} height={Math.max(1, H - B - y(p.v))} rx="2" role="presentation" onmouseenter={() => (hover = i)} onmouseleave={() => (hover = null)} />
			{/each}
		{:else}
			<path class="ar" d="{path} L{x(points.length - 1)},{H - B} L{x(0)},{H - B} Z" />
			<path class="ln" d={path} />
			{#each points as p, i (p.day)}<circle cx={x(i)} cy={y(p.v)} r="6" fill="transparent" role="presentation" onmouseenter={() => (hover = i)} onmouseleave={() => (hover = null)} />{/each}
		{/if}
		{#if hover != null}
			<g>
				<rect x={Math.min(W - 118, Math.max(L, x(hover) - 55))} y={2} width="112" height="30" rx="5" fill="var(--surface2)" stroke="var(--line2)" />
				<text x={Math.min(W - 118, Math.max(L, x(hover) - 55)) + 8} y={14} style="fill:var(--text2)">{points[hover].day}</text>
				<text x={Math.min(W - 118, Math.max(L, x(hover) - 55)) + 8} y={26} style="fill:var(--text);font-weight:600">{fmt(points[hover].v)}</text>
			</g>
		{/if}
	</svg>
{/if}
