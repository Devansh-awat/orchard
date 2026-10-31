<script lang="ts">
	import { Ellipsis, Pencil, Play, Plug, RefreshCw, Square, Trash2 } from 'lucide-svelte';
	import {
		Button,
		Menu,
		MenuItem,
		MenuSeparator,
		StatusBadge,
		resourceStatus
	} from '$lib/components/ui';
	import ResourceHeader from '$lib/components/patterns/ResourceHeader.svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		deleting,
		stopped = false,
		stopping = false,
		starting = false,
		restarting = false,
		onOpenDeleteModal,
		onRename,
		onStop,
		onStart,
		onRestart,
		onConnect = undefined,
		statusOverride
	}: {
		database: DatabaseDetail;
		deleting: boolean;
		stopped?: boolean;
		stopping?: boolean;
		starting?: boolean;
		restarting?: boolean;
		onOpenDeleteModal: () => void;
		onRename?: () => void;
		onStop?: () => void;
		onStart?: () => void;
		onRestart?: () => void;
		onConnect?: () => void;
		statusOverride?: string;
	} = $props();

	const status = $derived(resourceStatus(statusOverride ?? database.status));
	const instances = $derived(Math.max(1, database.replicas ?? 1));
	const engine = $derived(database.pgMajor ? `Postgres ${database.pgMajor}` : 'Postgres');
	const factList = $derived(
		[
			engine,
			database.mode === 'cnpg'
				? `${instances} ${instances === 1 ? 'instance' : 'instances'}`
				: database.mode === 'shared'
					? 'Shared'
					: null,
			database.storageSize ? `${database.storageSize.replace(/i$/, '')}B disk` : null,
			database.liveStatus?.size ? `${database.liveStatus.size} of data` : null
		].filter(Boolean) as string[]
	);
</script>

<ResourceHeader title={database.name}>
	{#snippet badges()}<StatusBadge meta={status} />{/snippet}
	{#snippet actions()}
		{#if stopped}
			<Button variant="primary" icon={Play} loading={starting} onclick={onStart}>Start</Button>
		{:else}
			<Button
				variant="secondary"
				icon={RefreshCw}
				loading={restarting}
				disabled={stopping}
				onclick={onRestart}>Restart</Button
			>
			{#if onConnect}
				<Button variant="primary" icon={Plug} onclick={onConnect}>Connect</Button>
			{/if}
		{/if}
		<Menu placement="bottom-end">
			{#snippet trigger(props)}
				<Button {...props} variant="ghost" icon={Ellipsis} label="More actions" />
			{/snippet}
			{#if !stopped && onStop}
				<MenuItem icon={Square} disabled={stopping || restarting} onclick={onStop}>Stop</MenuItem>
			{/if}
			{#if onRename}
				<MenuItem icon={Pencil} onclick={onRename}>Rename</MenuItem>
			{/if}
			<MenuSeparator />
			<MenuItem icon={Trash2} danger disabled={deleting} onclick={onOpenDeleteModal}>
				Delete database
			</MenuItem>
		</Menu>
	{/snippet}
	{#snippet facts()}
		{#each factList as fact (fact)}<span>{fact}</span>{/each}
	{/snippet}
</ResourceHeader>
