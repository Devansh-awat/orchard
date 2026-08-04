<script lang="ts" module>
	const settled = new Set<string>();

	export function isSettled(src: string | null | undefined): boolean {
		return !!src && settled.has(src);
	}
</script>

<script lang="ts">
	let {
		src,
		alt = '',
		class: className = '',
		eager = true,
		onerror
	}: {
		src: string;
		alt?: string;
		class?: string;
		eager?: boolean;
		onerror?: () => void;
	} = $props();

	let ready = $state(settled.has(src));
	let failed = $state(false);

	$effect(() => {
		const current = src;
		if (settled.has(current)) {
			ready = true;
			failed = false;
		} else {
			ready = false;
			failed = false;
		}
	});

	function markReady() {
		settled.add(src);
		ready = true;
	}

	function markFailed() {
		failed = true;
		onerror?.();
	}
</script>

{#if !failed}
	<img
		{src}
		{alt}
		class="ui-remote-img{className ? ` ${className}` : ''}"
		class:is-ready={ready}
		loading={eager ? 'eager' : 'lazy'}
		fetchpriority={eager ? 'high' : 'auto'}
		decoding="async"
		onload={markReady}
		onerror={markFailed}
	/>
{/if}

<style>
	.ui-remote-img {
		opacity: 0;
		transition: opacity var(--dur-fast) ease-out;
	}
	.ui-remote-img.is-ready {
		opacity: 1;
	}
	:global(html.motion-off) .ui-remote-img,
	:global(html.motion-reduce) .ui-remote-img {
		transition: none;
	}
</style>
