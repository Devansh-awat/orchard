<script lang="ts">
	import { untrack } from 'svelte';
	import { SquareTerminal } from 'lucide-svelte';
	import { Button, LogViewer } from '$lib/components/ui';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import type { LogsState } from './logs.svelte';

	let {
		logs,
		deploymentId,
		deploymentName = 'app',
		active
	}: {
		logs: LogsState;
		deploymentId: string;
		deploymentName?: string;
		active: boolean;
	} = $props();

	let visibility = $state<DocumentVisibilityState>('visible');
	let stream = $state<'live' | 'down'>('live');
	let attempt = $state(0);
	let scrolledUp = $state(false);

	$effect(() => {
		const id = deploymentId;
		if (!id || !active) return;
		untrack(() => logs.fetch(id));
	});

	$effect(() => {
		attempt;
		const id = deploymentId;
		const following = !logs.paused && active && visibility === 'visible';
		if (!following || !id) return;
		let wake: ReturnType<typeof setTimeout> | null = null;
		let down: ReturnType<typeof setTimeout> | null = null;
		const markDown = () => {
			down ??= setTimeout(() => (stream = 'down'), 4_000);
		};
		markDown();
		const es = new EventSource(
			`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/stream?tailLines=1`
		);
		es.onopen = () => {
			if (down) clearTimeout(down);
			down = null;
			stream = 'live';
			untrack(() => logs.fetch(id, true));
		};
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) stream = 'down';
			else markDown();
		};
		es.onmessage = (e) => {
			if (wake) return;
			try {
				if (JSON.parse(e.data)?.type === 'heartbeat') return;
			} catch {
				return;
			}
			wake = setTimeout(() => {
				wake = null;
				logs.fetch(id, true);
			}, 300);
		};
		return () => {
			es.close();
			if (wake) clearTimeout(wake);
			if (down) clearTimeout(down);
			stream = 'live';
		};
	});
</script>

<svelte:document bind:visibilityState={visibility} />

<div class="console">
	<LogViewer
		lines={logs.lines}
		loading={logs.loading}
		loadingMore={logs.loadingMore}
		error={logs.error}
		atStart={logs.atStart}
		bind:scrolledUp
		toolbar
		filename="{deploymentName}-logs"
		sourceLabel="Pod"
		onLoadEarlier={() => logs.loadEarlier(deploymentId)}
	>
		{#snippet empty()}
			<div class="empty">
				<SquareTerminal size={16} aria-hidden="true" />
				<span>No output yet</span>
			</div>
		{/snippet}
	</LogViewer>
	{#if logs.paused || stream === 'down'}
		<div class="notice" role="status">
			{#if logs.paused}
				<StatusDot meta={statusMeta('neutral', 'Paused')} size={8} />
				<span>Paused</span>
				<Button variant="secondary" size="sm" onclick={() => (logs.paused = false)}>Resume</Button>
			{:else}
				<StatusDot meta={statusMeta('warning', 'Reconnecting', true)} size={8} />
				<span>Logs aren't updating</span>
				<Button variant="secondary" size="sm" onclick={() => attempt++}>Retry</Button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.console {
		position: relative;
		display: flex;
		flex-direction: column;
		height: var(--fit-h, 36rem);
		min-height: 0;
		padding: 0.75rem 1rem;
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
	.console :global(.log-pod) {
		display: inline-block;
		min-width: 5ch;
		margin-right: 0.75rem;
		color: var(--console-dim);
		user-select: none;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--console-faint);
		font-family: var(--font-sans);
		font-size: var(--text-callout);
	}
	.notice {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.25rem 0.25rem 0.875rem;
		border-radius: 999px;
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			var(--shadow-raised);
		color: var(--text-default);
		font-family: var(--font-sans);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		translate: -50% 0;
	}
	.notice :global(.button) {
		border-radius: 999px;
		corner-shape: round;
	}
</style>
