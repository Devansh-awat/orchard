<script lang="ts">
	import {
		ArrowUpRight,
		Copy,
		CornerUpRight,
		Ellipsis,
		Globe,
		PenLine,
		Plus,
		Shield,
		Trash2,
		Unplug
	} from 'lucide-svelte';
	import { Button, Menu, MenuItem, MenuSeparator, StatusDot } from '$lib/components/ui';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { statusMeta, type StatusMeta } from '$lib/components/ui/status';
	import { ingressUrl } from '$lib/ingress-url';
	import { toasts } from '$lib/stores';
	import ReachTag from './ReachTag.svelte';
	import {
		PROTECTION_LABELS,
		bareAddress,
		certificateMeta,
		protectionOf,
		redirectLabel,
		type PortEntry,
		type Reach
	} from './network';

	type Line =
		| { kind: 'web'; key: string; ingress: any }
		| { kind: 'raw'; key: string }
		| { kind: 'tailnet'; key: string }
		| { kind: 'private'; key: string };

	type Group = { key: string; entry: PortEntry | null; lines: Line[]; canAdd: boolean };

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

	const groups = $derived.by<Group[]>(() => {
		const out: Group[] = entries.map((entry) => {
			const lines: Line[] = domainsFor(entry).map((ingress) => ({
				kind: 'web' as const,
				key: `web:${ingress.id}`,
				ingress
			}));
			if (isPublic(entry)) lines.push({ kind: 'raw', key: 'raw' });
			if (tailnet.enabled && tailnet.exposed) lines.push({ kind: 'tailnet', key: 'tailnet' });
			lines.push({ kind: 'private', key: 'private' });
			return { key: entry.key, entry, lines, canAdd: canAddFor(entry) };
		});
		if (redirects.length > 0)
			out.push({
				key: 'redirects',
				entry: null,
				lines: redirects.map((ingress) => ({
					kind: 'web' as const,
					key: `web:${ingress.id}`,
					ingress
				})),
				canAdd: false
			});
		return out;
	});

	function isPublic(entry: PortEntry) {
		return !!entry.port.publicEnabled && !!entry.port.publicPort;
	}

	function protocolOf(entry: PortEntry) {
		return (entry.port.protocol || 'TCP').toUpperCase();
	}

	function webStatus(ingress: any): StatusMeta | null {
		if (ingress.redirectTarget) return null;
		return certificateMeta(ingress) ?? live;
	}

	function webDetail(ingress: any): string {
		if (ingress.redirectTarget)
			return `Sends visitors to ${redirectLabel(ingress)} (${ingress.redirectStatus ?? 307})`;
		return [
			ingress.tlsEnabled === false ? 'Not secure' : '',
			PROTECTION_LABELS[protectionOf(ingress)],
			sharedWith(ingress) ?? ''
		]
			.filter(Boolean)
			.join(' · ');
	}

	function reachOf(line: Line): Reach {
		if (line.kind === 'private') return 'project';
		if (line.kind === 'tailnet') return 'devices';
		return 'anyone';
	}

	function isCustom(ingress: any) {
		return !appDomain || !String(ingress.host).endsWith(`.${appDomain}`);
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title: 'Copied', description: text, color: 'success' });
	}
</script>

