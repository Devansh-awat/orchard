<script lang="ts">
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Widget from '$lib/components/ui/Widget.svelte';
	import type { BuildItem, BuildPhaseItem } from './builds';

	let {
		builds,
		title = 'Recent builds'
	}: {
		builds: BuildItem[];
		title?: string;
	} = $props();

	const featured = $derived(builds[0]);
	const rest = $derived(builds.slice(1, 4));
	const live = $derived(featured?.status.kind === 'progress');

	let now = $state(Date.now());
	let mountedAt = Date.now();

	$effect(() => {
		if (!live) return;
		mountedAt = Date.now();
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	const phases = $derived.by((): BuildPhaseItem[] => {
		const list = featured?.phases ?? [];
		const extra = live ? Math.max(0, now - mountedAt) : 0;
		return list.map((p) => (p.live ? { ...p, ms: p.ms + extra } : p));
	});
	const total = $derived(phases.reduce((sum, p) => sum + p.ms, 0));
	const current = $derived(phases.find((p) => p.live) ?? phases[phases.length - 1]);

	function clock(ms: number) {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}
</script>

<Widget {title} meta="Today">
	{#if featured}
		<a class="live live--{featured.status.kind}" href={featured.href}>
			<span class="live-top">
				<AppIcon
					name={featured.project ?? featured.app}
					kind="project"
					icon={featured.projectIcon}
					size="md"
				/>
				<span class="live-text">
					<span class="live-app">{featured.app}</span>
					<span class="live-state">
						{#if live && current}
							<span class="phase-dot phase--{current.id}"></span>
							<span>{current.label}</span>
						{:else}
							<span>{featured.status.label}</span>
						{/if}
						{#if featured.project}<span class="faint">· {featured.project}</span>{/if}
					</span>
				</span>
				{#if total}
					<span class="elapsed">{clock(total)}</span>
				{:else if featured.duration}
					<span class="elapsed">{featured.duration}</span>
				{/if}
			</span>
			{#if phases.length > 1 && total > 0}
				<span class="phases" role="img" aria-label="Where the time went">
					{#each phases as p (p.id)}
						<span
							class="seg phase--{p.id}"
							class:seg--live={p.live}
							style:flex-grow={Math.max(p.ms, total * 0.03)}
							title="{p.label} {clock(p.ms)}"
						></span>
					{/each}
				</span>
			{/if}
			<span class="live-foot">
				<span class="live-msg"
					>{featured.branch ? `${featured.message} · ${featured.branch}` : featured.message}</span
				>
				{#if live && featured.eta}<span class="live-eta">{featured.eta}</span>{/if}
			</span>
		</a>
	{/if}
	<div class="list">
		{#each rest as b (b.id)}
			<a class="row" href={b.href}>
				<AppIcon name={b.project ?? b.app} kind="project" icon={b.projectIcon} size="xs" />
				<span class="row-app">{b.app}</span>
				<span class="row-msg" class:row-msg--error={b.status.kind === 'error'}
					>{b.status.kind === 'error' ? 'Failed' : b.message}</span
				>
				<span class="row-when"><RelativeTime date={b.at} /></span>
			</a>
		{/each}
	</div>
</Widget>

<style>
	.live {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		color: inherit;
		text-decoration: none;
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
		font-weight: var(--weight-medium);
		letter-spacing: -0.01em;
	}
	.live-state {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.live-state > :global(*) {
		text-box: trim-both cap alphabetic;
	}
	.live--error .live-state {
		color: var(--red-9);
	}
	.faint {
		color: var(--text-faint);
	}
	.elapsed {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
	}
	.phases {
		display: flex;
		gap: 2px;
		height: 0.375rem;
	}
	.seg {
		flex-basis: 0;
		min-width: 3px;
		border-radius: var(--radius-pill);
		background: var(--phase);
	}
	.seg--live {
		animation: seg-breathe 1.6s ease-in-out infinite;
	}
	@keyframes seg-breathe {
		50% {
			opacity: 0.55;
		}
	}
	.phase-dot {
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--phase);
	}
	.phase--queue {
		--phase: var(--neutral-5);
	}
	.phase--schedule {
		--phase: var(--amber-5);
	}
	.phase--start {
		--phase: var(--amber-7);
	}
	.phase--clone {
		--phase: var(--hue-violet, var(--blue-5));
	}
	.phase--build {
		--phase: var(--blue-7);
	}
	.phase--push {
		--phase: var(--green-7);
	}
	.phase--rollout {
		--phase: var(--green-5);
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
	.list {
		display: flex;
		flex-direction: column;
		padding-top: 0.75rem;
		box-shadow: inset 0 0.5px 0 var(--border-strong);
	}
	.row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		color: inherit;
		font-size: var(--text-callout);
		text-decoration: none;
	}
	.row-msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}
	.row-msg--error {
		color: var(--red-9);
	}
	.row-when {
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
</style>
