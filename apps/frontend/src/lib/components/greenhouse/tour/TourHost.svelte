<script lang="ts">
	import { onMount } from 'svelte';
	import { motion } from '$lib/utils/motion.svelte';

	const SEEN = 'greenhouse-tour-seen';

	let { auto = true }: { auto?: boolean } = $props();

	let open = $state(false);

	function show() {
		open = true;
	}

	function close() {
		open = false;
		try {
			localStorage.setItem(SEEN, '1');
		} catch {
			return;
		}
	}

	onMount(() => {
		const replay = () => show();
		const message = (event: MessageEvent) => {
			if (event.origin !== location.origin) return;
			if ((event.data as { type?: string } | null)?.type === 'greenhouse-tour') close();
		};
		window.addEventListener('greenhouse-tour', replay);
		window.addEventListener('message', message);
		let seen = false;
		try {
			seen = localStorage.getItem(SEEN) === '1';
		} catch {
			seen = true;
		}
		if (auto && !seen) show();
		return () => {
			window.removeEventListener('greenhouse-tour', replay);
			window.removeEventListener('message', message);
		};
	});

	function enter(el: HTMLElement) {
		motion(el, { opacity: [0, 1] }, 'smooth');
	}
</script>

{#if open}
	<div class="host" {@attach enter}>
		<iframe class="frame" src="/tour/greenhouse" title="Greenhouse tour"></iframe>
	</div>
{/if}

<style>
	.host {
		position: fixed;
		inset: 0;
		z-index: 2147483000;
		background: var(--bg-app);
	}

	.frame {
		width: 100%;
		height: 100%;
		border: 0;
	}
</style>
