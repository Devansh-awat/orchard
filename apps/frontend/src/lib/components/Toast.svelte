<script lang="ts">
	import { toasts, type Toast } from '$lib/stores';
	import { X, Check, CircleAlert, TriangleAlert, Info } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { SPRINGS, springEasing } from '$lib/design/springs';
	import { effectiveAnimationLevel } from '$lib/stores/preferences';

	const ICONS = {
		success: Check,
		error: CircleAlert,
		warning: TriangleAlert,
		info: Info
	};

	const enter = springEasing(SPRINGS.bouncy);
	const leave = springEasing({ visualDuration: 0.18, bounce: 0 });

	let hovered = $state(false);
	let fresh = $state<Record<string, boolean>>({});

	function hold(id: string) {
		fresh[id] = true;
		setTimeout(() => (fresh[id] = false), 2600);
	}

	function pop(node: Element, { out = false }: { out?: boolean } = {}) {
		const level = effectiveAnimationLevel();
		const curve = out ? leave : enter;
		if (level === 'off') return { duration: 0 };
		if (level === 'reduced') return { duration: 260, css: (t: number) => `opacity:${t}` };
		return {
			duration: curve.duration,
			easing: curve.easing,
			css: (t: number, u: number) =>
				`opacity:${Math.min(1, t * 1.6)};transform:translateY(${u * (out ? 6 : 14)}px) scale(${0.94 + 0.06 * t})`
		};
	}

	function setHover(next: boolean) {
		hovered = next;
		if (next) toasts.pause();
		else toasts.resume();
	}

	const expandable = (t: Toast) => !!(t.description || t.action);
</script>

<div
	class="stack"
	role="region"
	aria-label="Notifications"
	onpointerenter={() => setHover(true)}
	onpointerleave={() => setHover(false)}
>
	{#each $toasts as toast (toast.id)}
		{@const open = expandable(toast) && (hovered || fresh[toast.id])}
		<div
			class="toast toast--{toast.color}"
			class:toast--open={open}
			role={toast.color === 'error' ? 'alert' : 'status'}
			in:pop
			out:pop={{ out: true }}
			{@attach () => hold(toast.id)}
		>
			<div class="head">
				<span class="badge" aria-hidden="true">
					{#if toast.color === 'loading'}
						<Spinner size={14} />
					{:else}
						{@const Glyph = ICONS[toast.color]}
						<Glyph size={14} strokeWidth={2.5} />
					{/if}
				</span>
				<p class="title">{toast.title}</p>
				<button class="close" onclick={() => toasts.remove(toast.id)} aria-label="Dismiss">
					<X size={14} />
				</button>
			</div>
			{#if expandable(toast)}
				<div class="more">
					<div class="more-inner">
						{#if toast.description}<p class="desc">{toast.description}</p>{/if}
						{#if toast.action}
							<button
								class="action"
								onclick={() => {
									toast.action?.onClick();
									toasts.remove(toast.id);
								}}>{toast.action.label}</button
							>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.stack {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: var(--z-toast);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
		width: min(22rem, calc(100vw - 2rem));
		pointer-events: none;
	}
	.toast {
		--tone: var(--neutral-7);
		--tone-fg: var(--neutral-app);
		width: 100%;
		border-radius: 1.25rem;
		background: var(--neutral-10);
		color: var(--neutral-app);
		box-shadow: var(--shadow-overlay);
		pointer-events: auto;
		overflow: clip;
	}
	.toast--success {
		--tone: var(--green-7);
		--tone-fg: var(--green-contrast);
	}
	.toast--error {
		--tone: var(--red-7);
		--tone-fg: var(--red-contrast);
	}
	.toast--warning {
		--tone: var(--amber-7);
		--tone-fg: var(--amber-contrast);
	}
	.toast--info {
		--tone: var(--blue-7);
		--tone-fg: var(--blue-contrast);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.75rem;
		padding: 0.5rem 0.5rem 0.5rem 0.625rem;
	}
	.badge {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--tone);
		color: var(--tone-fg);
		transition: background-color var(--dur-base) ease;
	}
	.toast--loading .badge {
		background: color-mix(in oklab, var(--neutral-app) 16%, transparent);
		color: var(--neutral-app);
	}
	.title {
		flex: 1;
		min-width: 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
	}
	.close {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 50%;
		background: none;
		color: color-mix(in oklab, var(--neutral-app) 55%, transparent);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.toast:hover .close,
	.close:focus-visible {
		opacity: 1;
	}
	.close:hover {
		background: color-mix(in oklab, var(--neutral-app) 12%, transparent);
	}
	.more {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows var(--spring-smooth-duration) var(--spring-smooth);
	}
	.toast--open .more {
		grid-template-rows: 1fr;
	}
	.more-inner {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.625rem;
		min-height: 0;
		padding: 0 1rem 0 2.75rem;
		opacity: 0;
		filter: blur(4px);
		transition:
			opacity 80ms ease,
			filter 80ms ease,
			padding var(--spring-smooth-duration) var(--spring-smooth);
	}
	.toast--open .more-inner {
		padding-bottom: 0.875rem;
		opacity: 1;
		filter: none;
		transition:
			opacity 200ms ease 90ms,
			filter 200ms ease 90ms,
			padding var(--spring-smooth-duration) var(--spring-smooth);
	}
	.desc {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: color-mix(in oklab, var(--neutral-app) 70%, transparent);
	}
	.action {
		height: 1.75rem;
		padding: 0 0.75rem;
		border: none;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--tone) 28%, transparent);
		color: var(--neutral-app);
		font: inherit;
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.action:hover {
		background: color-mix(in oklab, var(--tone) 40%, transparent);
	}
	:global(html.motion-reduce) .more,
	:global(html.motion-reduce) .more-inner {
		filter: none;
	}
</style>
