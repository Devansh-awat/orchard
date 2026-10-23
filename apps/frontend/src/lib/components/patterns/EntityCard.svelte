<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Box, Database, Timer } from 'lucide-svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import { stateEcho } from '$lib/utils/motion.svelte';
	import type { StatusMeta } from '$lib/components/ui/status';

	let {
		kind,
		name,
		status,
		href,
		detail = undefined,
		metrics = undefined,
		updatedAt = undefined,
		image = undefined,
		traffic = undefined,
		actions = undefined
	}: {
		kind: 'deployment' | 'database' | 'job';
		name: string;
		status: StatusMeta;
		href: string;
		detail?: string;
		metrics?: string;
		updatedAt?: string | null;
		image?: string | null;
		traffic?: { values: number[]; label: string };
		actions?: Snippet;
	} = $props();

	const KIND_ICON = { deployment: Box, database: Database, job: Timer };
	const KindIcon = $derived(KIND_ICON[kind]);
	let failed = $state(false);
</script>

<div class="entity motion-echo echo--{status.kind}" {@attach stateEcho(() => status.kind)}>
	<a class="hit" {href} aria-label={name}></a>
	<div class="top">
		<span class="tile">
			{#if image && !failed}
				<RemoteImg src={image} class="tile-img" onerror={() => (failed = true)} />
			{:else}
				<KindIcon size={18} />
			{/if}
		</span>
		<span class="text">
			<span class="name">{name}</span>
			{#if detail}<span class="detail">{detail}</span>{/if}
		</span>
		{#if actions}<span class="actions">{@render actions()}</span>{/if}
	</div>
	<div class="bottom">
		<span class="status">
			<span class="dot dot--{status.kind}" class:dot--live={status.pulse} data-motion="progress"
			></span>
			<span class="label">{status.label}</span>
		</span>
		{#if traffic}
			<span class="traffic">
				<span class="spark"><Sparkline values={traffic.values} height={14} tone="neutral" /></span>
				<span class="traffic-label">{traffic.label}</span>
			</span>
		{:else if metrics}<span class="metrics">{metrics}</span>{/if}
		{#if updatedAt}<span class="when"><RelativeTime date={updatedAt} /></span>{/if}
	</div>
</div>

<style>
	.entity {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		min-width: 0;
		padding: 1rem;
		border-radius: calc(0.75rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-raised);
		transition:
			background-color var(--dur-fast) ease,
			transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.entity::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: var(--shadow-floating);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-base) ease;
	}
	.entity:hover {
		background: var(--bg-raised);
		transform: translateY(-2px);
	}
	.entity:hover::after {
		opacity: 1;
	}
	.entity:active {
		transform: translateY(0) scale(0.99);
	}
	.hit {
		position: absolute;
		inset: 0;
		z-index: 0;
		border-radius: inherit;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		pointer-events: none;
	}
	.tile {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: calc(0.625rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: linear-gradient(var(--bg-surface), var(--neutral-2));
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
		color: var(--text-muted);
		overflow: hidden;
	}
	.tile :global(.tile-img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.name,
	.detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.name {
		color: var(--text-default);
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.01em;
	}
	.detail {
		color: var(--text-faint);
		font-size: var(--text-callout);
	}
	.actions {
		position: relative;
		z-index: 1;
		display: flex;
		gap: 0.125rem;
		flex-shrink: 0;
		pointer-events: auto;
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.entity:hover .actions,
	.entity:focus-within .actions,
	.actions:has(:global([aria-expanded='true'])) {
		opacity: 1;
	}
	.bottom {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-top: 0.875rem;
		box-shadow: inset 0 1px 0 var(--border-default);
		pointer-events: none;
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-weight: var(--weight-semibold);
	}
	.label,
	.metrics,
	.when {
		text-box: trim-both cap alphabetic;
		white-space: nowrap;
	}
	.traffic {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
		color: var(--text-faint);
	}
	.spark {
		width: 3.5rem;
	}
	.traffic-label {
		text-box: trim-both cap alphabetic;
		white-space: nowrap;
	}
	.metrics {
		margin-left: auto;
		color: var(--text-faint);
	}
	.when {
		color: var(--text-faint);
	}
	.metrics + .when {
		margin-left: 0;
	}
	.status + .when {
		margin-left: auto;
	}
	.dot {
		position: relative;
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--dot);
		box-shadow: 0 0 5px color-mix(in oklab, var(--dot) 45%, transparent);
	}
	.dot--success {
		--dot: var(--status-success-solid);
	}
	.dot--warning {
		--dot: var(--status-warning-solid);
	}
	.dot--error {
		--dot: var(--status-error-solid);
	}
	.dot--info {
		--dot: var(--status-info-solid);
	}
	.dot--progress {
		--dot: var(--status-progress-solid);
	}
	.dot--neutral {
		--dot: var(--neutral-6);
		box-shadow: none;
	}
	.dot--live::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--dot);
		animation: ripple 1.6s ease-out infinite;
	}
	@keyframes ripple {
		to {
			transform: scale(2.6);
			opacity: 0;
		}
	}
	@media (hover: none) {
		.actions {
			opacity: 1;
		}
	}
</style>
