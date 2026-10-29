<script lang="ts">
	import {
		ArrowUpRight,
		Cable,
		Copy,
		Ellipsis,
		Globe,
		PenLine,
		Plus,
		Shield,
		Trash2,
		Unplug
	} from 'lucide-svelte';
	import {
		Button,
		EmptyState,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuLabel,
		MenuSeparator,
		StatusBadge
	} from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { ingressUrl } from '$lib/ingress-url';
	import { toasts } from '$lib/stores';
	import {
		PROTECTION_LABELS,
		certificateMeta,
		displayHost,
		protectionOf,
		redirectLabel,
		type PortEntry
	} from './network';

	let {
		ingresses,
		entries,
		services,
		appDomain,
		publicDomain,
		canAddDomain,
		canProtect,
		canEditRedirect,
		busyPortId,
		deletingIngressId,
		onAddDomain,
		onExpose,
		onUnexpose,
		onProtection,
		onRedirect,
		onDns,
		onRemove
	}: {
		ingresses: any[];
		entries: PortEntry[];
		services: any[];
		appDomain: string;
		publicDomain: string;
		canAddDomain: boolean;
		canProtect: boolean;
		canEditRedirect: boolean;
		busyPortId: string | null;
		deletingIngressId: string | null;
		onAddDomain: () => void;
		onExpose: (entry: PortEntry) => void;
		onUnexpose: (entry: PortEntry) => void;
		onProtection: (ingress: any) => void;
		onRedirect: (ingress: any) => void;
		onDns: (ingress: any) => void;
		onRemove: (ingress: any) => void;
	} = $props();

	const exposed = $derived(entries.filter((e) => e.port.publicEnabled && e.port.publicPort));
	const exposable = $derived(entries.filter((e) => e.port.id && !e.port.publicEnabled));
	const empty = $derived(ingresses.length === 0 && exposed.length === 0);

	function targetPort(ingress: any): number | null {
		const route = ingress.routes?.[0];
		const servicePort = route?.servicePort ?? ingress.service?.port;
		const name = route?.serviceName ?? ingress.service?.name;
		const service = services.find((s) => s.name === name) ?? services[0];
		const match = (service?.ports ?? []).find((p: any) => p.port === servicePort);
		return match?.targetPort ?? service?.targetPort ?? servicePort ?? null;
	}

	function domainFacts(ingress: any): string {
		if (ingress.redirectTarget)
			return `Redirects to ${redirectLabel(ingress)} · ${ingress.redirectStatus ?? 307}`;
		const port = targetPort(ingress);
		const protection = PROTECTION_LABELS[protectionOf(ingress)];
		return [port ? `Port ${port}` : '', ingress.tlsEnabled === false ? 'HTTP only' : '', protection]
			.filter(Boolean)
			.join(' · ');
	}

	function endpointOf(entry: PortEntry): string {
		return publicDomain
			? `${publicDomain}:${entry.port.publicPort}`
			: `Public port ${entry.port.publicPort}`;
	}

	function isCustom(ingress: any) {
		return !appDomain || !String(ingress.host).endsWith(`.${appDomain}`);
	}

	async function copy(text: string, title: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title, description: text, color: 'success' });
	}
</script>

<Widget title="Public" class="net-card">
	{#snippet meta()}
		<Menu placement="bottom-end">
			{#snippet trigger(props)}
				<Button
					{...props}
					variant="ghost"
					size="sm"
					icon={Plus}
					class="net-add"
					loading={!!busyPortId && exposable.some((e) => e.port.id === busyPortId)}>Add</Button
				>
			{/snippet}
			<MenuItem
				icon={Globe}
				disabled={!canAddDomain}
				description="Serve it at a web address"
				onclick={onAddDomain}>Domain</MenuItem
			>
			{#if exposable.length > 0}
				<MenuSeparator />
				<MenuLabel>Open a port</MenuLabel>
				{#each exposable as entry (entry.key)}
					<MenuItem
						icon={Cable}
						disabled={!!busyPortId}
						description="Raw access for game servers and bots"
						onclick={() => onExpose(entry)}
						>{entry.port.protocol || 'TCP'} port {entry.port.targetPort}</MenuItem
					>
				{/each}
			{/if}
		</Menu>
	{/snippet}

	{#if empty}
		<EmptyState title="Not on the internet yet">
			{#snippet icon()}<Globe size={18} />{/snippet}
			<Button variant="secondary" icon={Plus} disabled={!canAddDomain} onclick={onAddDomain}
				>Add domain</Button
			>
		</EmptyState>
	{:else}
		<List inset={false} label="Public addresses">
			{#each ingresses as ingress (ingress.id)}
				{@const url = ingressUrl(ingress)}
				{@const cert = certificateMeta(ingress)}
				<ListRow flush pinned presence title={displayHost(ingress)} subtitle={domainFacts(ingress)}>
					{#snippet titleSuffix()}
						{#if cert}<StatusBadge meta={cert} variant="plain" />{/if}
					{/snippet}
					{#snippet actions()}
						<span class="acts">
							<Button
								variant="ghost"
								size="sm"
								icon={ArrowUpRight}
								label="Open {ingress.host}"
								href={url}
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
										label="Domain actions"
										loading={deletingIngressId === ingress.id}
									/>
								{/snippet}
								<MenuItem icon={Copy} onclick={() => copy(url, 'Copied URL')}>Copy URL</MenuItem>
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
									<MenuItem icon={Globe} onclick={() => onDns(ingress)}>DNS…</MenuItem>
								{/if}
								<MenuSeparator />
								<MenuItem icon={Trash2} danger onclick={() => onRemove(ingress)}
									>Remove domain</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/each}
			{#each exposed as entry (entry.key)}
				{@const endpoint = endpointOf(entry)}
				<ListRow
					flush
					pinned
					presence
					title={endpoint}
					subtitle="{entry.port.protocol || 'TCP'} to port {entry.port.targetPort}"
				>
					{#snippet actions()}
						<span class="acts">
							{#if publicDomain}<CopyButton value={endpoint} label="Copy address" />{/if}
							<Menu placement="bottom-end">
								{#snippet trigger(props)}
									<Button
										{...props}
										variant="ghost"
										size="sm"
										icon={Ellipsis}
										label="Port actions"
										loading={busyPortId === entry.port.id}
									/>
								{/snippet}
								<MenuItem icon={Unplug} danger onclick={() => onUnexpose(entry)}
									>Stop exposing</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</Widget>

<style>
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
</style>