<div class="ledger">
	<div class="head" aria-hidden="true">
		<span>Port</span>
		<span>Address</span>
		<span>Who can reach it</span>
	</div>

	{#each groups as group (group.key)}
		{@const entry = group.entry}
		<div
			class="group"
			role="group"
			aria-label={entry ? `Port ${entry.port.targetPort}` : 'Redirects'}
		>
			<div class="port" style:grid-row="span {group.lines.length + (group.canAdd ? 1 : 0)}">
				{#if entry}
					<span class="port-num">{entry.port.targetPort}</span>
					<span class="port-proto">{protocolOf(entry)}</span>
				{:else}
					<span class="port-icon"><CornerUpRight size={16} /></span>
					<span class="port-proto">Redirects</span>
				{/if}
			</div>

			{#each group.lines as line (line.key)}
				<div class="line" class:line--base={line.kind === 'private'}>
					<div class="addr">
						{#if line.kind === 'web'}
							{@const ingress = line.ingress}
							{@const status = webStatus(ingress)}
							<span class="addr-main">
								<span class="host">{ingress.host}</span
								>{#if ingress.path && ingress.path !== '/'}<span class="path">{ingress.path}</span
									>{/if}
							</span>
							<span class="addr-sub">
								{#if status}<StatusDot meta={status} />
									<span class="status">{status.label}</span>{/if}
								{#if webDetail(ingress)}<span class="detail"
										>{status ? ' · ' : ''}{webDetail(ingress)}</span
									>{/if}
							</span>
						{:else if line.kind === 'raw' && entry}
							<span class="addr-main"
								><span class="host"
									>{entry.port.publicAddress ?? `Port ${entry.port.publicPort}`}</span
								></span
							>
							<span class="addr-sub"
								><span class="detail">Direct {protocolOf(entry)} connection</span></span
							>
						{:else if line.kind === 'tailnet' && entry}
							{#if tailnet.host}
								<span class="addr-main"
									><span class="host">{tailnet.host}:{entry.port.targetPort}</span></span
								>
								<span class="addr-sub"><span class="detail">Tailscale</span></span>
							{:else}
								<span class="addr-main"><span class="host">Tailscale</span></span>
								<span class="addr-sub"
									><StatusDot meta={connecting} /><span class="status">Connecting</span></span
								>
							{/if}
						{:else if line.kind === 'private' && entry}
							<span class="addr-main"
								><span class="host host--quiet"
									>{bareAddress(entry.internalUrl) ?? 'No address yet'}</span
								></span
							>
							<span class="addr-sub"
								><span class="detail">Other apps in this project can reach it</span></span
							>
						{/if}
					</div>

					<div class="reach"><ReachTag reach={reachOf(line)} /></div>

					<div class="acts">
						{#if line.kind === 'web'}
							{@const ingress = line.ingress}
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
								{#if ingress.redirectTarget}
									{#if canEditRedirect}
										<MenuItem icon={PenLine} onclick={() => onRedirect(ingress)}
											>Edit redirect…</MenuItem
										>
									{/if}
								{:else if canProtect}
									<MenuItem icon={Shield} onclick={() => onProtection(ingress)}
										>Who can visit…</MenuItem
									>
								{/if}
								{#if isCustom(ingress)}
									<MenuItem icon={Globe} onclick={() => onDns(ingress)}>DNS settings…</MenuItem>
								{/if}
								<MenuSeparator />
								<MenuItem icon={Trash2} danger onclick={() => onRemoveDomain(ingress)}
									>Remove address</MenuItem
								>
							</Menu>
						{:else if line.kind === 'raw' && entry}
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
									>Make private</MenuItem
								>
							</Menu>
						{:else if line.kind === 'tailnet' && entry}
							{#if tailnet.host}
								<CopyButton value="{tailnet.host}:{entry.port.targetPort}" label="Copy address" />
							{/if}
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
						{:else if line.kind === 'private' && entry}
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
								<MenuItem icon={Trash2} danger onclick={() => onRemovePort(entry)}
									>Remove port</MenuItem
								>
							</Menu>
						{/if}
					</div>
				</div>
			{/each}

			{#if group.canAdd && entry}
				<div class="line line--add">
					<button type="button" class="add" onclick={() => onAdd(entry)}>
						<Plus size={14} strokeWidth={2.25} aria-hidden="true" />
						<span>{group.lines.length > 1 ? 'Add another address' : 'Make it public'}</span>
					</button>
				</div>
			{/if}
		</div>
	{/each}

	<div class="foot">
		<button type="button" class="add" onclick={onAddPort}>
			<Plus size={14} strokeWidth={2.25} aria-hidden="true" />
			<span>Add a port</span>
		</button>
	</div>
</div>

<style>
	.ledger {
		container-type: inline-size;
		display: grid;
		grid-template-columns: 5rem minmax(0, 1fr) 8.75rem 4.75rem;
	}
	.head,
	.group,
	.line {
		display: grid;
		grid-template-columns: subgrid;
	}
	.head {
		grid-column: 1 / -1;
		padding-bottom: 0.625rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.head > span {
		text-box: trim-both cap alphabetic;
	}
	.group {
		grid-column: 1 / -1;
		align-items: start;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.port {
		grid-column: 1;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding-top: 1rem;
	}
	.port-num {
		color: var(--text-default);
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
		line-height: 1;
		text-box: trim-both cap alphabetic;
	}
	.port-icon {
		display: inline-flex;
		color: var(--text-muted);
	}
	.port-proto {
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.line {
		grid-column: 2 / -1;
		align-items: center;
		min-height: 3.5rem;
		padding-block: 0.625rem;
	}
	.line + .line {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.line--base {
		color: var(--text-muted);
	}
	.addr {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		padding-right: 1rem;
	}
	.addr-main {
		display: flex;
		min-width: 0;
		overflow-x: clip;
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.host {
		min-width: 0;
		overflow-x: clip;
		color: var(--text-default);
		text-overflow: ellipsis;
	}
	.host--quiet {
		color: var(--text-muted);
		font-weight: var(--weight-regular);
	}
	.path {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.addr-sub {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		white-space: nowrap;
	}
	.addr-sub :global(svg) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.status {
		color: var(--text-default);
	}
	.detail {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
	.status + .detail {
		margin-left: -0.375rem;
		white-space: pre;
	}
	.reach {
		display: flex;
	}
	.acts {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.125rem;
		margin-right: -0.4375rem;
	}
	.line--add {
		min-height: 0;
		padding-block: 0.25rem 0.875rem;
	}
	.line--add + .line,
	.line + .line--add {
		box-shadow: none;
	}
	.foot {
		grid-column: 1 / -1;
		padding-block: 0.875rem 0.125rem;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.add {
		display: inline-flex;
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
	.add:hover {
		background: var(--bg-hover);
	}
	.add:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	@container (max-width: 40rem) {
		.head {
			display: none;
		}
		.ledger {
			grid-template-columns: 0 minmax(0, 1fr) auto auto;
		}
		.port {
			grid-column: 1 / -1;
			grid-row: auto !important;
			flex-direction: row;
			align-items: baseline;
			gap: 0.5rem;
			padding-block: 1rem 0.25rem;
		}
		.line {
			grid-column: 1 / -1;
		}
		.reach {
			padding-right: 0.5rem;
		}
	}
</style>
