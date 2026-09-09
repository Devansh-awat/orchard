<script lang="ts">
	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	const url = $derived(typeof window === 'undefined' ? '' : window.location.origin);
</script>

<section class="setup-step">
	<h2>You're set</h2>

	<div class="setup-body">
		<div class="setup-url">{url}</div>
	</div>

	<div class="setup-acts">
		<button class="setup-pill" onclick={onDone}>Go to Orchard</button>
	</div>
</section>
