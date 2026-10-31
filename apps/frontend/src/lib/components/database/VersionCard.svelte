<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowUpRight, CircleArrowUp, RefreshCw, ShieldCheck } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		ActionRow,
		Alert,
		Button,
		EmptyState,
		SectionCard,
		SectionTitle,
		SettingsList,
		Skeleton,
		Table
	} from '$lib/components/ui';
	import type { TableColumn } from '$lib/components/ui/Table.svelte';
	import SeverityMeter from '$lib/components/ui/SeverityMeter.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import UpgradeSheet from './UpgradeSheet.svelte';
	import { monthYear, severityOf } from './versions';
	import type { DatabaseDetail, DatabaseOperation, DatabaseSecurity, Vulnerability } from './types';

	let {
		database,
		onupgrade
	}: {
		database: DatabaseDetail;
		onupgrade: (op: DatabaseOperation) => void;
	} = $props();

	let security = $state<DatabaseSecurity | null>(null);
	let failed = $state(false);
	let sheetOpen = $state(false);

	async function load() {
		failed = false;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/security`);
			if (!res.ok) throw new Error();
			security = await res.json();
		} catch {
			failed = true;
		}
	}

	onMount(load);

	const upgrading = $derived(database.status === 'upgrading');
	const newest = $derived(security?.upgrades.length ? Math.max(...security.upgrades) : null);
	const ended = $derived(
		!!security &&
			(security.supported === false ||
				(!!security.eolDate && Date.parse(security.eolDate) < Date.now()))
	);

	const supportLine = $derived.by(() => {
		if (!security) return '';
		if (ended)
			return security.eolDate
				? `No security fixes since ${monthYear(security.eolDate)}`
				: 'No longer supported';
		if (security.eolDate) return `Supported until ${monthYear(security.eolDate)}`;
		return security.supported ? 'Supported' : 'Support unknown';
	});

	const fixedByMinor = $derived(
		security?.minorUpdate ? security.vulnerabilities.filter((v) => !!v.fixedInVersion).length : 0
	);

	const sorted = $derived(
		[...(security?.vulnerabilities ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
	);

	const columns: TableColumn<Vulnerability>[] = [
		{
			id: 'severity',
			label: 'Severity',
			width: '9rem',
			sortable: true,
			sortValue: (v) => v.score ?? -1
		},
		{ id: 'cve', label: 'Vulnerability', width: 'minmax(0, 1fr)', sortable: true },
		{ id: 'component', label: 'Component', width: 'minmax(7rem, 0.3fr)', sortable: true },
		{
			id: 'fix',
			label: 'Fixed in',
			width: 'minmax(6rem, 0.25fr)',
			sortable: true,
			sortValue: (v) => v.fixedInVersion ?? 'zzz'
		}
	];

	function started(op: DatabaseOperation) {
		toasts.add({
			title: `Upgrading ${database.name}`,
			description: 'Follow it in Backups. It is offline only during the upgrade step.',
			color: 'success'
		});
		onupgrade(op);
	}
</script>

<SectionCard title="Version and security">
	{#if failed}
		<EmptyState title="Could not load version details">
			<Button variant="secondary" icon={RefreshCw} onclick={load}>Try again</Button>
		</EmptyState>
	{:else if !security}
		<div class="placeholder">
			<Skeleton height="2.75rem" />
			<Skeleton height="2.75rem" />
		</div>
	{:else}
		<div class="body">
			{#if ended}
				<Alert tone="error" title={`Postgres ${security.major} no longer gets security fixes`}>
					{newest
						? `Upgrade to Postgres ${newest} to keep getting them.`
						: 'Move the data to a database on a supported version.'}
				</Alert>
			{:else if security.endOfLifeSoon}
				<Alert
					tone="warning"
					title={`Postgres ${security.major} support ends ${monthYear(security.eolDate)}`}
				>
					{newest ? `Upgrade to Postgres ${newest} before then.` : 'Plan a move before then.'}
				</Alert>
			{/if}
			<SettingsList>
				<ActionRow label={`Postgres ${security.running}`} hint={supportLine}>
					{#if newest}
						<Button
							size="sm"
							icon={CircleArrowUp}
							disabled={upgrading}
							onclick={() => (sheetOpen = true)}
						>
							{upgrading ? 'Upgrading' : `Upgrade to Postgres ${newest}`}
						</Button>
					{:else}
						<span></span>
					{/if}
				</ActionRow>
				{#if security.minorUpdate}
					<ActionRow
						label={`Minor update to ${security.minorUpdate.to} ${security.minorUpdate.automatic ? 'is applied automatically' : 'is available'}`}
						hint={fixedByMinor
							? `Fixes ${fixedByMinor === security.vulnerabilities.length ? 'every vulnerability' : `${fixedByMinor} of the vulnerabilities`} below. Instances restart one at a time.`
							: 'Instances restart one at a time.'}
					>
						<span></span>
					</ActionRow>
				{/if}
				{#if sorted.length === 0}
					<ActionRow
						label="No known vulnerabilities"
						hint={security.advisoriesFetchedAt
							? `Checked against postgresql.org ${formatRelativeTime(new Date(security.advisoriesFetchedAt))}`
							: 'Checked against postgresql.org'}
					>
						<span class="clear"><ShieldCheck size={16} aria-hidden="true" /></span>
					</ActionRow>
				{/if}
			</SettingsList>
		</div>
	{/if}
</SectionCard>

{#if security && sorted.length > 0}
	<section class="vulns" aria-label="Known vulnerabilities">
		<SectionTitle title="Known vulnerabilities" size="md" count={sorted.length}>
			{#snippet actions()}
				{#if security?.advisoriesFetchedAt}
					<span class="checked"
						>From postgresql.org, checked <RelativeTime date={security.advisoriesFetchedAt} /></span
					>
				{/if}
			{/snippet}
		</SectionTitle>
		<Table {columns} rows={sorted} rowKey={(v) => v.cve} label="Known vulnerabilities">
			{#snippet cell(v, col)}
				{#if col.id === 'severity'}
					<span class="sev">
						<SeverityMeter severity={severityOf(v.score)} label />
						{#if v.score != null}<span class="score">{v.score.toFixed(1)}</span>{/if}
					</span>
				{:else if col.id === 'cve'}
					<div class="ident">
						<a class="cve" href={v.url} target="_blank" rel="noopener noreferrer"
							>{v.cve}<ArrowUpRight size={12} aria-hidden="true" /></a
						>
						<span class="desc" title={v.description}>{v.description}</span>
					</div>
				{:else if col.id === 'component'}
					<span class="muted">{v.component}</span>
				{:else if v.fixedInVersion}
					<span class="version">{v.fixedInVersion}</span>
				{:else}
					<span class="nofix">Upgrade to fix</span>
				{/if}
			{/snippet}
		</Table>
	</section>
{/if}

{#if security && newest}
	<UpgradeSheet bind:open={sheetOpen} {database} {security} onstarted={started} />
{/if}

<style>
	.body,
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		gap: 0.5rem;
	}
	.vulns {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		margin-top: var(--space-2);
	}
	.clear {
		display: inline-flex;
		color: var(--status-success);
	}
	.checked {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.sev {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.score {
		font-size: var(--text-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.ident {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		padding-block: 0.75rem;
	}
	.cve {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		width: fit-content;
		color: var(--text-default);
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		text-decoration: none;
	}
	.cve:hover {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.cve :global(svg) {
		color: var(--text-faint);
	}
	.desc {
		display: -webkit-box;
		overflow: hidden;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.muted {
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
	.version {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		color: var(--text-default);
	}
	.nofix {
		font-size: var(--text-callout);
		color: var(--status-warning);
	}
</style>
