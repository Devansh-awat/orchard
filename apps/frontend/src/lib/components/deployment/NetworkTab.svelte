<script lang="ts">
	import { env } from '$env/dynamic/public';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';
	import { Cable, EthernetPort, Globe, Network, Plus } from 'lucide-svelte';
	import {
		Button,
		EmptyState,
		List,
		Menu,
		MenuItem,
		MenuLabel,
		MenuSeparator
	} from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import PortGroup from './network/PortGroup.svelte';
	import DomainRow from './network/DomainRow.svelte';
	import DomainModal from './network/DomainModal.svelte';
	import ProtectionModal from './network/ProtectionModal.svelte';
	import RedirectModal from './network/RedirectModal.svelte';
	import DnsModal from './network/DnsModal.svelte';
	import PortModal from './network/PortModal.svelte';
	import {
		displayHost,
		domainKeyOf,
		domainsByPort,
		portEntries,
		type PortEntry,
		type ProtectionMode
	} from './network/network';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN ?? '';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME ?? '';

	let {
		deployment,
		tailscaleFeatureEnabled = false,
		tailscaleLinked,
		tailscaleExposing,
		tailscaleUnexposing,
		tailscaleDns,
		tailscaleIp,
		onExposeTailscale,
		onUnexposeTailscale,
		showServiceForm = $bindable(),
		newServiceForm = $bindable(),
		serviceFormError,
		serviceEditForms = $bindable(),
		serviceEditErrors,
		creatingService,
		serviceSavingId,
		serviceDeletingId,
		portPublicBusyId,
		isEditingServices = $bindable(),
		onCreateService,
		onSaveServicePorts,
		onDeleteService,
		onToggleServiceEdit,
		onTogglePortPublic,
		onResetNewServiceForm,
		onUpdateNewServicePort,
		onUpdateServiceEditPort,
		showDomainForm = $bindable(),
		newDomainHost = $bindable(),
		newDomainPath = $bindable(),
		newDomainTlsEnabled = $bindable(),
		newDomainServiceKey = $bindable(),
		newDomainRoutingMode = $bindable(),
		newDomainRedirectTarget = $bindable(),
		newDomainRedirectStatus = $bindable(),
		showDomainAdvanced = $bindable(),
		creatingDomain,
		domainFormError,
		domainServiceOptions,
		newDomainNormalizedHost,
		newDomainNormalizedPath,
		newDomainConflict,
		deletingIngressId,
		onCreateDomain,
		onDeleteIngress,
		onResetDomainForm,
		onGenerateRandomDomain,
		onCheckDns,
		onUpdateProtection,
		onUpdateRedirect,
		redirectUpdatingId = null,
		protectionUpdatingId,
		projectIngresses = []
	}: {
		deployment: any;
		tailscaleFeatureEnabled?: boolean;
		tailscaleLinked: boolean;
		tailscaleExposing: boolean;
		tailscaleUnexposing: boolean;
		tailscaleDns: string | null;
		tailscaleIp: string | null;
		tailscaleHostname: string | null;
		onExposeTailscale: () => void;
		onUnexposeTailscale: () => void;
		showServiceForm: boolean;
		newServiceForm: ServiceFormState;
		serviceFormError: string | null;
		serviceEditForms: Record<string, ServiceFormState>;
		serviceEditErrors: Record<string, string | null>;
		creatingService: boolean;
		serviceSavingId: string | null;
		serviceDeletingId: string | null;
		portPublicBusyId: string | null;
		isEditingServices: boolean;
		onCreateService: () => void;
		onSaveServicePorts: (serviceId: string) => void;
		onDeleteService: (serviceId: string) => void;
		onToggleServiceEdit: (service: Service) => void;
		onTogglePortPublic: (serviceId: string, portId: string, currentlyEnabled: boolean) => void;
		onResetNewServiceForm: () => void;
		onUpdateNewServicePort: (index: number, changes: Partial<ServicePortForm>) => void;
		onUpdateServiceEditPort: (
			serviceId: string,
			index: number,
			changes: Partial<ServicePortForm>
		) => void;
		onCopyInternalUrl?: (url: string | undefined, serviceId: string) => void;
		copiedUrlId?: string | null;
		showDomainForm: boolean;
		newDomainHost: string;
		newDomainPath: string;
		newDomainTlsEnabled: boolean;
		newDomainServiceKey: string;
		newDomainRoutingMode: 'service' | 'redirect';
		newDomainRedirectTarget: string;
		newDomainRedirectStatus: string;
		showDomainAdvanced: boolean;
		creatingDomain: boolean;
		domainFormError: string | null;
		domainServiceOptions: Array<{ key: string; label: string; serviceName: string; port: number }>;
		newDomainNormalizedHost: string;
		newDomainNormalizedPath: string;
		newDomainConflict: { otherDeployment: boolean; pathCollision: boolean } | null;
		deletingIngressId: string | null;
		onCreateDomain: () => void;
		onDeleteIngress: (ingressId: string) => void;
		onResetDomainForm: () => void;
		onGenerateRandomDomain: () => void;
		onCheckDns?: (domain: string) => Promise<{ valid: boolean; message: string }>;
		onUpdateRedirect?: (
			ingressId: string,
			data: { host: string; redirectTarget: string; redirectStatus: number }
		) => Promise<void>;
		redirectUpdatingId?: string | null;
		onUpdateProtection?: (
			ingressId: string,
			mode: string,
			password?: string,
			bypassPaths?: string[],
			username?: string
		) => Promise<void> | void;
		protectionUpdatingId?: string | null;
		toasts?: unknown;
		projectIngresses?: Array<{
			host: string;
			path?: string;
			deploymentId?: string | null;
			deploymentName?: string;
		}>;
	} = $props();

	const ingresses = $derived<any[]>(deployment.ingresses ?? []);
	const services = $derived<any[]>(deployment.services ?? []);
	const entries = $derived(portEntries(deployment.services));
	const layout = $derived(domainsByPort(ingresses, entries));
	const tailnet = $derived({
		enabled: tailscaleFeatureEnabled,
		linked: tailscaleLinked,
		exposed: !!deployment.tailscaleExposed,
		busy: tailscaleExposing || tailscaleUnexposing,
		host: tailscaleDns || tailscaleIp || null,
		onExpose: onExposeTailscale,
		onUnexpose: onUnexposeTailscale
	});

	let protectionOpen = $state(false);
	let protectionFor = $state<any | null>(null);
	let redirectOpen = $state(false);
	let redirectFor = $state<any | null>(null);
	let dnsOpen = $state(false);
	let dnsFor = $state<any | null>(null);
	let removeDomainOpen = $state(false);
	let removeDomainFor = $state<any | null>(null);
	let removePortOpen = $state(false);
	let removePortFor = $state<PortEntry | null>(null);
	let unexposeOpen = $state(false);
	let unexposeFor = $state<PortEntry | null>(null);
	let editingServiceId = $state<string | null>(null);
	let domainPortLocked = $state(false);

	const exposable = $derived(entries.filter((e) => e.port.id && !e.port.publicEnabled));
	const canAddDomain = $derived(domainServiceOptions.length > 0 && !!deployment.project?.id);
	const canJoinTailnet = $derived(tailnet.enabled && !tailnet.exposed);

	function expose(entry: PortEntry) {
		if (entry.port.id) onTogglePortPublic(entry.service.id, entry.port.id, false);
	}

	const editForm = $derived(editingServiceId ? serviceEditForms[editingServiceId] : undefined);
	const removePortSiblings = $derived(
		removePortFor
			? entries
					.filter((e) => e.service.id === removePortFor!.service.id)
					.map((e) => e.port.targetPort)
			: []
	);

	function openAddPort() {
		showServiceForm = true;
		isEditingServices = true;
	}

	function cancelAddPort() {
		showServiceForm = false;
		onResetNewServiceForm();
		if (Object.keys(serviceEditForms).length === 0) isEditingServices = false;
	}

	function openEditPort(entry: PortEntry) {
		editingServiceId = entry.service.id;
		if (!serviceEditForms[entry.service.id]) onToggleServiceEdit(entry.service);
	}

	function cancelEditPort() {
		const id = editingServiceId;
		editingServiceId = null;
		const service = services.find((s) => s.id === id);
		if (service && serviceEditForms[service.id]) onToggleServiceEdit(service);
	}

	function domainAdder(entry: PortEntry) {
		const key = domainKeyOf(entry);
		if (!key || !domainServiceOptions.some((o) => o.key === key)) return null;
		return () => {
			newDomainServiceKey = key;
			domainPortLocked = true;
			showDomainForm = true;
		};
	}

	function openAddDomain() {
		domainPortLocked = false;
		showDomainForm = true;
	}

	function sharedWith(ingress: any): string | null {
		const path = ingress.path || '/';
		const others = projectIngresses.filter(
			(r) => r.host === ingress.host && (r.path || '/') !== path
		);
		if (others.length === 0) return null;
		const names = others.map(
			(r) =>
				`${r.deploymentId === deployment.id ? 'this app' : (r.deploymentName ?? 'another app')} at ${r.path || '/'}`
		);
		if (names.length > 2) return `Shared with ${names.length} other paths`;
		return `Shared with ${names.join(' and ')}`;
	}

	function openProtection(ingress: any) {
		protectionFor = ingress;
		protectionOpen = true;
	}

	function openRedirect(ingress: any) {
		redirectFor = ingress;
		redirectOpen = true;
	}

	function openDns(ingress: any) {
		dnsFor = ingress;
		dnsOpen = true;
	}

	function askRemoveDomain(ingress: any) {
		removeDomainFor = ingress;
		removeDomainOpen = true;
	}

	async function saveProtection(
		mode: ProtectionMode,
		password?: string,
		paths?: string[],
		username?: string
	) {
		if (!protectionFor || !onUpdateProtection) return;
		try {
			await onUpdateProtection(protectionFor.id, mode, password, paths, username);
			protectionOpen = false;
		} catch {
			protectionOpen = true;
		}
	}

	async function saveRedirect(data: {
		host: string;
		redirectTarget: string;
		redirectStatus: number;
	}) {
		if (!redirectFor || !onUpdateRedirect) return;
		try {
			await onUpdateRedirect(redirectFor.id, data);
			redirectOpen = false;
		} catch {
			redirectOpen = true;
		}
	}
