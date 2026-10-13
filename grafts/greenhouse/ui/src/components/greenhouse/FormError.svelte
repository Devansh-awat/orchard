<script lang="ts">
	import { CircleAlert } from 'lucide-svelte';

	let { message }: { message: string } = $props();
</script>

<p class="form-error" role="alert">
	<span class="glyph"><CircleAlert size={16} strokeWidth={1.75} /></span>
	<span>{message}</span>
</p>

<style>
	.form-error {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0;
		color: var(--text-default);
		font-weight: 600;
	}

	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		height: var(--gh-lh-ui, 1.25rem);
		color: var(--status-error);
	}
</style>
