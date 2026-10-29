<script lang="ts">
	import {
		Cable,
		Ellipsis,
		EthernetPort,
		Globe,
		Network,
		PenLine,
		Trash2,
		Unplug
	} from 'lucide-svelte';
	import {
		Badge,
		Button,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		StatusBadge,
		ToneTile
	} from '$lib/components/ui';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import DomainRow from './DomainRow.svelte';
	import type { PortEntry } from './network';

	type Tailnet = {
		enabled: boolean;
		exposed: boolean;
		busy: boolean;
		host: string | null;
		onUnexpose: () => void;
	};

	let {
		entry,
		domains,
		appDomain,
		canProtect,
		canEditRedirect,
		busy,
		removing,
		deletingIngressId,
		tailnet,
		sharedWith,
		onAddDomain,
		onExpose,
		onUnexpose,
		onEditPort,
		onRemovePort,
		onProtection,
		onRedirect,
		onDns,
		onRemoveDomain
	}: {
		entry: PortEntry;
		domains: any[];
		appDomain: string;
		canProtect: boolean;
		canEditRedirect: boolean;
		busy: boolean;
		removing: boolean;
		deletingIngressId: string | null;
		tailnet: Tailnet;
		sharedWith: (ingress: any) => string | null;
		onAddDomain: (() => void) | null;
		onExpose: () => void;
		onUnexpose: () => void;
		onEditPort: () => void;
		onRemovePort: () => void;
		onProtection: (ingress: any) => void;
		onRedirect: (ingress: any) => void;
		onDns: (ingress: any) => void;
		onRemoveDomain: (ingress: any) => void;
	} = $props();

	const connecting = statusMeta('progress', 'Connecting', true);
	const protocol = $derived((entry.port.protocol || 'TCP').toUpperCase());
	const exposed = $derived(!!entry.port.publicEnabled && !!entry.port.publicPort);
	const canExpose = $derived(!!entry.port.id && !exposed);
	const tailnetAddress = $derived(tailnet.host ? `${tailnet.host}:${entry.port.targetPort}` : null);
	const onTailnet = $derived(tailnet.enabled && tailnet.exposed);
	const endpoint = $derived(entry.port.publicAddress ?? `Public port ${entry.port.publicPort}`);
</script>

<List inset={false} label="Port {entry.port.targetPort}">
	<ListRow
		flush
		pinned
		title="Port {entry.port.targetPort}"
		subtitle={entry.internalUrl ?? 'No private address yet'}
	>
		{#snippet leading()}
			<ToneTile size={28} label="Port"><EthernetPort size={14} /></ToneTile>
		{/snippet}
		{#snippet titleSuffix()}
			<Badge>{protocol}</Badge>
		{/snippet}
		{#snippet actions()}
			<span class="acts">
				{#if entry.internalUrl}
					<CopyButton value={entry.internalUrl} label="Copy private address" />
				{/if}
				<Menu placement="bottom-end">
					{#snippet trigger(props)}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							icon={Ellipsis}
							label="Port {entry.port.targetPort} actions"
							loading={removing || busy}
						/>
					{/snippet}
					{#if onAddDomain}
						<MenuItem icon={Globe} onclick={onAddDomain}>Add a domain…</MenuItem>
					{/if}
					{#if canExpose}
						<MenuItem icon={Cable} onclick={onExpose}>Make it public</MenuItem>
					{/if}
					{#if onAddDomain || canExpose}<MenuSeparator />{/if}
					<MenuItem icon={PenLine} onclick={onEditPort}>Edit port…</MenuItem>
					<MenuItem icon={Trash2} danger onclick={onRemovePort}>Remove port</MenuItem>
				</Menu>
			</span>
		{/snippet}
	</ListRow>
	{#each domains as ingress (ingress.id)}
		<DomainRow
			{ingress}
			{appDomain}
			{canProtect}
			{canEditRedirect}
			deleting={deletingIngressId === ingress.id}
			shared={sharedWith(ingress)}
			{onProtection}
			{onRedirect}
			{onDns}
			onRemove={onRemoveDomain}
		/>
	{/each}
	{#if exposed}
		<ListRow flush pinned presence title={endpoint} subtitle="Public {protocol}">
			{#snippet leading()}
				<ToneTile size={28} label="Public port"><Cable size={14} /></ToneTile>
			{/snippet}
			{#snippet actions()}
				<span class="acts">
					{#if entry.port.publicAddress}
						<CopyButton value={endpoint} label="Copy public address" />
					{/if}
					<Menu placement="bottom-end">
						{#snippet trigger(props)}
							<Button
								{...props}
								variant="ghost"
								size="sm"
								icon={Ellipsis}
								label="Public port actions"
								loading={busy}
							/>
						{/snippet}
						<MenuItem icon={Unplug} danger onclick={onUnexpose}>Stop exposing</MenuItem>
					</Menu>
				</span>
			{/snippet}
		</ListRow>
	{/if}
	{#if onTailnet}
		<ListRow flush pinned title={tailnetAddress ?? 'Tailnet'}>
			{#snippet leading()}
				<ToneTile size={28} label="Tailnet"><Network size={14} /></ToneTile>
			{/snippet}
			{#snippet subtitle()}
				{#if tailnetAddress}Tailnet{:else}<StatusBadge meta={connecting} variant="plain" />{/if}
			{/snippet}
			{#snippet actions()}
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
								label="Tailnet actions"
								loading={tailnet.busy}
							/>
						{/snippet}
						<MenuItem icon={Unplug} danger onclick={tailnet.onUnexpose}>Leave the tailnet</MenuItem>
					</Menu>
				</span>
			{/snippet}
		</ListRow>
	{/if}
</List>

<style>
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
</style>
