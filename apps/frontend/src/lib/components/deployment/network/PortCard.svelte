<script lang="ts">
	import {
		Cable,
		Ellipsis,
		Globe,
		Lock,
		Network,
		PenLine,
		Plus,
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
	import Widget from '$lib/components/ui/Widget.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import DomainRow from './DomainRow.svelte';
	import type { PortEntry } from './network';

	type Tailnet = {
		enabled: boolean;
		linked: boolean;
		exposed: boolean;
		busy: boolean;
		host: string | null;
		onExpose: () => void;
		onUnexpose: () => void;
	};

	let {
		entry,
		domains,
		appDomain,
		canAddDomain,
		canProtect,
		canEditRedirect,
		busy,
		removing,
		deletingIngressId,
		tailnet,
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
		canAddDomain: boolean;
		canProtect: boolean;
		canEditRedirect: boolean;
		busy: boolean;
		removing: boolean;
		deletingIngressId: string | null;
		tailnet: Tailnet;
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
	const privateOnly = $derived(domains.length === 0 && !exposed && !onTailnet);
	const canAdd = $derived(!!onAddDomain || canExpose || (tailnet.enabled && !tailnet.exposed));
</script>

<Widget class="port-card">
	<div class="head">
		<div class="name">
			<span class="title">Port {entry.port.targetPort}</span>
			<Badge>{protocol}</Badge>
		</div>
		<div class="acts">
			{#if canAdd}
				<Menu placement="bottom-end">
					{#snippet trigger(props)}
						<Button {...props} variant="ghost" size="sm" icon={Plus} class="add" loading={busy}
							>Add</Button
						>
					{/snippet}
					{#if onAddDomain}
						<MenuItem
							icon={Globe}
							disabled={!canAddDomain}
							description="Serve it at a web address"
							onclick={onAddDomain}>Domain</MenuItem
						>
					{/if}
					{#if canExpose}
						<MenuItem
							icon={Cable}
							disabled={busy}
							description="Raw access for game servers and bots"
							onclick={onExpose}>Public {protocol} port</MenuItem
						>
					{/if}
					{#if tailnet.enabled && !tailnet.exposed}
						{#if tailnet.linked}
							<MenuItem
								icon={Network}
								disabled={tailnet.busy}
								description="Every port joins your tailnet"
								onclick={tailnet.onExpose}>Tailnet</MenuItem
							>
						{:else}
							<MenuItem
								icon={Network}
								href="/user/settings"
								description="Link your Tailscale account first">Tailnet</MenuItem
							>
						{/if}
					{/if}
				</Menu>
			{/if}
			<Menu placement="bottom-end">
				{#snippet trigger(props)}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						icon={Ellipsis}
						label="Port {entry.port.targetPort} actions"
						loading={removing}
					/>
				{/snippet}
				<MenuItem icon={PenLine} onclick={onEditPort}>Edit port…</MenuItem>
				<MenuSeparator />
				<MenuItem icon={Trash2} danger onclick={onRemovePort}>Remove port</MenuItem>
			</Menu>
		</div>
	</div>

	<div class="stack">
		<List inset={false} label="Port {entry.port.targetPort}">
			<ListRow
				flush
				pinned
				title={entry.internalUrl ?? 'No private address yet'}
				subtitle={privateOnly ? 'Private. Only apps in this project can reach it.' : 'Private'}
			>
				{#snippet leading()}
					<ToneTile size={28} label="Private address"><Lock size={14} /></ToneTile>
				{/snippet}
				{#snippet actions()}
					{#if entry.internalUrl}
						<span class="acts">
							<CopyButton value={entry.internalUrl} label="Copy private address" />
						</span>
					{/if}
				{/snippet}
			</ListRow>
			{#each domains as ingress (ingress.id)}
				<DomainRow
					{ingress}
					{appDomain}
					{canProtect}
					{canEditRedirect}
					deleting={deletingIngressId === ingress.id}
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
								<MenuItem icon={Unplug} danger onclick={tailnet.onUnexpose}
									>Leave the tailnet</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/if}
		</List>
	</div>
</Widget>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 1.75rem;
		margin-top: -0.25rem;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.title {
		color: var(--text-default);
		font-size: var(--text-headline);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
	.acts :global(.add) {
		border-radius: 999px;
		corner-shape: round;
	}
	.stack {
		margin-top: 0.25rem;
	}
	.stack :global(.row:first-child) {
		padding-top: 0.5rem;
	}
	.stack :global(.row) {
		--spine: 0.875rem;
		--tile: 0.875rem;
	}
	.stack :global(.row:not(:first-child)) {
		box-shadow: none;
		background: linear-gradient(var(--border-default), var(--border-default)) 2.5rem 0 /
			calc(100% - 2.5rem) 1px no-repeat;
	}
	.stack :global(.row:not(:last-child)::after),
	.stack :global(.row:not(:first-child)::before) {
		content: '';
		position: absolute;
		left: calc(var(--spine) - 0.5px);
		width: 1px;
		background: var(--rule);
	}
	.stack :global(.row:not(:first-child)::before) {
		top: 0;
		height: calc(50% - var(--tile));
	}
	.stack :global(.row:not(:last-child)::after) {
		top: calc(50% + var(--tile));
		bottom: 0;
	}
</style>
