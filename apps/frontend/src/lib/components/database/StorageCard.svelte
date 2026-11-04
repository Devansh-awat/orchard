<script lang="ts">
	import { untrack } from 'svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Alert, Button, SectionCard, Stepper } from '$lib/components/ui';
	import CapacityList from '$lib/components/ui/CapacityList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import type { DatabaseDetail } from './types';
	import { parseStorageBytes, storageExpansionError } from './storage-size';

	let {
		database,
		value = $bindable(''),
		dirty = $bindable(false),
		saving,
		warning,
		onExpand
	}: {
		database: DatabaseDetail;
		value: string;
		dirty: boolean;
		saving: boolean;
		warning: string | null;
		onExpand: () => void;
	} = $props();

	const GIB = 1024 ** 3;
	const MIB = 1024 ** 2;
	const MAX_GIB = 200;
	const WAL_SEGMENT = 16 * MIB;
	const PAUSE_AT = 0.92;
	const RESUME_BELOW = 85;

	let confirmOpen = $state(false);

	const live = $derived(database.liveStatus);
	const volume = $derived(live?.volume ?? null);
	const paused = $derived(!!live?.writeGuard);
	const resumeAt = $derived(paused ? (live?.resumeWritesAt ?? null) : null);
	const walPending = $derived(live?.walPendingSegments ?? 0);
	const instances = $derived(Math.max(1, database.replicas ?? 1));

	const currentBytes = $derived(Number(parseStorageBytes(database.storageSize) ?? 0n));
	const minGi = $derived(Math.max(1, Math.ceil(currentBytes / GIB)));
	const draftBytes = $derived(Number(parseStorageBytes(value) ?? 0n));
	const draftGi = $derived(dirty && draftBytes > 0 ? Math.ceil(draftBytes / GIB) : minGi);
	let gi = $state(1);
	$effect.pre(() => {
		gi = draftGi;
	});
	$effect(() => {
		const next = gi;
		if (Number.isFinite(next) && next !== untrack(() => draftGi)) pick(next);
	});

	const error = $derived(dirty ? storageExpansionError(database.storageSize, value) : null);
	const canGrow = $derived(dirty && error == null && !saving);
	const stillPaused = $derived.by(() => {
		const needed = Number(parseStorageBytes(resumeAt) ?? 0n);
		return dirty && needed > 0 && draftBytes < needed;
	});

	function bytes(n: number): string {
		if (n >= GIB) return `${Number((n / GIB).toFixed(1))} GiB`;
		return `${Math.round(n / MIB)} MiB`;
	}

	function size(raw: string | null | undefined): string {
		const n = Number(parseStorageBytes(raw) ?? 0n);
		return n > 0 ? bytes(n) : (raw ?? 'Unknown');
	}

	const items = $derived([
		{
			id: 'volume',
			label: 'Used',
			value: volume?.usedBytes ?? null,
			max: volume?.capacityBytes ?? null
		}
	]);

	const usageNote = $derived.by(() => {
		const used = volume?.usedBytes ?? 0;
		const cap = volume?.capacityBytes ?? 0;
		const high = cap > 0 && used / cap >= 0.8;
		if (walPending > 0)
			return `${walPending} WAL ${walPending === 1 ? 'segment' : 'segments'} (${bytes(walPending * WAL_SEGMENT)}) waiting to archive.`;
		if (high)
			return `Writes pause at ${Math.round(PAUSE_AT * 100)}% full and resume under ${RESUME_BELOW}%.`;
		return null;
	});

	const sizeHint = $derived.by(() => {
		if (error) return error;
		if (stillPaused) return `Writes stay paused at this size. Grow to ${size(resumeAt)} or more.`;
		const shown = dirty ? draftBytes : currentBytes;
		const total =
			instances > 1 && shown > 0
				? ` · ${bytes(shown * instances)} across ${instances} instances`
				: '';
		return `Can't shrink later${total}`;
	});

	function pick(next: number) {
		value = `${next}Gi`;
		dirty = next * GIB !== currentBytes;
	}
</script>

<SectionCard title="Storage">
	{#if paused || warning || live?.archiving?.ok === false}
		<div class="notices">
			{#if paused}
				<Alert tone="error" title="Writes are paused because the volume is full">
					{resumeAt
						? `Grow to ${size(resumeAt)} or more and writes resume on their own once the volume is under ${RESUME_BELOW}% full.`
						: `Grow the volume and writes resume on their own once it is under ${RESUME_BELOW}% full.`}
				</Alert>
			{/if}
			{#if live?.archiving?.ok === false}
				<Alert tone="warning" title="WAL archiving is failing">
					WAL keeps filling the volume until you fix archiving. Growing the volume only delays this.
				</Alert>
			{/if}
			{#if warning}
				<Alert tone="warning">{warning}</Alert>
			{/if}
		</div>
	{/if}

	<SettingsList label="Storage">
		<div class="usage">
			<CapacityList label="Volume use" {items} format={bytes} warning={0.8} error={PAUSE_AT} />
			{#if usageNote}<p class="note">{usageNote}</p>{/if}
		</div>

		<SettingRow label="Size" for="database-storage-size" hint={sizeHint}>
			<span class="commit" class:commit--on={dirty} aria-hidden={!dirty}>
				<Button
					variant="primary"
					size="sm"
					disabled={!canGrow}
					loading={saving}
					onclick={() => (confirmOpen = true)}>Grow to {bytes(draftBytes || currentBytes)}</Button
				>
			</span>
			<Stepper
				id="database-storage-size"
				label="Size per instance"
				size="sm"
				shape="capsule"
				suffix="GiB"
				min={minGi}
				max={MAX_GIB}
				disabled={saving}
				bind:value={gi}
			/>
		</SettingRow>
	</SettingsList>
</SectionCard>

<ConfirmModal
	bind:open={confirmOpen}
	title="Grow storage to {bytes(draftBytes)}?"
	description={`Every instance's volume grows from ${size(database.storageSize)} to ${bytes(draftBytes)} without a restart. Storage can't shrink later.`}
	confirmLabel="Grow storage"
	danger={false}
	onconfirm={onExpand}
	oncancel={() => {}}
/>

<style>
	.notices {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-6);
	}
	.usage {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.note {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.commit {
		display: inline-flex;
		visibility: hidden;
		opacity: 0;
		transition:
			opacity var(--fade-out) var(--curve-in),
			visibility 0s var(--fade-out);
	}
	.commit--on {
		visibility: visible;
		opacity: 1;
		transition:
			opacity var(--fade-in) var(--curve-out),
			visibility 0s;
	}
</style>
