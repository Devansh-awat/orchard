<script lang="ts">
	import {
		ArrowUpRight,
		Copy,
		CornerUpRight,
		Ellipsis,
		EthernetPort,
		Globe,
		MonitorSmartphone,
		PenLine,
		Plug,
		Plus,
		Shield,
		ShieldCheck,
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
		StatusDot,
		ToneTile
	} from '$lib/components/ui';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { ingressUrl } from '$lib/ingress-url';
	import { toasts } from '$lib/stores';
	import {
		PROTECTION_LABELS,
		bareAddress,
		certificateMeta,
		protectionOf,
		redirectLabel,
		type PortEntry
	} from './network';

	let {
		entries,
		domainsFor,
		redirects,
		appDomain,
		tailnet,
		canProtect,
		canEditRedirect,
		busyPortId,
		deletingIngressId,
		deletingServiceId,
		sharedWith,
		canAddFor,
		onAdd,
		onAddPort,
		onUnexpose,
		onEditPort,
		onRemovePort,
		onProtection,
		onRedirect,
		onDns,
		onRemoveDomain
	}: {
		entries: PortEntry[];
		domainsFor: (entry: PortEntry) => any[];
		redirects: any[];
		appDomain: string;
		tailnet: {
			enabled: boolean;
			exposed: boolean;
			busy: boolean;
			host: string | null;
			onUnexpose: () => void;
		};
		canProtect: boolean;
		canEditRedirect: boolean;
		busyPortId: string | null;
		deletingIngressId: string | null;
		deletingServiceId: string | null;
		sharedWith: (ingress: any) => string | null;
		canAddFor: (entry: PortEntry) => boolean;
		onAdd: (entry: PortEntry) => void;
		onAddPort: () => void;
		onUnexpose: (entry: PortEntry) => void;
		onEditPort: (entry: PortEntry) => void;
		onRemovePort: (entry: PortEntry) => void;
		onProtection: (ingress: any) => void;
		onRedirect: (ingress: any) => void;
		onDns: (ingress: any) => void;
		onRemoveDomain: (ingress: any) => void;
	} = $props();

	const connecting = statusMeta('progress', 'Connecting', true);
	const live = statusMeta('success', 'Live');

	function isPublic(entry: PortEntry) {
		return !!entry.port.publicEnabled && !!entry.port.publicPort;
	}

	function protocolOf(entry: PortEntry) {
		return (entry.port.protocol || 'TCP').toUpperCase();
	}

	function hasWaysIn(entry: PortEntry) {
		return domainsFor(entry).length > 0 || isPublic(entry) || (tailnet.enabled && tailnet.exposed);
	}

	function isCustom(ingress: any) {
		return !appDomain || !String(ingress.host).endsWith(`.${appDomain}`);
	}

	function hostTitle(ingress: any) {
		return `${ingress.host}${ingress.path && ingress.path !== '/' ? ingress.path : ''}`;
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title: 'Copied', description: text, color: 'success' });
	}
</script>

