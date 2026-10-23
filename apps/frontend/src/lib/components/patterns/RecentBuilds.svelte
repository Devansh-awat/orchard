<script lang="ts">
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Ring from '$lib/components/ui/Ring.svelte';
	import type { BuildItem } from './builds';

	let {
		builds,
		title = 'Recent builds'
	}: {
		builds: BuildItem[];
		title?: string;
	} = $props();

	const STAGES = ['Queued', 'Build', 'Push', 'Deploy'];

	function stageProgress(b: BuildItem) {
		const stages = b.stages ?? STAGES;
		const stage = b.stage ?? 1;
		const span = 1 / stages.length;
		return Math.min(1, Math.max(0.08, ((b.progress ?? 0) - stage * span) / span));
	}

	const featured = $derived(builds[0]);
	const rest = $derived(builds.slice(1, 4));
</script>

<section class="widget">
	<header class="w-head">
		<span class="w-title">{title}</span>
		<span class="w-meta">Today</span>
	</header>
	{#if featured}
		{@const stages = featured.stages ?? STAGES}
		{@const kind = featured.status.kind}
		{@const live = kind === 'progress'}
		{@const stage = featured.stage ?? (live ? 1 : stages.length - 1)}
		<a class="live live--{kind}" href={featured.href}>
			<span class="live-top">
				<AppIcon name={featured.app} kind={featured.kind} icon={featured.icon} size="md" />
				<span class="live-text">
					<span class="live-app">{featured.app}</span>
					<span class="live-state"
						>{live ? `${featured.status.label} · ${stages[stage]}` : featured.status.label}</span
					>
				</span>
				{#if live}
					<Ring
						value={Math.round((featured.progress ?? 0) * 100)}
						size={40}
						thickness={3}
						tone="warning"
					/>
				{:else if featured.duration}
					<span class="live-took">{featured.duration}</span>
				{/if}
			</span>
			<span class="track" aria-hidden="true">
				{#each stages as label, i (label)}
					<span
						class="seg"
						class:seg--done={i < stage || (!live && kind === 'success')}
						class:seg--now={i === stage}
					>
						<span class="seg-fill" style:--p={i === stage && live ? stageProgress(featured) : 1}
						></span>
					</span>
				{/each}
			</span>
			<span class="live-foot">
				<span class="live-msg"
					>{featured.branch ? `${featured.message} · ${featured.branch}` : featured.message}</span
				>
				{#if live && featured.eta}<span class="live-eta">{featured.eta}</span>{/if}
			</span>
		</a>
	{/if}
	<div class="w-list">
		{#each rest as b (b.id)}
			<a class="w-row" href={b.href}>
				<span class="dot dot--{b.status.kind}"></span>
				<span class="w-row-app">{b.app}</span>
				<span class="w-row-msg">{b.message}</span>
				<span class="w-row-when"><RelativeTime date={b.at} /></span>
			</a>
		{/each}
	</div>
</section>

<style>
	.widget {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 1rem;
		border-radius: calc(1.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.w-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}
	.w-title {
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
	}
	.w-meta {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.live {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		color: inherit;
		text-decoration: none;
		--live: var(--neutral-7);
	}
	.live--progress,
	.live--warning {
		--live: var(--amber-solid);
	}
	.live--success {
		--live: var(--green-solid);
	}
	.live--error {
		--live: var(--red-solid);
	}
	.live-top {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.live-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.live-app,
	.live-state,
	.live-msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.live-app {
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.01em;
	}
	.live-state {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.live--progress .live-state {
		color: var(--amber-9);
	}
	.live--error .live-state {
		color: var(--red-9);
	}
	.live--success .live-state {
		color: var(--green-9);
	}
	.live-took {
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
	}
	.track {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 0.25rem;
	}
	.seg {
		height: 0.3125rem;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
		overflow: hidden;
	}
	.seg-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--live);
		transform: translateX(-101%);
		transition: transform var(--spring-smooth-duration) var(--spring-smooth);
	}
	.seg--done .seg-fill {
		transform: none;
	}
	.seg--now .seg-fill {
		transform: translateX(calc((var(--p) - 1) * 100%));
	}
	.live--progress .seg--now .seg-fill {
		animation: seg-breathe 1.6s ease-in-out infinite;
	}
	@keyframes seg-breathe {
		50% {
			opacity: 0.55;
		}
	}
	.live-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: -0.25rem;
	}
	.live-msg {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.live-eta {
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
	.w-list {
		display: flex;
		flex-direction: column;
		padding-top: 0.75rem;
		box-shadow: inset 0 0.5px 0 var(--border-strong);
	}
	.w-row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		color: inherit;
		font-size: var(--text-callout);
		text-decoration: none;
	}
	.w-row-app {
		font-weight: var(--weight-medium);
	}
	.w-row-msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}
	.w-row-when {
		color: var(--text-faint);
		font-size: var(--text-caption);
	}

	.dot {
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--neutral-6);
	}
	.dot--success {
		background: var(--status-success-solid);
	}
	.dot--error {
		background: var(--status-error-solid);
	}
	.dot--progress,
	.dot--warning {
		background: var(--status-progress-solid);
	}
	.dot--info {
		background: var(--status-info-solid);
	}
</style>
