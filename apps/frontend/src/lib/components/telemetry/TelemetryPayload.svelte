<script lang="ts">
	import { onMount } from 'svelte';
	import { telemetry, type TelemetryPreview } from '$lib/stores';

	let { class: className = '' }: { class?: string } = $props();

	let preview = $state<TelemetryPreview | null>(null);
	let failed = $state(false);

	onMount(async () => {
		try {
			preview = await telemetry.preview();
			failed = !preview;
		} catch {
			failed = true;
		}
	});

	const text = $derived(
		preview ? JSON.stringify(preview, null, 2) : failed ? "Couldn't load the report." : 'Loading…'
	);
</script>

<pre class="telemetry-payload {className}">{text}</pre>

<style>
	.telemetry-payload {
		margin: 0;
		max-height: 16rem;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		line-height: 1.55;
		text-align: left;
		white-space: pre;
	}
</style>
