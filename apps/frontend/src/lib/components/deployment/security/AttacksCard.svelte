<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Gauge } from 'lucide-svelte';
	import { queryClient } from '$lib/query';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Table } from '$lib/components/ui';
	import type { TableColumn } from '$lib/components/ui/Table.svelte';
	import Widget from '$lib/components/ui/Widget.svelte';
	import MetricPanel from '$lib/components/patterns/MetricPanel.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { ChartSeries } from '$lib/components/ui/time-chart';

	type Kind = 'scanner' | 'injection' | 'auth-bruteforce' | 'flood';
	type Source = { ip: string; count: number; kinds: Kind[] };
	type Report = {
		byKind: Record<Kind, number>;
		series: ({ t: number } & Record<Kind, number>)[];
		topSources: Source[];
		rateLimit: { requests: number; periodSeconds: number } | null;
		rateLimitSupported: boolean;
	};

	let { deploymentId, active }: { deploymentId: string; active: boolean } = $props();

	const DAY = 24 * 60 * 60_000;
	const KINDS: { id: Kind; label: string; color: string }[] = [
		{ id: 'scanner', label: 'Scanners', color: 'var(--amber-7)' },
		{ id: 'injection', label: 'Injection', color: 'var(--red-7)' },
		{ id: 'auth-bruteforce', label: 'Password guessing', color: 'var(--hue-pink)' },
		{ id: 'flood', label: 'Floods', color: 'var(--blue-7)' }
	];
	const LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<Kind, string>;
	const SUGGESTED = { requests: 100, periodSeconds: 60 };
	const COLUMNS: TableColumn<Source>[] = [
		{ id: 'ip', label: 'Source' },
		{ id: 'kinds', label: 'Seen' },
		{ id: 'count', label: 'Requests', align: 'end', numeric: true, width: '7rem' }
	];

	let now = $state(Date.now());
	let confirming = $state(false);
	let saving = $state(false);

	const query = createQuery<Report | null>(() => ({
		queryKey: ['attacks', deploymentId],
		enabled: !!deploymentId && active,
		staleTime: 60_000,
		queryFn: async () => {
			const end = Date.now();
			now = end;
			const res = await apiFetch(
				`/apiv1/deployments/${deploymentId}/security/attacks?start=${end - DAY}&end=${end}`
			);
			return res.ok ? ((await res.json()) as Report) : null;
		}
	}));

	const report = $derived(query.data ?? null);
	const total = $derived(report ? KINDS.reduce((n, k) => n + (report.byKind[k.id] ?? 0), 0) : 0);
	const series = $derived<ChartSeries[]>(
		report
			? KINDS.filter((k) => report.series.some((b) => b[k.id] > 0)).map((k) => ({
					id: k.id,
					label: k.label,
					color: k.color,
					points: report.series.map((b) => ({ x: b.t, y: b[k.id] ?? 0 }))
				}))
			: []
	);
	const count = (v: number) => Math.round(v).toLocaleString();
	const per = (s: number) =>
		s === 1 ? 'a second' : s === 60 ? 'a minute' : s === 3600 ? 'an hour' : `per ${s}s`;

	async function setLimit(limit: { requests: number; periodSeconds: number } | null) {
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/security/rate-limit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(limit ?? { off: true })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.message ?? 'Could not change the rate limit');
			toasts.add({
				title: limit
					? `Each client is limited to ${limit.requests} requests ${per(limit.periodSeconds)}`
					: 'Rate limit removed',
				color: 'success'
			});
			queryClient.invalidateQueries({ queryKey: ['attacks', deploymentId] });
		} catch (err) {
			toasts.add({ title: (err as Error).message, color: 'error' });
		} finally {
			saving = false;
			confirming = false;
		}
	}
</script>

{#snippet sourceCell(s: Source, col: TableColumn<Source>)}
	{#if col.id === 'ip'}
		<span class="mono">{s.ip}</span>
	{:else if col.id === 'kinds'}
		<span class="kinds">{s.kinds.map((k) => LABEL[k]).join(', ')}</span>
	{:else}
		<span class="mono">{count(s.count)}</span>
	{/if}
{/snippet}

{#snippet limitAction()}
	{#if report?.rateLimit}
		<span class="limit"
			>Limited to {report.rateLimit.requests} {per(report.rateLimit.periodSeconds)}</span
		>
		<Button size="sm" variant="ghost" loading={saving} onclick={() => setLimit(null)}
			>Remove limit</Button
		>
	{:else if report?.rateLimitSupported}
		<Button size="sm" icon={Gauge} onclick={() => (confirming = true)}>Rate-limit this app</Button>
	{/if}
{/snippet}

{#if report}
	<div class="attacks">
		<MetricPanel
			title="Attack attempts"
			info="Requests that probed for secrets or admin pages, carried injection payloads, guessed passwords or flooded the app, from its access logs."
			{series}
			from={now - DAY}
			to={now}
			format={count}
			mode="stacked"
			modes={['stacked']}
			sum
			headline={total ? { value: `${count(total)} in 24h`, tone: 'warning' } : undefined}
			empty="No attack attempts in the last 24 hours"
		/>
		<Widget title="Top sources" meta={limitAction}>
			{#if report.topSources.length}
				<Table
					label="Top sources"
					dense
					columns={COLUMNS}
					rows={report.topSources}
					cell={sourceCell}
					rowKey={(s) => s.ip}
				/>
			{:else}
				<p class="empty">Nobody stands out.</p>
			{/if}
		</Widget>
	</div>
{/if}

<ConfirmModal
	bind:open={confirming}
	title="Rate-limit this app?"
	description="Each client gets {SUGGESTED.requests} requests a minute through the app's domains. Anything over that is turned away by the ingress until the minute is up."
	confirmLabel="Rate-limit"
	danger={false}
	onconfirm={() => setLimit(SUGGESTED)}
/>

<style>
	.attacks {
		display: grid;
		grid-template-columns: minmax(0, 1.618fr) minmax(21rem, 1fr);
		gap: 1rem;
		align-items: stretch;
	}
	@media (max-width: 64rem) {
		.attacks {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
	}
	.kinds,
	.limit,
	.empty {
		color: var(--text-muted);
		font-size: var(--text-footnote);
	}
	.empty {
		margin: 0;
		padding: 1rem 0;
	}
</style>
