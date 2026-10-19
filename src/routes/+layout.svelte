<script lang="ts">
	import '#lib/app.css';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import { selection, toasts } from '#lib/selection.svelte.ts';
	import { onMount } from 'svelte';
	let { data, children } = $props();
	let open = $state(false);
	let theme = $state('dark');
	onMount(() => (theme = document.documentElement.dataset.theme ?? 'dark'));
	function toggle() {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem('vie-theme', theme);
		} catch {
			/* private mode */
		}
	}
	const nav = [
		{ href: '/', label: 'Overview', icon: 'overview' },
		{ href: '/library', label: 'Library', icon: 'library' },
		{ href: '/sessions', label: 'Sessions', icon: 'sessions' },
		{ href: '/analysis', label: 'Analysis Studio', icon: 'studio' },
		{ href: '/storage', label: 'Storage', icon: 'storage' },
		{ href: '/settings', label: 'Settings', icon: 'settings' }
	];
	const here = (h: string) => (h === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(h));
	const counts: Record<string, () => string | number | null> = {
		'/library': () => data.videos.toLocaleString(),
		'/sessions': () => data.sessions,
		'/analysis': () => (data.activeJobs ? `${data.activeJobs} active` : null)
	};
</script>

<svelte:head><title>Visual Intelligence Engine</title></svelte:head>

{#if page.url.pathname === '/login'}
	{@render children()}
{:else}
	<div class="shell">
		<aside class="rail" class:open>
			<div class="brand">
				<span class="mark"><Icon name="studio" size={13} /></span>
				<div>Visual Intelligence<small>Research engine</small></div>
			</div>
			<nav class="nav" aria-label="Main">
				{#each nav as n (n.href)}
					<a href={n.href} aria-current={here(n.href) ? 'page' : undefined} onclick={() => (open = false)}>
						<Icon name={n.icon} />{n.label}
						{#if counts[n.href]?.()}<span class="count num">{counts[n.href]()}</span>{/if}
					</a>
				{/each}
			</nav>
			<div class="spacer"></div>
			<div class="foot">
				<div class="row" style="justify-content:space-between">
					<span class="row" style="gap:6px">
						<span class="dot" style="color:{data.collector.running ? 'var(--ok)' : 'var(--text3)'}"></span>
						{data.collector.running ? 'Collector running' : 'Collector idle'}
					</span>
					<button class="ghost sm" onclick={toggle} aria-label="Toggle theme" title="Toggle light/dark"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} /></button>
				</div>
				{#if selection.size}<a href="/analysis" class="badge accent">{selection.size} selected → Studio</a>{/if}
				<span>No AI runs unless you start it.</span>
			</div>
		</aside>
		<div class="main">
			<div class="topbar-m">
				<button class="ghost" onclick={() => (open = !open)} aria-label="Menu"><Icon name="menu" /></button><b>Visual Intelligence</b>
			</div>
			{@render children()}
		</div>
	</div>
	<div class="toast">{#each toasts.items as t (t.id)}<div class:bad={t.bad}>{t.text}</div>{/each}</div>
{/if}
