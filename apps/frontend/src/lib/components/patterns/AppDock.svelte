<script lang="ts" module>
	export type AppDockTone = 'success' | 'progress' | 'error' | 'neutral';

	export type AppDockItem = {
		id: string;
		label: string;
		href: string;
		kind?: 'deployment' | 'database' | 'job';
		icon?: string | null;
		tone?: AppDockTone;
		status?: string;
	};
</script>

<script lang="ts">
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';

	let {
		items,
		title = 'Pinned'
	}: {
		items: AppDockItem[];
		title?: string;
	} = $props();

	const TONE_LABEL: Record<AppDockTone, string> = {
		success: 'Running',
		progress: 'In progress',
		error: 'Failing',
		neutral: 'Stopped'
	};

	function statusOf(item: AppDockItem) {
		const tone = item.tone ?? 'success';
		return item.status ?? TONE_LABEL[tone];
	}
</script>

<section class="dock" aria-label={title}>
	<SectionTitle {title} size="md" />
	<ul class="dock-row">
		{#each items as item (item.id)}
			{@const tone = item.tone ?? 'success'}
			<li class="dock-slot">
				<a
					class="dock-app"
					href={item.href}
					aria-label={tone === 'success' ? item.label : `${item.label}, ${statusOf(item)}`}
					title={tone === 'success' ? item.label : `${item.label} · ${statusOf(item)}`}
				>
					<span class="lift">
						<span class="zoom"
							><AppIcon name={item.label} kind={item.kind} icon={item.icon} size="lg" /></span
						>
						{#if tone !== 'success'}
							<span
								class="pip pip--{tone}"
								data-motion={tone === 'progress' ? 'progress' : undefined}
								aria-hidden="true"
							></span>
						{/if}
					</span>
					<span class="name">{item.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</section>

<style>
	.dock {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.dock-row {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem 0.25rem;
		margin: 0 -1rem;
		padding: 0;
		list-style: none;
	}
	.dock-slot {
		width: 5.5rem;
		min-width: 0;
	}
	.dock-app {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 0.25rem 0 0;
		color: inherit;
		text-decoration: none;
		-webkit-tap-highlight-color: transparent;
	}
	.dock-app:focus-visible {
		outline: none;
	}

	.lift {
		position: relative;
		display: block;
		width: 3.5rem;
		height: 3.5rem;
		isolation: isolate;
		transform-origin: 50% 70%;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.lift::before,
	.lift::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: calc(0.875rem * var(--corner-scale));
		corner-shape: var(--corner);
		pointer-events: none;
	}
	.lift::before {
		box-shadow:
			0 1px 2px color-mix(in oklab, var(--on-media-pill) 24%, transparent),
			0 3px 8px -4px color-mix(in oklab, var(--on-media-pill) 43%, transparent);
	}
	.lift::after {
		box-shadow:
			0 16px 24px -10px color-mix(in oklab, var(--on-media-pill) 96%, transparent),
			0 6px 10px -6px color-mix(in oklab, var(--on-media-pill) 58%, transparent);
		opacity: 0;
		transition: opacity var(--dur-base) ease;
	}
	.dock-app:hover .lift,
	.dock-app:focus-visible .lift {
		transform: scale(1.08);
	}
	.dock-app:hover .lift::after,
	.dock-app:focus-visible .lift::after {
		opacity: 1;
	}
	.dock-app:active .lift {
		transform: scale(1.03);
		transition-duration: var(--spring-interactive-duration);
		transition-timing-function: var(--spring-interactive);
	}
	.dock-app:focus-visible .lift::before {
		box-shadow:
			0 0 0 3px var(--focus-ring),
			0 1px 2px color-mix(in oklab, var(--on-media-pill) 24%, transparent);
	}

	.zoom {
		display: block;
		zoom: 1.2727;
	}

	.pip {
		position: absolute;
		top: -0.1875rem;
		right: -0.1875rem;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		background: var(--pip);
		box-shadow: 0 0 0 2px var(--bg-app);
	}
	.pip--error {
		--pip: var(--status-error-solid);
	}
	.pip--progress {
		--pip: var(--status-progress-solid);
	}
	.pip--neutral {
		--pip: var(--neutral-6);
	}
	.pip--progress::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--pip);
		animation: pip-pulse 1.6s ease-out infinite;
	}
	@keyframes pip-pulse {
		from {
			transform: scale(1);
			opacity: 0.6;
		}
		to {
			transform: scale(2.2);
			opacity: 0;
		}
	}

	.name {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-default);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		text-align: center;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
</style>
