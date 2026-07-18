<script lang="ts">
	import { GitCommit, Layers } from 'lucide-svelte';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { apiFetch, selectedOrganization, subscribeOrgEvents, sseStatusFor } from '$lib/stores';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';

	interface BuildRun {
		id: string;
		status: string;
		triggerType: string;
		commitSha?: string | null;
		commitMessage?: string | null;
		branch?: string | null;
		createdAt: string;
	}

	let { deploymentId }: { deploymentId: string } = $props();

	// `?buildqueue=demo` injects mock rows entirely client-side (no DB, no API)
	// so the widget can be reviewed on any deployment.
	const demo = $derived($page.url.searchParams.get('buildqueue') === 'demo');
	const DEMO_RUNS: BuildRun[] = [
		{
			id: 'demo-1',
			status: 'scheduled',
			triggerType: 'auto',
			commitSha: 'b2c3d4e5f6a7b8c9',
			commitMessage: 'feat: add dark mode toggle to the widget header',
			branch: 'main',
			createdAt: new Date(Date.now() - 12000).toISOString()
		},
		{
			id: 'demo-2',
			status: 'scheduled',
			triggerType: 'auto',
			commitSha: 'c3d4e5f6a7b8c9d0',
			commitMessage: 'chore: bump embed sdk to 2.4.0',
			branch: 'main',
			createdAt: new Date(Date.now() - 4000).toISOString()
		}
	];

	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	// `runs` is a $state declared before the query so the query's
	// refetchInterval can read it without a temporal-dead-zone cycle (the query
	// feeds it via the effect below). Same shape the deployment query uses.
	let runs = $state<BuildRun[]>([]);

	const query = createQuery(() => ({
		queryKey: ['build-runs', deploymentId],
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/build-runs?limit=20`);
			if (!res.ok) throw new Error(`build-runs ${res.status}`);
			return (await res.json()) as BuildRun[];
		},
		enabled: !!deploymentId && !demo,
		// Adaptive polling matches the deployment query: SSE is the primary
		// channel, polling is the fallback. Something in flight + SSE down =
		// poll hard; idle + SSE up = lean on the event bus.
		refetchInterval: (() => {
			const hasActive = runs.some((r) => r.status === 'scheduled' || r.status === 'building');
			const sseUp = sseStatusValue === 'connected';
			if (hasActive) return sseUp ? 15_000 : 3_000;
			if (!sseUp) return 20_000;
			return 60_000;
		})(),
		refetchIntervalInBackground: false
	}));

	$effect(() => {
		runs = demo ? DEMO_RUNS : (query.data ?? []);
	});

	const queued = $derived(runs.filter((r) => r.status === 'scheduled'));

	// Live updates ride the same Redis Streams SSE bus as everything else; the
	// queue emits `build.changed` for this deployment, which we invalidate on.
	$effect(() => {
		const orgId = $selectedOrganization?.id ?? null;
		if (!orgId) return;
		const statusStore = sseStatusFor(orgId);
		const unsubStatus = statusStore.subscribe((v) => (sseStatusValue = v));
		const unsub = subscribeOrgEvents(orgId, (ev) => {
			if (ev.type === 'build.changed' && ev.id === deploymentId) {
				queryClient.invalidateQueries({ queryKey: ['build-runs', deploymentId] });
			}
		});
		return () => {
			unsub();
			unsubStatus();
		};
	});
</script>

{#if queued.length > 0}
	<div class="bq-card" transition:slide={{ duration: 160 }}>
		<div class="bq-head">
			<Layers size={13} class="bq-head-icon" />
			<span class="bq-head-title">Queued</span>
			<span class="bq-head-count">{queued.length}</span>
		</div>
		<div class="bq-rows">
			{#each queued as run, i (run.id)}
				<div class="bq-row" {@attach motionStagger({ index: i, from: { y: 5 } })}>
					{#if run.commitSha}
						<span class="bq-sha"><GitCommit size={11} />{run.commitSha.slice(0, 7)}</span>
					{/if}
					<span class="bq-msg">{run.commitMessage?.split('\n')[0] || 'Queued build'}</span>
					<span class="bq-when">{timeAgo(run.createdAt)}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.bq-card {
		border-radius: 0.75rem;
		border: 1px solid var(--border-default);
		background: var(--bg-overlay, var(--bg-surface));
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		padding: 0.5rem 0.625rem 0.625rem;
	}

	.bq-head {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.125rem 0.25rem 0.375rem;
	}

	.bq-card :global(.bq-head-icon) {
		color: var(--text-muted);
	}

	.bq-head-title {
		font-size: 0.6875rem;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.bq-head-count {
		font-size: 0.625rem;
		font-weight: 600;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: 999px;
		padding: 0.0625rem 0.375rem;
		margin-left: auto;
	}

	.bq-rows {
		display: flex;
		flex-direction: column;
	}

	.bq-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.25rem;
		min-width: 0;
	}

	.bq-rows .bq-row:not(:last-child) {
		border-bottom: 1px solid var(--border-default);
	}

	.bq-sha {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.6875rem;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.bq-msg {
		font-size: 0.75rem;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}

	.bq-when {
		font-size: 0.625rem;
		color: var(--text-faint);
		white-space: nowrap;
		flex-shrink: 0;
	}
</style>
