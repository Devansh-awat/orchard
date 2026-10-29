<script lang="ts">
	import { Ellipsis, EthernetPort, PenLine, Plus, Trash2, Unplug } from 'lucide-svelte';
	import {
		Badge,
		Button,
		EmptyState,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		StatusBadge
	} from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import type { PortEntry } from './network';

	let {
		entries,
		deletingServiceId,
		tailscale,
		onAddPort,
		onEditPort,
		onRemovePort
	}: {
		entries: PortEntry[];
		deletingServiceId: string | null;
		tailscale: {
			enabled: boolean;
			linked: boolean;
			exposed: boolean;
			busy: boolean;
			host: string | null;
			onExpose: () => void;
			onUnexpose: () => void;
		};
		onAddPort: () => void;
		onEditPort: (entry: PortEntry) => void;
		onRemovePort: (entry: PortEntry) => void;
	} = $props();

	const connecting = statusMeta('progress', 'Connecting', true);

	const tailnetAddress = $derived(
		tailscale.host
			? entries.length === 1
				? `${tailscale.host}:${entries[0].port.targetPort}`
				: tailscale.host
			: null
	);
</script>

<Widget title="Private" class="net-card">
	{#snippet meta()}
		<Button variant="ghost" size="sm" icon={Plus} class="net-add" onclick={onAddPort}>Add</Button>
	{/snippet}

	{#if entries.length === 0}
		<EmptyState title="No ports">
			{#snippet icon()}<EthernetPort size={18} />{/snippet}
			<Button variant="secondary" icon={Plus} onclick={onAddPort}>Add port</Button>
		</EmptyState>
	{:else}
		<List inset={false} label="Private addresses">
			{#each entries as entry (entry.key)}
				<ListRow flush pinned presence title="Port {entry.port.targetPort}">
					{#snippet titleSuffix()}
						<Badge>{entry.port.protocol || 'TCP'}</Badge>
					{/snippet}
					{#snippet subtitle()}
						<span class="mono">{entry.internalUrl ?? 'No address yet'}</span>
					{/snippet}
					{#snippet actions()}
						<span class="acts">
							{#if entry.internalUrl}
								<CopyButton value={entry.internalUrl} label="Copy address" />
							{/if}
							<Menu placement="bottom-end">
								{#snippet trigger(props)}
									<Button
										{...props}
										variant="ghost"
										size="sm"
										icon={Ellipsis}
										label="Port actions"
										loading={deletingServiceId === entry.service.id}
									/>
								{/snippet}
								<MenuItem icon={PenLine} onclick={() => onEditPort(entry)}>Edit port…</MenuItem>
								<MenuSeparator />
								<MenuItem icon={Trash2} danger onclick={() => onRemovePort(entry)}
									>Remove port</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/each}
			{#if tailscale.enabled}
				<ListRow flush pinned title="Tailscale">
					{#snippet subtitle()}
						{#if tailscale.exposed && tailnetAddress}
							<span class="mono">{tailnetAddress}</span>
						{:else if tailscale.exposed}
							<StatusBadge meta={connecting} variant="plain" />
						{:else if tailscale.linked}
							Off
						{:else}
							Link your Tailscale account first
						{/if}
					{/snippet}
					{#snippet actions()}
						{#if tailscale.exposed}
							<span class="acts">
								{#if tailnetAddress}
									<CopyButton value={tailnetAddress} label="Copy tailnet address" />
								{/if}
								<Menu placement="bottom-end">
									{#snippet trigger(props)}
										<Button
											{...props}
											variant="ghost"
											size="sm"
											icon={Ellipsis}
											label="Tailscale actions"
											loading={tailscale.busy}
										/>
									{/snippet}
									<MenuItem icon={Unplug} danger onclick={tailscale.onUnexpose}>Turn off</MenuItem>
								</Menu>
							</span>
						{:else if tailscale.linked}
							<Button
								variant="secondary"
								size="sm"
								loading={tailscale.busy}
								onclick={tailscale.onExpose}>Turn on</Button
							>
						{:else}
							<Button variant="secondary" size="sm" href="/user/settings">Link account</Button>
						{/if}
					{/snippet}
				</ListRow>
			{/if}
		</List>
	{/if}
</Widget>

<style>
	.mono {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		text-overflow: ellipsis;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
</style>
