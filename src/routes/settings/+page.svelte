<script lang="ts">
	import { api } from '#lib/api.ts';
	import { toasts } from '#lib/selection.svelte.ts';

	let s = $state<any>(null);
	let cc = $state<any>(null);
	let ccDraft = $state<Record<string, any>>({});
	let providers = $state<any[]>([]);
	let profiles = $state<any[]>([]);
	let sys = $state<any>(null);
	let importText = $state('');
	const sections = ['Collector', 'Resource limits', 'Library', 'Analysis', 'Sarness', 'Server', 'Data'];

	async function load() {
		[s, cc, sys] = await Promise.all([api('/api/settings'), api('/api/collector-config'), api('/api/system')]);
		const p = await api('/api/providers');
		providers = p.providers;
		profiles = p.profiles;
		ccDraft = {};
	}
	$effect(() => {
		load().catch((e) => toasts.push(e.message, true));
	});
	async function save(patch: any) {
		try {
			s = await api('/api/settings', { method: 'PUT', json: patch });
			toasts.push('Saved');
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	async function saveCollector() {
		try {
			cc = await api('/api/collector-config', { method: 'PUT', json: ccDraft });
			ccDraft = {};
			toasts.push('Saved to config.toml — applies the next time ./collect.sh starts');
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	const field = (f: any) => (`${f.section}.${f.key}` in ccDraft ? ccDraft[`${f.section}.${f.key}`] : f.value);
	const setField = (f: any, v: any) => (ccDraft[`${f.section}.${f.key}`] = v);
	const dirty = $derived(Object.keys(ccDraft).length > 0);
	async function exportSettings() {
		const blob = new Blob([JSON.stringify({ vie_settings: 1, settings: s }, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'vie-settings.json';
		a.click();
	}
	async function importSettings() {
		try {
			const j = JSON.parse(importText);
			if (!j.settings) throw new Error('not a settings export');
			await save(j.settings);
			importText = '';
		} catch (e: any) {
			toasts.push(e.message, true);
		}
	}
	const groups = $derived(cc ? [['collector', 'Collection'], ['browser', 'Collector browser'], ['limits', 'Resource limits']].map(([k, l]) => [l, cc.fields.filter((f: any) => f.section === k)] as const) : []);
</script>

<div class="page">
	<div class="pagehead">
		<div><h1>Settings</h1><p>Collector settings are written to <span class="mono">config.toml</span> (comments are preserved). Everything else is stored in the database.</p></div>
		<div class="row">{#each sections as x (x)}<a class="badge" href="#{x}">{x}</a>{/each}</div>
	</div>
	{#if !s || !cc}<div class="card skel" style="height:240px"></div>{:else}
		{#each groups as [title, fields] (title)}
			<section class="card" id={title.startsWith('Resource') ? 'Resource limits' : title === 'Collection' ? 'Collector' : ''} style="margin-bottom:12px">
				<header><h2>{title}</h2>{#if title === 'Resource limits'}<span class="faint">protects the desktop: pause, then stop, before the system freezes</span>{/if}</header>
				<div class="body grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px 18px">
					{#each fields as f (f.key)}
						<label class="f" title={f.help}>
							{f.label}
							{#if f.type === 'enum'}<select value={field(f)} onchange={(e) => setField(f, e.currentTarget.value)}>{#each f.options as o (o)}<option>{o}</option>{/each}</select>
							{:else if f.type === 'bool'}<span class="row"><input type="checkbox" checked={!!field(f)} onchange={(e) => setField(f, e.currentTarget.checked)} />{f.help}</span>
							{:else}<input type="number" min={f.min} max={f.max} value={field(f)} oninput={(e) => setField(f, Number(e.currentTarget.value))} />{/if}
							{#if f.type !== 'bool'}<span class="faint" style="font-size:11px">{f.help}{f.isDefault && !(`${f.section}.${f.key}` in ccDraft) ? ' · default' : ''}</span>{/if}
						</label>
					{/each}
				</div>
			</section>
		{/each}
		<div class="row" style="margin:-4px 0 14px"><button class="primary" disabled={!dirty} onclick={saveCollector}>Save collector settings</button>{#if dirty}<button class="ghost" onclick={() => (ccDraft = {})}>Discard</button>{/if}<span class="faint">{cc.path}</span></div>

		<section class="card" id="Library" style="margin-bottom:12px">
			<header><h2>Library &amp; media</h2></header>
			<div class="body grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px 18px">
				<label class="f">Scroll Sessions folder<input value={s.collector.sessionsDir} placeholder="auto: ./scroll-sessions" onchange={(e) => save({ collector: { sessionsDir: e.currentTarget.value } })} /><span class="faint">Read in place. Videos are never copied or moved.</span></label>
				<label class="f">Thumbnail width (px)<input type="number" min="120" max="1080" value={s.media.thumbWidth} onchange={(e) => save({ media: { thumbWidth: Number(e.currentTarget.value) } })} /></label>
				<label class="f">Thumbnail jobs at once<input type="number" min="1" max="4" value={s.media.thumbConcurrency} onchange={(e) => save({ media: { thumbConcurrency: Number(e.currentTarget.value) } })} /><span class="faint">ffmpeg, CPU only, lowered priority</span></label>
				<label class="f">Cache limit (MB)<input type="number" min="128" value={s.media.cacheMaxMB} onchange={(e) => save({ media: { cacheMaxMB: Number(e.currentTarget.value) } })} /></label>
				<label class="f">Cache max age (days)<input type="number" min="1" value={s.media.cacheMaxAgeDays} onchange={(e) => save({ media: { cacheMaxAgeDays: Number(e.currentTarget.value) } })} /></label>
				<label class="f">Keep raw agent output (days)<input type="number" min="1" value={s.retention.keepAnalysisRawDays} onchange={(e) => save({ retention: { keepAnalysisRawDays: Number(e.currentTarget.value) } })} /></label>
				<label class="row" style="grid-column:1/-1"><input type="checkbox" checked={s.media.autoThumbnails} onchange={(e) => save({ media: { autoThumbnails: e.currentTarget.checked } })} />Generate missing thumbnails automatically at startup (one at a time)</label>
			</div>
		</section>

		<section class="card" id="Analysis" style="margin-bottom:12px">
			<header><h2>Analysis providers</h2><span class="faint">no provider is ever required</span></header>
			<div class="body grid" style="gap:10px">
				{#each providers as p (p.id)}
					{@const ps = s.analysis.providers[p.id] ?? {}}
					<div class="notice" style="display:grid;gap:8px">
						<div class="row"><b>{p.label}</b><span class="badge {p.available ? 'ok' : 'bad'}">{p.available ? 'available' : 'unavailable'}</span>{#if p.version}<span class="mono faint">{p.version}</span>{/if}<span class="badge">{p.verified}</span>
							<label class="row" style="margin-left:auto"><input type="checkbox" checked={ps.enabled !== false} onchange={(e) => save({ analysis: { providers: { [p.id]: { enabled: e.currentTarget.checked } } } })} />enabled</label></div>
						<span class="muted" style="font-size:12px">{p.detail}</span>
						<div class="row">
							<label class="f">Model<input value={ps.model ?? ''} placeholder={p.defaultModel ?? 'provider default'} list="m-{p.id}" onchange={(e) => save({ analysis: { providers: { [p.id]: { model: e.currentTarget.value } } } })} /></label>
							<datalist id="m-{p.id}">{#each p.models as m (m)}<option value={m}></option>{/each}</datalist>
							<label class="f">Timeout (s)<input type="number" min="30" value={ps.timeoutS ?? 300} onchange={(e) => save({ analysis: { providers: { [p.id]: { timeoutS: Number(e.currentTarget.value) } } } })} /></label>
						</div>
					</div>
				{/each}
				<div class="row">
					<label class="f">Analysis concurrency<input type="number" min="1" max={s.analysis.maxConcurrency} value={s.analysis.concurrency} onchange={(e) => save({ analysis: { concurrency: Number(e.currentTarget.value) } })} /><span class="faint">1 is recommended; hard cap {s.analysis.maxConcurrency}</span></label>
					<label class="f">Default profile<select value={s.analysis.defaultProfile} onchange={(e) => save({ analysis: { defaultProfile: e.currentTarget.value } })}>{#each profiles as p (p.id)}<option value={p.id}>{p.label}</option>{/each}</select></label>
				</div>
				<details><summary class="muted" style="cursor:pointer">Analysis profiles</summary>
					<table class="t" style="margin-top:8px"><thead><tr><th>Profile</th><th class="r">Frames</th><th class="r">Width</th><th>Extras</th><th class="r">Timeout</th></tr></thead><tbody>{#each profiles as p (p.id)}<tr><td><b>{p.label}</b><br /><span class="faint">{p.description}</span></td><td class="r num">{p.frames}{p.perShotFrames ? ' + ' + p.perShotFrames : ''}</td><td class="r num">{p.frameWidth || '—'}</td><td>{[p.contactSheet && 'contact sheet', p.shots && 'shot detection', p.burstFrames && p.burstFrames + '-frame burst'].filter(Boolean).join(', ') || '—'}</td><td class="r num">{p.timeoutS}s</td></tr>{/each}</tbody></table>
					<p class="faint" style="margin-top:6px">Profiles are defined in <span class="mono">core/analysis/profiles.ts</span>.</p></details>
			</div>
		</section>

		<section class="card" id="Sarness" style="margin-bottom:12px">
			<header><h2>Sarness connection</h2><span class="faint">your own GPU server — inference never runs on this machine</span></header>
			<div class="body grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px 18px">
				<label class="f">Host / IP<input value={s.sarness.host} onchange={(e) => save({ sarness: { host: e.currentTarget.value } })} /></label>
				<label class="f">Endpoint override<input value={s.sarness.endpoint} placeholder="auto from Sarness Desktop profile" onchange={(e) => save({ sarness: { endpoint: e.currentTarget.value } })} /></label>
				<label class="f">Profile name<input value={s.sarness.profile} placeholder="active Sarness Desktop profile" onchange={(e) => save({ sarness: { profile: e.currentTarget.value } })} /></label>
				<label class="f">SSH alias (optional, for diagnostics)<input value={s.sarness.sshAlias} onchange={(e) => save({ sarness: { sshAlias: e.currentTarget.value } })} /></label>
				<p class="faint" style="grid-column:1/-1">The API token is never stored here. It comes from <span class="mono">VIE_SARNESS_TOKEN</span>, <span class="mono">~/.config/visualintelligence/sarness.token</span>, or Sarness Desktop's own keyring entry.</p>
			</div>
		</section>

		<section class="card" id="Server" style="margin-bottom:12px">
			<header><h2>Server &amp; networking</h2></header>
			<div class="body grid" style="gap:8px">
				<div class="kv"><dt>Listening</dt><dd class="mono">{sys?.listen ?? 'see server start-up line'}</dd><dt>Authentication</dt><dd>{sys?.authRequired ? 'required (VIE_AUTH_TOKEN is set)' : 'off — local/trusted-LAN mode'}</dd></div>
				<p class="muted">Network binding and the access token are deliberately <b>not</b> editable from the browser (a remote page must not be able to widen its own exposure). Set them in the service environment: <span class="mono">VIE_HOST</span>, <span class="mono">VIE_PORT</span>, <span class="mono">VIE_AUTH_TOKEN</span>, <span class="mono">VIE_TRUSTED_LAN=1</span>. See docs/SERVER.md.</p>
			</div>
		</section>

		<section class="card" id="Data">
			<header><h2>Export / import</h2></header>
			<div class="body grid" style="gap:10px">
				<div class="row"><a class="btn" href="/api/backup">Download database backup</a><button onclick={exportSettings}>Export settings</button><a class="btn" href="/api/analysis/export?format=json&all=1">Export all research (JSON)</a></div>
				<label class="f">Import settings (paste an export)<textarea bind:value={importText} placeholder="&#123;&quot;vie_settings&quot;:1, …&#125;"></textarea></label>
				<div><button disabled={!importText.trim()} onclick={importSettings}>Import settings</button></div>
			</div>
		</section>
	{/if}
</div>
