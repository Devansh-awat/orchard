<script lang="ts">
	// This route only ever redirects (see +page.server.ts); the markup exists
	// so SvelteKit has something to render if a redirect is ever skipped.
	import { Loader2 } from 'lucide-svelte';
</script>

<div class="sso-redirect">
	<Loader2 class="h-5 w-5 animate-spin" />
	<p>Taking you to your sign-in page…</p>
</div>

<style>
	.sso-redirect {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
</style>
