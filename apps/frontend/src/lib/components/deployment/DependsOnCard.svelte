<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import { apiFetch } from '$lib/stores';
	import Widget from '$lib/components/ui/Widget.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta, type StatusKind } from '$lib/components/ui/status';
	import IslandPill from '$lib/components/patterns/IslandPill.svelte';

	type Dependency = {
		kind: 'database' | 'deployment';
		id: string;
		name: string;
		binding: string;
		status: 'healthy' | 'warning' | 'error' | 'stopped';
		lines: { tone: 'error' | 'warning' | 'neutral'; text: string }[];
	};

	let { deploymentId }: { deploymentId: string } = $props();

	const query = createQuery<Dependency[]>(() => ({
		queryKey: ['dependencies', deploymentId],
		enabled: !!deploymentId,
		staleTime: 30_000,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/dependencies`);
			if (!res.ok) return [];
			return ((await res.json())?.dependencies ?? []) as Dependency[];
		}
	}));

	const deps = $derived(query.data ?? []);

	const KIND: Record<Dependency['status'], StatusKind> = {
		healthy: 'success',
		warning: 'warning',
		error: 'error',
		stopped: 'neutral'
	};
	const TONE: Record<Dependency['status'], 'ok' | 'warn' | 'bad'> = {
		healthy: 'ok',
		warning: 'warn',
		error: 'bad',
		stopped: 'ok'
	};
	const LABEL: Record<Dependency['status'], string> = {
		healthy: 'Healthy',
		warning: 'Needs attention',
		error: 'Failing',
		stopped: 'Stopped'
	};

	function open(d: Dependency) {
		const org = $page.params.orgSlug;
		goto(d.kind === 'database' ? `/${org}/databases/${d.id}` : `/${org}/deployments/${d.id}`);
	}
</script>

{#if deps.length}
	<Widget title="Depends on" class="depends">
		<ul class="islands" aria-label="Depends on">
			{#each deps as d (d.kind + d.id)}
				{@const worst = d.lines[0]?.text ?? LABEL[d.status]}
				<li>
					<IslandPill tone={TONE[d.status]} label="{d.name}, {worst}" onclick={() => open(d)}>
						<span class="glyph"
							><StatusDot meta={statusMeta(KIND[d.status], LABEL[d.status])} size={8} /></span
						>
						<span class="name">{d.name}</span>
						<span class="line" class:line--tone={d.status === 'warning' || d.status === 'error'}
							>{worst}</span
						>
					</IslandPill>
				</li>
			{/each}
		</ul>
	</Widget>
{/if}

<style>
	.islands {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.glyph {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 1rem;
		height: 1rem;
	}
	.name {
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.line {
		margin-left: auto;
		overflow: hidden;
		font-size: var(--text-caption);
		color: var(--island-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.line--tone {
		color: inherit;
	}
</style>
