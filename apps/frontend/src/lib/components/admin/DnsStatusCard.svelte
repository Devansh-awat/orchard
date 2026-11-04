<script lang="ts">
	import { RefreshCw } from 'lucide-svelte';
	import {
		Alert,
		Button,
		EmptyState,
		List,
		ListRow,
		RelativeTime,
		SectionCard,
		Skeleton,
		Stack,
		StatusBadge,
		Swap,
		statusMeta
	} from '$lib/components/ui';
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
		error = null,
		loading = false,
		refreshing = false,
		onRefresh
	}: {
		report: DnsReport | null;
		error?: string | null;
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

	const stage = $derived(
		loading
			? 'loading'
			: error && !report
				? 'error'
				: !report || report.rows.length === 0
					? 'empty'
					: 'ready'
	);
</script>

{#snippet headerActions()}
	{#if report}
		<span class="checked">Checked <RelativeTime date={report.checkedAt} /></span>
	{/if}
	<Button variant="secondary" size="sm" icon={RefreshCw} loading={refreshing} onclick={onRefresh}>
		Check again
	</Button>
{/snippet}

<SectionCard
	title="DNS"
	description="Every hostname must point to the same place as the dashboard, or it can't get a certificate."
	actions={stage === 'ready' ? headerActions : undefined}
>
	<Swap key={stage}>
		{#if stage === 'loading'}
			<Stack gap="sm">
				<Skeleton height="3.25rem" />
				<Skeleton height="3.25rem" />
			</Stack>
		{:else if stage === 'error'}
			<Alert tone="error" title="Couldn't check DNS">
				{error}
				{#snippet actions()}
					<Button variant="secondary" size="sm" loading={refreshing} onclick={onRefresh}>
						Try again
					</Button>
				{/snippet}
			</Alert>
		{:else if stage === 'empty'}
			<EmptyState title="No domain to check">
				<Button variant="secondary" icon={RefreshCw} loading={refreshing} onclick={onRefresh}>
					Check again
				</Button>
			</EmptyState>
		{:else if report}
			<div class="rows">
				<List inset={false} label="DNS records">
					{#each report.rows as row (row.record)}
						{@const verdict = VERDICT[row.verdict]}
						<ListRow flush title={row.record}>
							{#snippet subtitle()}
								<span class="lines">
									<span>{row.label}. {row.message}</span>
									{#if row.addresses.length}
										<span>Resolves to {row.addresses.join(', ')}</span>
									{/if}
									{#if row.verdict !== 'ok' && row.expected.length}
										<span>Should resolve to {row.expected.join(', ')}</span>
									{/if}
									{#if row.probe !== row.record}
										<span>Checked with {row.probe}</span>
									{/if}
								</span>
							{/snippet}
							{#snippet trailing()}
								<StatusBadge meta={statusMeta(verdict.kind, verdict.label)} />
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</div>
		{/if}
	</Swap>
</SectionCard>

<style>
	.checked {
		color: var(--text-faint);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
	}
	.rows {
		margin-block: -0.75rem;
	}
	.lines {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		white-space: normal;
		overflow-wrap: anywhere;
	}
</style>
