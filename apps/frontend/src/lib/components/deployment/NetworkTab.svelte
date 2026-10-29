<script lang="ts">
	import { env } from '$env/dynamic/public';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';
	import { EthernetPort, Plus } from 'lucide-svelte';
	import { Button, EmptyState } from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import AddressLedger from './network/AddressLedger.svelte';
	import AddressModal from './network/AddressModal.svelte';
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

	let addressFor = $state<PortEntry | null>(null);

	function webKey(entry: PortEntry) {
		const key = domainKeyOf(entry);
		return key && deployment.project?.id && domainServiceOptions.some((o) => o.key === key)
			? key
			: null;
	}

	function kindsFor(entry: PortEntry | null) {
		return {
			web: !!entry && !!webKey(entry),
			raw: !!entry?.port.id && !(entry.port.publicEnabled && entry.port.publicPort),
			tailnet: tailnet.enabled && !tailnet.exposed,
			tailnetLinked: tailnet.linked
		};
	}

	function canAddFor(entry: PortEntry) {
		const kinds = kindsFor(entry);
		return kinds.web || kinds.raw || kinds.tailnet;
	}

	function openAddress(entry: PortEntry) {
		addressFor = entry;
		const key = webKey(entry);
		if (key) newDomainServiceKey = key;
		domainPortLocked = true;
		showDomainForm = true;
	}

	function expose(entry: PortEntry | null) {
		if (entry?.port.id) onTogglePortPublic(entry.service.id, entry.port.id, false);
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

<Widget>
	{#if entries.length === 0}
		<EmptyState
			title="No ports yet"
			description="Add the port your app listens on. It starts private, and you can make it public after."
		>
			{#snippet icon()}<EthernetPort size={18} />{/snippet}
			<Button variant="secondary" icon={Plus} onclick={openAddPort}>Add a port</Button>
		</EmptyState>
	{:else}
		<AddressLedger
			{entries}
			domainsFor={(entry) => layout.byPort.get(entry.key) ?? []}
			redirects={layout.redirects}
			appDomain={APP_DOMAIN}
			{tailnet}
			canProtect={!!onUpdateProtection}
			canEditRedirect={!!onUpdateRedirect}
			busyPortId={portPublicBusyId}
			{deletingIngressId}
			deletingServiceId={serviceDeletingId}
			{sharedWith}
			{canAddFor}
			onAdd={openAddress}
			onAddPort={openAddPort}
			onUnexpose={(entry) => {
				unexposeFor = entry;
				unexposeOpen = true;
			}}
			onEditPort={openEditPort}
			onRemovePort={(entry) => {
				removePortFor = entry;
				removePortOpen = true;
			}}
			onProtection={openProtection}
			onRedirect={openRedirect}
			onDns={openDns}
			onRemoveDomain={askRemoveDomain}
		/>
	{/if}
</Widget>

<AddressModal
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
	target={addressFor
		? {
				port: addressFor.port.targetPort,
				protocol: (addressFor.port.protocol || 'TCP').toUpperCase(),
				public:
					(layout.byPort.get(addressFor.key) ?? []).length > 0 ||
					(!!addressFor.port.publicEnabled && !!addressFor.port.publicPort)
			}
		: null}
	kinds={kindsFor(addressFor)}
	onOpenRaw={() => expose(addressFor)}
	onJoinTailnet={onExposeTailscale}
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
