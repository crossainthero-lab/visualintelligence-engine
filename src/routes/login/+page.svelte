<script lang="ts">
	import '#lib/app.css';
	import { page } from '$app/state';
</script>

<div style="min-height:100vh;display:grid;place-items:center;padding:20px">
	<form method="POST" class="card" style="width:min(360px,100%);padding:22px;display:grid;gap:14px">
		<div><h1>Visual Intelligence</h1><p class="muted" style="margin-top:4px">This server requires an access token.</p></div>
		<input type="hidden" name="next" value={page.url.searchParams.get('next') ?? '/'} />
		<label class="f">Access token<input name="token" type="password" autocomplete="current-password" required /></label>
		{#if page.url.searchParams.get('error')}<div class="notice bad">Token not accepted.</div>{/if}
		<button class="primary" style="justify-content:center">Continue</button>
	</form>
</div>
