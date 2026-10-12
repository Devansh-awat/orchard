<script lang="ts" generics="P">
	import { untrack } from 'svelte';
	import { Alert, Button } from '$lib/components/ui';
	import type { HostApi, Mount, MountHandle } from './types';

	let {
		graftId,
		mount,
		props,
		host,
		class: className = ''
	}: {
		graftId: string;
		mount: Mount<P>;
		props: P;
		host: HostApi;
		class?: string;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let error = $state<string | null>(null);
	let attempt = $state(0);
	let handle: MountHandle | null = null;

	$effect(() => {
		const target = el;
		const fn = mount;
		void attempt;
		if (!target) return;
		let current: MountHandle | null = null;
		try {
			const result = fn(
				target,
				untrack(() => props),
				host
			);
			current = typeof result === 'function' ? { destroy: result } : (result ?? null);
			handle = current;
		} catch (err) {
			error = (err as Error)?.message ?? String(err);
		}
		return () => {
			try {
				current?.destroy();
			} catch {
				void 0;
			}
			handle = null;
			target.replaceChildren();
		};
	});

	$effect(() => {
		const next = props;
		try {
			handle?.update?.(next);
		} catch (err) {
			error = (err as Error)?.message ?? String(err);
		}
	});

	function retry() {
		error = null;
		attempt += 1;
	}
</script>

{#if error}
	<Alert tone="error" title={`The ${graftId} graft hit an error`}>
		<p class="graft-error-text">{error}</p>
		<Button size="sm" onclick={retry}>Retry</Button>
	</Alert>
{/if}
<div bind:this={el} class={className} hidden={!!error}></div>

<style>
	.graft-error-text {
		margin: 0 0 0.5rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
	}
</style>
