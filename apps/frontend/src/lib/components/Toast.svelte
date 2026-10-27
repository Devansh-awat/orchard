<script lang="ts">
	import { toasts, DEFAULT_POSITION, type Toast, type ToastPosition } from '$lib/stores/toast';
	import ToastItem from '$lib/components/toast/ToastItem.svelte';

	const POSITIONS: ToastPosition[] = [
		'top-left',
		'top-center',
		'top-right',
		'bottom-left',
		'bottom-center',
		'bottom-right'
	];

	let hovered = $state<ToastPosition | null>(null);

	const groups = $derived.by(() => {
		const map = new Map<ToastPosition, Toast[]>();
		for (const t of $toasts) {
			const pos = t.position ?? DEFAULT_POSITION;
			map.set(pos, [...(map.get(pos) ?? []), t]);
		}
		return map;
	});

	function enter(pos: ToastPosition) {
		hovered = pos;
		toasts.pause();
	}

	function leave() {
		hovered = null;
		toasts.resume();
	}
</script>

{#each POSITIONS as pos (pos)}
	{@const list = groups.get(pos)}
	{#if list?.length}
		<section
			class="viewport"
			data-position={pos}
			aria-label="Notifications"
			onpointerenter={() => enter(pos)}
			onpointerleave={leave}
		>
			{#each list as toast (toast.id)}
				<ToastItem
					{toast}
					expand={pos.startsWith('top') ? 'bottom' : 'top'}
					align={pos.endsWith('left') ? 'left' : pos.endsWith('center') ? 'center' : 'right'}
					stackHovered={hovered === pos}
				/>
			{/each}
		</section>
	{/if}
{/each}

<style>
	.viewport {
		position: fixed;
		z-index: var(--z-toast);
		isolation: isolate;
		will-change: transform;
		display: flex;
		gap: 0.75rem;
		padding: 0.75rem;
		max-width: calc(100vw - 1.5rem);
		pointer-events: none;
	}
	.viewport[data-position^='top'] {
		top: 0;
		flex-direction: column-reverse;
	}
	.viewport[data-position^='bottom'] {
		bottom: 0;
		flex-direction: column;
	}
	.viewport[data-position$='left'] {
		left: 0;
		align-items: flex-start;
	}
	.viewport[data-position$='right'] {
		right: 0;
		align-items: flex-end;
	}
	.viewport[data-position$='center'] {
		left: 50%;
		align-items: center;
		transform: translateX(-50%);
	}
</style>
