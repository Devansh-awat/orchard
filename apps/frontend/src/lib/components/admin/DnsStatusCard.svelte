<script lang="ts">
	import { RefreshCw } from 'lucide-svelte';
	import { Button, SectionCard, Skeleton, StatusBadge, statusMeta } from '$lib/components/ui';
	import type { StatusKind } from '$lib/components/ui/status';

	export interface DnsRow {
		role: string;
		record: string;
		probe: string;
		label: string;
		detail: string;
		verdict: 'ok' | 'missing' | 'different' | 'unknown';
		addresses: string[];
		expected: string[];
		message: string;
	}

	export interface DnsReport {
		checkedAt: string;
		reference: string[];
		rows: DnsRow[];
	}

	let {
		report,
		loading = false,
		refreshing = false,
		onRefresh
	}: {
		report: DnsReport | null;
		loading?: boolean;
		refreshing?: boolean;
		onRefresh: () => void;
	} = $props();

	const VERDICT: Record<DnsRow['verdict'], { kind: StatusKind; label: string }> = {
		ok: { kind: 'success', label: 'Points here' },
		missing: { kind: 'warning', label: 'No record' },
		different: { kind: 'info', label: 'Different address' },
		unknown: { kind: 'neutral', label: 'Unverified' }
	};
</script>

<SectionCard
	title="DNS"
	description="Every hostname this instance serves must point to the same place as the dashboard. A hostname that doesn't resolve can't get a certificate."
>
	{#if loading}
		<Skeleton class="h-40 w-full" />
	{:else if !report || report.rows.length === 0}
		<p class="dns-empty">This instance has no domain to check.</p>
	{:else}
		<ul class="dns-rows">
			{#each report.rows as row (row.record)}
				{@const verdict = VERDICT[row.verdict]}
				<li class="dns-row">
					<div class="dns-head">
						<code class="dns-record">{row.record}</code>
						<StatusBadge meta={statusMeta(verdict.kind, verdict.label)} />
					</div>
					<p class="dns-label">{row.label}</p>
					<p class="dns-message">{row.message}</p>
					{#if row.addresses.length}
						<p class="dns-addresses">Resolves to {row.addresses.join(', ')}</p>
					{/if}
					{#if row.verdict !== 'ok' && row.expected.length}
						<p class="dns-addresses">Should resolve to {row.expected.join(', ')}</p>
					{/if}
					{#if row.probe !== row.record}
						<p class="dns-probe">Checked with {row.probe}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<div class="dns-actions">
		{#if report}
			<span class="dns-checked">Checked {new Date(report.checkedAt).toLocaleTimeString()}</span>
		{/if}
		<Button variant="secondary" loading={refreshing} onclick={onRefresh}>
			<RefreshCw size={14} />
			Check again
		</Button>
	</div>
</SectionCard>

<style>
	.dns-rows {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.dns-row {
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--border-edge);
		border-radius: var(--radius-md);
		background-color: var(--bg-raised);
	}

	.dns-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.3rem;
	}

	.dns-record {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-fg);
		word-break: break-all;
	}

	.dns-label {
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--text-muted);
	}

	.dns-message,
	.dns-addresses,
	.dns-probe {
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--text-faint);
	}

	.dns-message {
		margin-top: 0.15rem;
	}

	.dns-empty {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.dns-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.dns-checked {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
</style>