</script>

<Widget title="Ports">
	{#snippet meta()}
		<Menu placement="bottom-end">
			{#snippet trigger(props)}
				<Button
					{...props}
					variant="ghost"
					size="sm"
					icon={Plus}
					class="net-add"
					loading={!!portPublicBusyId}>Add</Button
				>
			{/snippet}
			{#if entries.length > 0}
				<MenuItem
					icon={Globe}
					disabled={!canAddDomain}
					description="Serve it at a web address"
					onclick={openAddDomain}>Domain</MenuItem
				>
				{#if exposable.length === 1}
					<MenuItem
						icon={Cable}
						disabled={!!portPublicBusyId}
						description={entries.length > 1
							? `Opens port ${exposable[0].port.targetPort} to the internet`
							: 'Raw access for game servers and bots'}
						onclick={() => expose(exposable[0])}
						>Public {(exposable[0].port.protocol || 'TCP').toUpperCase()} port</MenuItem
					>
				{:else if exposable.length > 1}
					<MenuSeparator />
					<MenuLabel>Make a port public</MenuLabel>
					{#each exposable as entry (entry.key)}
						<MenuItem icon={Cable} disabled={!!portPublicBusyId} onclick={() => expose(entry)}
							>Port {entry.port.targetPort} · {(
								entry.port.protocol || 'TCP'
							).toUpperCase()}</MenuItem
						>
					{/each}
				{/if}
				{#if canJoinTailnet}
					<MenuItem
						icon={Network}
						disabled={tailnet.busy}
						href={tailnet.linked ? undefined : '/user/settings'}
						onclick={tailnet.linked ? tailnet.onExpose : undefined}
						description={tailnet.linked
							? 'Reach every port from your tailnet'
							: 'Link your Tailscale account first'}>Tailnet</MenuItem
					>
				{/if}
				<MenuSeparator />
			{/if}
			<MenuItem icon={EthernetPort} description="One your app listens on" onclick={openAddPort}
				>Port</MenuItem
			>
		</Menu>
	{/snippet}

	{#if entries.length === 0}
		<EmptyState title="No ports" description="Add the port your app listens on to reach it.">
			{#snippet icon()}<EthernetPort size={18} />{/snippet}
			<Button variant="secondary" icon={Plus} onclick={openAddPort}>Add port</Button>
		</EmptyState>
	{:else}
		<div class="groups">
			{#each entries as entry (entry.key)}
				<div class="group">
					<PortGroup
						{entry}
						domains={layout.byPort.get(entry.key) ?? []}
						appDomain={APP_DOMAIN}
						canProtect={!!onUpdateProtection}
						canEditRedirect={!!onUpdateRedirect}
						busy={!!entry.port.id && portPublicBusyId === entry.port.id}
						removing={serviceDeletingId === entry.service.id}
						{deletingIngressId}
						{tailnet}
						{sharedWith}
						onAddDomain={canAddDomain ? domainAdder(entry) : null}
						onExpose={() => expose(entry)}
						onUnexpose={() => {
							unexposeFor = entry;
							unexposeOpen = true;
						}}
						onEditPort={() => openEditPort(entry)}
						onRemovePort={() => {
							removePortFor = entry;
							removePortOpen = true;
						}}
						onProtection={openProtection}
						onRedirect={openRedirect}
						onDns={openDns}
						onRemoveDomain={askRemoveDomain}
					/>
				</div>
			{/each}
			{#if layout.redirects.length > 0}
				<div class="group group--plain">
					<List inset={false} label="Redirects">
						{#each layout.redirects as ingress (ingress.id)}
							<DomainRow
								{ingress}
								appDomain={APP_DOMAIN}
								canProtect={!!onUpdateProtection}
								canEditRedirect={!!onUpdateRedirect}
								deleting={deletingIngressId === ingress.id}
								onProtection={openProtection}
								onRedirect={openRedirect}
								onDns={openDns}
								onRemove={askRemoveDomain}
							/>
						{/each}
					</List>
				</div>
			{/if}
		</div>
	{/if}
</Widget>

<DomainModal
	bind:open={showDomainForm}
	bind:host={newDomainHost}
	bind:path={newDomainPath}
	bind:tls={newDomainTlsEnabled}
	bind:serviceKey={newDomainServiceKey}
	bind:routing={newDomainRoutingMode}
	bind:redirectTarget={newDomainRedirectTarget}
	bind:redirectStatus={newDomainRedirectStatus}
	bind:advanced={showDomainAdvanced}
	appDomain={APP_DOMAIN}
	cname={INGRESS_CNAME}
	creating={creatingDomain}
	error={domainFormError}
	serviceOptions={domainServiceOptions}
	normalizedHost={newDomainNormalizedHost}
	normalizedPath={newDomainNormalizedPath}
	portLocked={domainPortLocked}
	deploymentId={deployment.id}
	projectRoutes={projectIngresses}
	onCreate={onCreateDomain}
	onReset={onResetDomainForm}
	onGenerate={onGenerateRandomDomain}
	{onCheckDns}
/>

<ProtectionModal
	bind:open={protectionOpen}
	ingress={protectionFor}
	projectId={deployment.project?.id}
	saving={!!protectionFor && protectionUpdatingId === protectionFor.id}
	onSave={saveProtection}
/>

<RedirectModal
	bind:open={redirectOpen}
	ingress={redirectFor}
	saving={!!redirectFor && redirectUpdatingId === redirectFor.id}
	onSave={saveRedirect}
/>

<DnsModal bind:open={dnsOpen} host={dnsFor?.host ?? ''} cname={INGRESS_CNAME} {onCheckDns} />

<PortModal
	open={showServiceForm}
	title="Add a port"
	submitLabel="Add port"
	ports={newServiceForm.ports}
	error={serviceFormError}
	saving={creatingService}
	onUpdate={onUpdateNewServicePort}
	onSubmit={onCreateService}
	onCancel={cancelAddPort}
/>

<PortModal
	open={!!editForm}
	title={(editForm?.ports.length ?? 0) > 1 ? 'Edit ports' : 'Edit port'}
	submitLabel="Save"
	ports={editForm?.ports ?? []}
	error={editingServiceId ? (serviceEditErrors[editingServiceId] ?? null) : null}
	saving={!!editingServiceId && serviceSavingId === editingServiceId}
	onUpdate={(index, changes) =>
		editingServiceId && onUpdateServiceEditPort(editingServiceId, index, changes)}
	onSubmit={() => editingServiceId && onSaveServicePorts(editingServiceId)}
	onCancel={cancelEditPort}
/>

<ConfirmModal
	bind:open={removeDomainOpen}
	title="Remove {removeDomainFor ? displayHost(removeDomainFor) : 'domain'}?"
	description="It stops serving right away."
	confirmLabel="Remove"
	onconfirm={() => removeDomainFor && onDeleteIngress(removeDomainFor.id)}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={removePortOpen}
	title={removePortSiblings.length > 1
		? `Remove ports ${removePortSiblings.join(' and ')}?`
		: `Remove port ${removePortFor?.port.targetPort ?? ''}?`}
	description={removePortSiblings.length > 1
		? 'Domains and apps that use them stop reaching this app.'
		: 'Domains and apps that use it stop reaching this app.'}
	confirmLabel="Remove"
	onconfirm={() => removePortFor && onDeleteService(removePortFor.service.id)}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={unexposeOpen}
	title="Stop exposing port {unexposeFor?.port.targetPort ?? ''}?"
	description="Clients lose the connection. Opening it again may pick a new public port."
	confirmLabel="Stop exposing"
	onconfirm={() =>
		unexposeFor?.port.id && onTogglePortPublic(unexposeFor.service.id, unexposeFor.port.id, true)}
	oncancel={() => {}}
/>

<style>
	:global(.net-add) {
		margin-right: -0.625rem;
		border-radius: 999px;
		corner-shape: round;
	}
	.groups {
		margin-top: -0.25rem;
	}
	.group + .group {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.group:not(.group--plain) :global(.row:not(:first-child)) {
		padding-left: 2.25rem;
		box-shadow: none;
		background: linear-gradient(var(--border-default), var(--border-default)) 4.75rem 0 /
			calc(100% - 4.75rem) 1px no-repeat;
	}
	.group:not(.group--plain) :global(.row:not(:last-child)::after),
	.group:not(.group--plain) :global(.row:not(:first-child)::before) {
		content: '';
		position: absolute;
		left: calc(0.875rem - 0.5px);
		border-left: 1px solid var(--rule);
	}
	.group:not(.group--plain) :global(.row:first-child::after) {
		top: calc(50% + 0.875rem);
		bottom: 0;
	}
	.group:not(.group--plain) :global(.row:not(:first-child)::before) {
		top: 0;
		width: 1.125rem;
		height: 50%;
		border-bottom: 1px solid var(--rule);
		border-bottom-left-radius: 0.5rem;
	}
	.group:not(.group--plain) :global(.row:not(:first-child):not(:last-child)::after) {
		top: 50%;
		bottom: 0;
	}
</style>
