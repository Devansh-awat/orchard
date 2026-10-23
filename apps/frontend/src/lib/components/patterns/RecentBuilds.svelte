<script lang="ts">
	import { Check, X, Hammer, Minus, ChevronRight } from 'lucide-svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import AuraTile from '$lib/components/ui/AuraTile.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import type { StatusKind } from '$lib/components/ui/status';
	import type { BuildItem } from './builds';

	let {
		builds,
		variant = 'grouped',
		title = 'Recent builds'
	}: {
		builds: BuildItem[];
		variant?: 'grouped' | 'widget' | 'stack' | 'shelf';
		title?: string;
	} = $props();

	const GLYPH: Record<StatusKind, typeof Check> = {
		success: Check,
		error: X,
		progress: Hammer,
		warning: Hammer,
		info: Hammer,
		neutral: Minus
	};

	const featured = $derived(builds[0]);
	const rest = $derived(builds.slice(1, 4));
	const peek = $derived(Math.min(2, Math.max(0, builds.length - 3)));
</script>

{#if variant === 'grouped'}
	<section class="grouped">
		<p class="eyebrow">{title}</p>
		<div class="inset">
			{#each builds as b (b.id)}
				<a class="g-row" href={b.href}>
					<span class="glyph glyph--{b.status.kind}">
						{#if b.status.kind === 'progress'}
							<Spinner size={13} />
						{:else}
							{@const G = GLYPH[b.status.kind]}
							<G size={13} strokeWidth={3} />
						{/if}
					</span>
					<span class="g-text">
						<span class="g-title">{b.message}</span>
						<span class="g-sub"
							>{b.app}{#if b.branch}
								· {b.branch}{/if}</span
						>
					</span>
					<span class="g-when"><RelativeTime date={b.at} /></span>
					<ChevronRight size={14} class="g-chev" />
				</a>
			{/each}
		</div>
	</section>
{:else if variant === 'widget'}
	<section class="widget">
		<header class="w-head">
			<span class="w-title">{title}</span>
			<span class="w-meta">Today</span>
		</header>
		{#if featured}
			<a class="w-feature" href={featured.href}>
				<AppIcon name={featured.app} kind={featured.kind} icon={featured.icon} size="lg" />
				<span class="w-feature-text">
					<span class="w-app">{featured.app}</span>
					<span class="w-msg">{featured.message}</span>
				</span>
			</a>
			{#if featured.status.kind === 'progress'}
				<div class="w-progress" data-motion="progress">
					<span class="w-bar" style:--p={featured.progress ?? 0.4}></span>
				</div>
				<p class="w-caption">
					<span class="w-state w-state--progress">Building</span>
					<span>{Math.round((featured.progress ?? 0.4) * 100)}%</span>
				</p>
			{:else}
				<p class="w-caption">
					<span class="w-state w-state--{featured.status.kind}">{featured.status.label}</span>
					{#if featured.duration}<span>in {featured.duration}</span>{/if}
				</p>
			{/if}
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
{:else if variant === 'stack'}
	<section class="stack">
		<p class="eyebrow eyebrow--plain">{title}</p>
		<div class="s-list">
			{#each builds.slice(0, 3) as b (b.id)}
				<a class="note" href={b.href}>
					<AppIcon name={b.app} kind={b.kind} icon={b.icon} size="md" />
					<span class="note-body">
						<span class="note-top">
							<span class="note-app">{b.app}</span>
							<span class="note-when"><RelativeTime date={b.at} /></span>
						</span>
						<span class="note-state note-state--{b.status.kind}">{b.status.label}</span>
						<span class="note-msg">{b.message}</span>
					</span>
				</a>
			{/each}
			{#if peek > 0}
				<div class="peek" aria-hidden="true">
					{#each Array(peek) as _, i (i)}<span class="peek-card" style:--i={i + 1}></span>{/each}
				</div>
			{/if}
		</div>
	</section>
{:else}
	<section class="shelf">
		<p class="eyebrow eyebrow--plain">{title}</p>
		<div class="sh-list">
			{#each builds.slice(0, 3) as b (b.id)}
				<a class="sh-item" href={b.href}>
					<AuraTile name={b.app} image={b.image} class="sh-art">
						<div class="sh-over">
							<span class="sh-pill">
								<span class="dot dot--{b.status.kind}"></span>{b.status.label}
							</span>
							{#if b.status.kind === 'progress'}
								<span class="sh-track" data-motion="progress"
									><span class="sh-fill" style:--p={b.progress ?? 0.4}></span></span
								>
							{/if}
						</div>
					</AuraTile>
					<span class="sh-title">{b.app}</span>
					<span class="sh-sub">{b.message} · <RelativeTime date={b.at} /></span>
				</a>
			{/each}
		</div>
	</section>
{/if}

<style>
	.eyebrow {
		padding: 0 1rem 0.5rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.eyebrow--plain {
		padding: 0 0.25rem 0.625rem;
		letter-spacing: 0;
		text-transform: none;
		font-size: var(--text-callout);
	}

	.inset {
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
	.g-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.5rem 0.75rem 0.5rem 1rem;
		color: inherit;
		text-decoration: none;
		transition: background-color var(--dur-fast) ease;
	}
	.g-row:hover {
		background: var(--bg-hover);
	}
	.g-row + .g-row::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 3.25rem;
		height: 0.5px;
		background: var(--border-strong);
	}
	.glyph {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: calc(0.4375rem * var(--corner-scale));
		corner-shape: var(--corner);
		color: var(--on-solid);
		background: var(--neutral-7);
	}
	.glyph--success {
		background: var(--green-solid);
	}
	.glyph--error {
		background: var(--red-solid);
	}
	.glyph--progress,
	.glyph--warning {
		background: var(--amber-solid);
	}
	.glyph--info {
		background: var(--blue-solid);
	}
	.g-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.g-title,
	.g-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.g-title {
		font-size: var(--text-body);
		color: var(--text-default);
	}
	.g-sub {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.g-when {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.g-row :global(.g-chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}

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
	.w-feature {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: inherit;
		text-decoration: none;
	}
	.w-feature-text {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.w-app {
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
		text-box: trim-both cap alphabetic;
	}
	.w-msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.w-progress {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
		overflow: hidden;
	}
	.w-bar {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--amber-solid);
		transform: translateX(calc((var(--p) - 1) * 100%));
		transition: transform var(--spring-smooth-duration) var(--spring-smooth);
	}
	.w-caption {
		display: flex;
		justify-content: space-between;
		margin-top: -0.375rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
	.w-state {
		font-weight: var(--weight-semibold);
	}
	.w-state--progress {
		color: var(--status-progress);
	}
	.w-state--success {
		color: var(--status-success);
	}
	.w-state--error {
		color: var(--status-error);
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

	.s-list {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.note {
		position: relative;
		z-index: 1;
		display: flex;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: calc(1.125rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-floating);
		color: inherit;
		text-decoration: none;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.note:hover {
		transform: scale(1.015);
	}
	.note-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		padding-top: 0.125rem;
	}
	.note-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.note-app {
		font-size: var(--text-callout);
		font-weight: var(--weight-semibold);
	}
	.note-when {
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
	.note-state {
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.note-state--success {
		color: var(--status-success);
	}
	.note-state--error {
		color: var(--status-error);
	}
	.note-state--progress {
		color: var(--status-progress);
	}
	.note-msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.peek {
		position: relative;
		height: 0.75rem;
		margin-top: -0.5rem;
	}
	.peek-card {
		position: absolute;
		top: calc(-1rem + var(--i) * 0.375rem);
		right: calc(var(--i) * 0.75rem);
		left: calc(var(--i) * 0.75rem);
		z-index: calc(1 - var(--i));
		height: 1rem;
		border-radius: 0 0 1rem 1rem;
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--bg-surface) calc(100% - var(--i) * 25%), transparent);
		box-shadow: var(--shadow-raised);
	}

	.sh-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.sh-item {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		color: inherit;
		text-decoration: none;
	}
	.sh-item :global(.sh-art) {
		aspect-ratio: 16 / 9;
		margin-bottom: 0.25rem;
		border-radius: calc(0.875rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: var(--shadow-raised);
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.sh-item:hover :global(.sh-art) {
		transform: scale(1.03);
	}
	.sh-over {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 0.5rem;
		height: 100%;
		padding: 0.625rem;
	}
	.sh-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		align-self: flex-start;
		height: 1.375rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		background: var(--on-media-pill);
		color: var(--on-media);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.sh-track {
		height: 0.25rem;
		border-radius: var(--radius-pill);
		background: var(--on-media-fill);
		overflow: hidden;
	}
	.sh-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--on-media);
		transform: translateX(calc((var(--p) - 1) * 100%));
	}
	.sh-title {
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
	}
	.sh-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: var(--text-callout);
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