{#snippet domainRow(ingress: any)}
	{@const status = ingress.redirectTarget ? null : (certificateMeta(ingress) ?? live)}
	{@const shared = sharedWith(ingress)}
	{@const protection = protectionOf(ingress)}
	<ListRow flush pinned presence title={hostTitle(ingress)}>
		{#snippet leading()}
			{#if ingress.redirectTarget}
				<ToneTile tone="neutral" solid size={28}
					><CornerUpRight size={14} strokeWidth={2.25} /></ToneTile
				>
			{:else}
				<ToneTile tone="info" solid size={28}><Globe size={14} strokeWidth={2.25} /></ToneTile>
			{/if}
		{/snippet}
		{#snippet subtitle()}
			<span class="sub">
				{#if ingress.redirectTarget}
					<span>Redirects to {redirectLabel(ingress)}</span>
				{:else if status}
					<StatusDot meta={status} /><span>{status.label}</span>
				{/if}
				{#if shared}<span class="sep">·</span><span>{shared}</span>{/if}
			</span>
		{/snippet}
		{#snippet actions()}
			<span class="acts">
				{#if !ingress.redirectTarget && canProtect}
					{#if protection === 'none'}
						<Button
							variant="secondary"
							size="sm"
							icon={Shield}
							class="security"
							onclick={() => onProtection(ingress)}>Add security</Button
						>
					{:else}
						<button type="button" class="guard" onclick={() => onProtection(ingress)}>
							<Badge tone="success"
								><ShieldCheck size={12} strokeWidth={2.25} />{PROTECTION_LABELS[protection]}</Badge
							>
						</button>
					{/if}
				{/if}
				<Button
					variant="ghost"
					size="sm"
					icon={ArrowUpRight}
					label="Open {ingress.host}"
					href={ingressUrl(ingress)}
					target="_blank"
					rel="noopener noreferrer"
				/>
				<Menu placement="bottom-end">
					{#snippet trigger(props)}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							icon={Ellipsis}
							label="{ingress.host} actions"
							loading={deletingIngressId === ingress.id}
						/>
					{/snippet}
					<MenuItem icon={Copy} onclick={() => copy(ingressUrl(ingress))}>Copy link</MenuItem>
					{#if ingress.redirectTarget && canEditRedirect}
						<MenuItem icon={PenLine} onclick={() => onRedirect(ingress)}>Edit redirect…</MenuItem>
					{/if}
					{#if isCustom(ingress)}
						<MenuItem icon={Globe} onclick={() => onDns(ingress)}>DNS settings…</MenuItem>
					{/if}
					<MenuSeparator />
					<MenuItem icon={Trash2} danger onclick={() => onRemoveDomain(ingress)}
						>Remove domain</MenuItem
					>
				</Menu>
			</span>
		{/snippet}
	</ListRow>
{/snippet}

<div class="ports">
	{#each entries as entry (entry.key)}
		{@const domains = domainsFor(entry)}
		{@const privateAddress = bareAddress(entry.internalUrl)}
		<section class="port" aria-label="Port {entry.port.targetPort}">
			<header class="head">
				<ToneTile tone="neutral" solid size={36}
					><EthernetPort size={17} strokeWidth={2.25} /></ToneTile
				>
				<div class="head-text">
					<div class="head-title">
						<span class="num">Port {entry.port.targetPort}</span>
						<Badge>{protocolOf(entry)}</Badge>
					</div>
					{#if privateAddress}
						<span class="private">{privateAddress}</span>
					{/if}
				</div>
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
								loading={deletingServiceId === entry.service.id}
							/>
						{/snippet}
						<MenuItem icon={PenLine} onclick={() => onEditPort(entry)}>Change port…</MenuItem>
						<MenuSeparator />
						<MenuItem icon={Trash2} danger onclick={() => onRemovePort(entry)}>Remove port</MenuItem
						>
					</Menu>
				</span>
			</header>

			{#if hasWaysIn(entry)}
				<div class="ways">
					<List inset={false} label="Ways into port {entry.port.targetPort}">
						{#each domains as ingress (ingress.id)}
							{@render domainRow(ingress)}
						{/each}
						{#if isPublic(entry)}
							{@const endpoint = entry.port.publicAddress ?? `Port ${entry.port.publicPort}`}
							<ListRow flush pinned presence title={endpoint}>
								{#snippet leading()}
									<ToneTile tone="success" solid size={28}
										><Plug size={14} strokeWidth={2.25} /></ToneTile
									>
								{/snippet}
								{#snippet actions()}
									<span class="acts">
										{#if entry.port.publicAddress}
											<CopyButton value={entry.port.publicAddress} label="Copy address" />
										{/if}
										<Menu placement="bottom-end">
											{#snippet trigger(props)}
												<Button
													{...props}
													variant="ghost"
													size="sm"
													icon={Ellipsis}
													label="Public port actions"
													loading={busyPortId === entry.port.id}
												/>
											{/snippet}
											<MenuItem icon={Unplug} danger onclick={() => onUnexpose(entry)}
												>Close port</MenuItem
											>
										</Menu>
									</span>
								{/snippet}
							</ListRow>
						{/if}
						{#if tailnet.enabled && tailnet.exposed}
							{@const address = tailnet.host ? `${tailnet.host}:${entry.port.targetPort}` : null}
							<ListRow flush pinned title={address ?? 'Tailscale'}>
								{#snippet leading()}
									<ToneTile tone="neutral" solid size={28}
										><MonitorSmartphone size={14} strokeWidth={2.25} /></ToneTile
									>
								{/snippet}
								{#snippet subtitle()}
									{#if !address}<span class="sub"
											><StatusDot meta={connecting} /><span>Connecting</span></span
										>{/if}
								{/snippet}
								{#snippet actions()}
									<span class="acts">
										{#if address}<CopyButton value={address} label="Copy address" />{/if}
										<Menu placement="bottom-end">
											{#snippet trigger(props)}
												<Button
													{...props}
													variant="ghost"
													size="sm"
													icon={Ellipsis}
													label="Tailscale actions"
													loading={tailnet.busy}
												/>
											{/snippet}
											<MenuItem icon={Unplug} danger onclick={tailnet.onUnexpose}
												>Remove from Tailscale</MenuItem
											>
										</Menu>
									</span>
								{/snippet}
							</ListRow>
						{/if}
					</List>
				</div>
			{/if}

			{#if canAddFor(entry)}
				<button type="button" class="add add--way" onclick={() => onAdd(entry)}>
					<Plus size={14} strokeWidth={2.25} aria-hidden="true" />
					<span>{hasWaysIn(entry) ? 'Add another way in' : 'Make it public'}</span>
				</button>
			{/if}
		</section>
	{/each}

	{#if redirects.length > 0}
		<section class="port" aria-label="Redirects">
			<header class="head">
				<ToneTile tone="neutral" solid size={36}
					><CornerUpRight size={17} strokeWidth={2.25} /></ToneTile
				>
				<div class="head-text">
					<div class="head-title"><span class="num">Redirects</span></div>
				</div>
			</header>
			<div class="ways">
				<List inset={false} label="Redirects">
					{#each redirects as ingress (ingress.id)}
						{@render domainRow(ingress)}
					{/each}
				</List>
			</div>
		</section>
	{/if}

	<div class="foot">
		<button type="button" class="add" onclick={onAddPort}>
			<Plus size={14} strokeWidth={2.25} aria-hidden="true" />
			<span>Add a port</span>
		</button>
	</div>
</div>

<style>
	.ports {
		display: flex;
		flex-direction: column;
	}
	.port {
		display: flex;
		flex-direction: column;
		padding-block: 0.25rem 1rem;
	}
	.port + .port {
		padding-top: 1rem;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
	}
	.head-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.head-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.num {
		color: var(--text-default);
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
	}
	.private {
		min-width: 0;
		overflow-x: clip;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ways {
		margin-top: 0.5rem;
		padding-left: 3rem;
	}
	.sub {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}
	.sep {
		color: var(--text-faint);
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
	.acts :global(.security) {
		margin-right: 0.25rem;
		border-radius: 999px;
		corner-shape: round;
	}
	.guard {
		display: inline-flex;
		margin-right: 0.25rem;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.guard:focus-visible {
		outline: none;
		border-radius: 0.375rem;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.add {
		display: inline-flex;
		align-self: flex-start;
		align-items: center;
		gap: 0.375rem;
		height: 2rem;
		margin-left: -0.625rem;
		padding: 0 0.75rem 0 0.625rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--text-link);
		font: inherit;
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.add--way {
		margin-top: 0.375rem;
		margin-left: 2.375rem;
	}
	.add:hover {
		background: var(--bg-hover);
	}
	.add:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.foot {
		padding-top: 0.75rem;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
</style>
