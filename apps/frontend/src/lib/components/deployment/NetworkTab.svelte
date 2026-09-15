<script lang="ts">
	import { Loader2, Lock, Shield, Check, Network } from 'lucide-svelte';
	import { ChevronDown, Copy, Plus, RefreshCw, Settings, Trash2, Wifi, X } from '@jis3r/icons';
	import { Button, SectionCard, Select, SegmentedControl } from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { env } from '$env/dynamic/public';
	import { ingressUrl } from '$lib/ingress-url';
	import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN ?? '';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME ?? '';
	const PUBLIC_DEPLOYMENT_DOMAIN = env.PUBLIC_DEPLOYMENT_DOMAIN ?? '';

	let {
		deployment,
		// Tailscale (gated behind early access flag)
		tailscaleFeatureEnabled = false,
		tailscaleLinked,
		tailscaleExposing,
		tailscaleUnexposing,
		tailscaleDns,
		tailscaleIp,
		tailscaleHostname,
		onExposeTailscale,
		onUnexposeTailscale,
		// Ports
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
		onCopyInternalUrl,
		copiedUrlId,
		// Domains
		showDomainForm = $bindable(),
		newDomainHost = $bindable(),
		newDomainPath = $bindable(),
		newDomainTlsEnabled = $bindable(),
		newDomainServiceKey = $bindable(),
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
		protectionUpdatingId,
		toasts
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
		onCopyInternalUrl: (url: string | undefined, serviceId: string) => void;
		copiedUrlId: string | null;
		showDomainForm: boolean;
		newDomainHost: string;
		newDomainPath: string;
		newDomainTlsEnabled: boolean;
		newDomainServiceKey: string;
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
		onUpdateProtection?: (
			ingressId: string,
			mode: string,
			password?: string,
			bypassPaths?: string[]
		) => void;
		protectionUpdatingId?: string | null;
		toasts: any;
	} = $props();

	let protectionExpandedId = $state<string | null>(null);
	let protectionMode = $state<string>('none');
	let protectionPassword = $state('');
	let protectionBypassPaths = $state('');
	let copiedBypass = $state(false);

	let domainMode = $state<'orchard' | 'custom'>(APP_DOMAIN ? 'orchard' : 'custom');
	let dnsCheckState = $state<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
	let copiedCname = $state(false);

	const subdomainPrefix = $derived(
		newDomainHost.endsWith(`.${APP_DOMAIN}`)
			? newDomainHost.slice(0, -(APP_DOMAIN.length + 1))
			: newDomainHost
	);

	const dnsRecordName = $derived.by(() => {
		const parts = newDomainNormalizedHost.split('.').filter(Boolean);
		return parts.length > 2 ? parts.slice(0, -2).join('.') : '@';
	});

	let customHostStash = '';

	function setDomainMode(mode: 'orchard' | 'custom') {
		if (mode === domainMode) return;
		if (domainMode === 'custom') customHostStash = newDomainHost;
		domainMode = mode;
		dnsCheckState = 'idle';
		if (mode === 'orchard') {
			newDomainTlsEnabled = true;
			if (!newDomainHost.endsWith(`.${APP_DOMAIN}`)) onGenerateRandomDomain();
		} else {
			newDomainHost = customHostStash;
		}
	}

	function openDomainForm() {
		showDomainForm = !showDomainForm;
		dnsCheckState = 'idle';
		if (!showDomainForm) {
			onResetDomainForm();
		} else if (domainMode === 'orchard' && !newDomainHost) {
			onGenerateRandomDomain();
		}
	}

	function updateSubdomainPrefix(value: string) {
		const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
		newDomainHost = clean ? `${clean}.${APP_DOMAIN}` : '';
	}

	async function checkDns() {
		if (!onCheckDns || !newDomainNormalizedHost) return;
		dnsCheckState = 'checking';
		try {
			const result = await onCheckDns(newDomainNormalizedHost);
			dnsCheckState = result.valid ? 'valid' : 'invalid';
		} catch {
			dnsCheckState = 'invalid';
		}
	}

	async function copyCnameTarget() {
		await navigator.clipboard.writeText(INGRESS_CNAME);
		copiedCname = true;
		setTimeout(() => (copiedCname = false), 2000);
	}

	function toggleProtection(ingress: any) {
		if (protectionExpandedId === ingress.id) {
			protectionExpandedId = null;
		} else {
			protectionExpandedId = ingress.id;
			protectionMode = ingress.protectionMode || 'none';
			protectionPassword = '';
			protectionBypassPaths = (ingress.protectionBypassPaths || []).join('\n');
		}
	}

	function saveProtection(ingressId: string) {
		onUpdateProtection?.(
			ingressId,
			protectionMode,
			protectionMode === 'password' ? protectionPassword : undefined,
			protectionBypassPaths
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
		);
	}

	async function copyBypassSecret(secret: string) {
		await navigator.clipboard.writeText(secret);
		copiedBypass = true;
		setTimeout(() => (copiedBypass = false), 2000);
	}
</script>

<div class="space-y-5">
	<SectionCard title="Domains">
		{#snippet actions()}
			{#if deployment.project?.id}
				<button type="button" class="btn btn-secondary btn-sm" onclick={openDomainForm}>
					{#if showDomainForm}
						<X size={16} />
						<span>Close</span>
					{:else}
						<Plus size={16} />
						<span>Add</span>
					{/if}
				</button>
			{/if}
		{/snippet}

		{#if showDomainForm}
			<div class="dom-form" transition:slide={{ duration: 200 }}>
				<SegmentedControl
					label="Domain type"
					value={domainMode}
					onchange={(next) => setDomainMode(next as 'orchard' | 'custom')}
					options={APP_DOMAIN
						? [
								{ value: 'orchard', label: `Free ${APP_DOMAIN} subdomain` },
								{ value: 'custom', label: 'Your own domain' }
							]
						: [{ value: 'custom', label: 'Your own domain' }]}
				/>

				{#if domainMode === 'orchard'}
					<div class="dom-generated">
						<div class="dom-field">
							<span class="dom-field-sizer">
								<span class="dom-field-ghost">{subdomainPrefix || 'my-app'}</span>
								<input
									type="text"
									class="dom-field-input"
									placeholder="my-app"
									aria-label="Subdomain"
									size="1"
									value={subdomainPrefix}
									oninput={(event) =>
										updateSubdomainPrefix((event.currentTarget as HTMLInputElement).value)}
								/>
							</span>
							<span class="dom-field-suffix">.{APP_DOMAIN}</span>
						</div>
						<Button variant="secondary" size="sm" onclick={onGenerateRandomDomain}>
							<RefreshCw size={14} class="h-3.5 w-3.5" />
							<span>New name</span>
						</Button>
					</div>
					<p class="dom-hint">HTTPS is set up for you. The domain works the moment you add it.</p>
				{:else}
					<input
						type="text"
						class="dom-input"
						placeholder="app.example.com"
						aria-label="Domain"
						bind:value={newDomainHost}
						oninput={() => (dnsCheckState = 'idle')}
					/>

					<div class="dns-panel">
						<p class="dns-panel-title">
							{INGRESS_CNAME
								? 'Add this record wherever you manage DNS'
								: 'Point this domain at your ingress, then add it here'}
						</p>
						{#if INGRESS_CNAME}
							<dl class="dns-record">
								<dt>Type</dt>
								<dd><code>CNAME</code></dd>
								<dt>Name</dt>
								<dd><code>{newDomainNormalizedHost ? dnsRecordName : '@'}</code></dd>
								<dt>Value</dt>
								<dd>
									<button
										type="button"
										class="dns-copy"
										onclick={copyCnameTarget}
										title="Copy to clipboard"
									>
										<code>{INGRESS_CNAME}</code>
										{#if copiedCname}
											<Check size={12} class="h-3 w-3 dns-copy-ok" />
										{:else}
											<Copy size={12} class="h-3 w-3 dns-copy-icon" />
										{/if}
									</button>
								</dd>
							</dl>
						{/if}
						{#if newDomainNormalizedHost && dnsRecordName === '@'}
							<p class="dns-note">
								Root domains need a DNS provider that supports CNAME flattening, like Cloudflare.
							</p>
						{/if}
						<div class="dns-check-row">
							<span
								class="dns-status"
								class:dns-status-ok={dnsCheckState === 'valid'}
								class:dns-status-pending={dnsCheckState === 'invalid'}
							>
								{#if dnsCheckState === 'valid'}
									<Check size={12} class="h-3 w-3" />
									DNS is set up correctly
								{:else if dnsCheckState === 'invalid'}
									Not detected yet. DNS changes can take a few minutes to spread.
								{:else}
									Add the domain now, it starts working once the record is live.
								{/if}
							</span>
							<Button
								variant="secondary"
								size="sm"
								onclick={checkDns}
								loading={dnsCheckState === 'checking'}
								disabled={dnsCheckState === 'checking' || !newDomainNormalizedHost}
							>
								Check DNS
							</Button>
						</div>
					</div>
				{/if}

				{#if domainServiceOptions.length > 1}
					<div class="dom-row">
						<span class="dom-row-label">Forward to</span>
						<Select bind:value={newDomainServiceKey} aria-label="Forward to">
							{#each domainServiceOptions as option (option.key)}
								<option value={option.key}>{option.label}</option>
							{/each}
						</Select>
					</div>
				{/if}

				<div class="dom-advanced">
					<button
						type="button"
						class="dom-advanced-trigger"
						aria-expanded={showDomainAdvanced}
						onclick={() => (showDomainAdvanced = !showDomainAdvanced)}
					>
						<span
							class="dom-advanced-chevron"
							{@attach springRotate(() => showDomainAdvanced, { rest: -90, on: 0 })}
						>
							<ChevronDown size={14} class="h-3.5 w-3.5" />
						</span>
						Advanced
					</button>

					{#if showDomainAdvanced}
						<div class="dom-advanced-body" transition:slide={{ duration: 150 }}>
							<div class="dom-row">
								<span class="dom-row-label">Path</span>
								<input
									type="text"
									class="dom-input dom-input--mono"
									placeholder="/"
									aria-label="Path"
									bind:value={newDomainPath}
								/>
								<p class="dom-hint">
									Route a specific path here, like <code>/api</code>. Leave it as <code>/</code> to catch
									everything.
								</p>
							</div>
							<label class="dm-toggle-row">
								<div class="dm-toggle-text">
									<span class="dm-toggle-label">Enable SSL</span>
									<span class="dm-toggle-hint"
										>Automatically provisions a Let's Encrypt certificate</span
									>
								</div>
								<input type="checkbox" class="dm-toggle-input" bind:checked={newDomainTlsEnabled} />
								<span class="dm-toggle-track"><span class="dm-toggle-thumb"></span></span>
							</label>
						</div>
					{/if}
				</div>

				{#if newDomainConflict}
					<div
						class="dom-callout"
						class:dom-callout--error={newDomainConflict.pathCollision}
						role={newDomainConflict.pathCollision ? 'alert' : undefined}
					>
						{#if newDomainConflict.pathCollision}
							<strong>Path in use.</strong>
							<code>{newDomainNormalizedHost}{newDomainNormalizedPath}</code> is already routed. Choose
							a different path under Advanced.
						{:else if newDomainConflict.otherDeployment}
							<strong>Sharing domain.</strong>
							{newDomainNormalizedHost} already routes to another app. Traffic to
							<code>{newDomainNormalizedPath}</code> will be added to the existing ingress.
						{:else}
							Adding <code>{newDomainNormalizedPath}</code> to the existing {newDomainNormalizedHost}
							ingress.
						{/if}
					</div>
				{/if}

				{#if domainServiceOptions.length === 0}
					<p class="dom-hint">Add a port above first so this domain has somewhere to route.</p>
				{/if}

				{#if domainFormError}
					<div class="dom-callout dom-callout--error" role="alert">{domainFormError}</div>
				{/if}

				<div class="dom-actions">
					<Button
						variant="secondary"
						size="sm"
						onclick={() => {
							showDomainForm = false;
							onResetDomainForm();
						}}
					>
						Cancel
					</Button>
					<Button
						variant="primary"
						size="sm"
						onclick={onCreateDomain}
						loading={creatingDomain}
						disabled={creatingDomain ||
							!newDomainNormalizedHost ||
							!newDomainServiceKey ||
							newDomainConflict?.pathCollision}
					>
						Add domain
					</Button>
				</div>
			</div>
		{/if}
		<div class="space-y-2">
			{#if deployment.ingresses?.length}
				{#each deployment.ingresses as ingress (ingress.id)}
					<div
						class="rounded-xl overflow-hidden"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
					>
						<div class="svc-port-row flex w-full items-center justify-between gap-3 p-3 text-left">
							<a
								href={ingressUrl(ingress)}
								target="_blank"
								rel="noopener noreferrer"
								class="flex-1 min-w-0 text-left no-underline transition hover:opacity-80"
							>
								{#if ingress.protectionMode && ingress.protectionMode !== 'none'}
									<p class="text-xs mb-1" style="color: var(--sidebar-text-active-border);">
										<Shield class="inline h-3 w-3 mr-1" />
										{ingress.protectionMode === 'password'
											? 'Password protected'
											: 'Orchard sign-in'}
									</p>
								{:else if ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd')}
									<p class="text-xs mb-1" style="color: var(--away-indicator);">
										<Lock class="inline h-3 w-3 mr-1" />
										Auth
									</p>
								{/if}
								<p class="text-sm font-medium truncate" style="color: var(--center-channel-color);">
									{ingressUrl(ingress)}
								</p>
								{#if ingress.address}
									<p class="text-xs mt-0.5 truncate" style="color: var(--surface-muted);">
										{ingress.address}
									</p>
								{/if}
							</a>
							<div class="flex items-center gap-1.5">
								{#if onUpdateProtection}
									<Button
										variant="ghost"
										size="sm"
										aria-label="Protection settings"
										title="Access protection"
										style={protectionExpandedId === ingress.id
											? 'color: var(--sidebar-text-active-border);'
											: undefined}
										onclick={(e: MouseEvent) => {
											e.stopPropagation();
											toggleProtection(ingress);
										}}
									>
										<Shield size={16} class="h-4 w-4" />
									</Button>
								{/if}
								<Button
									variant="ghost"
									size="sm"
									aria-label="Remove domain"
									title="Remove domain"
									disabled={deletingIngressId === ingress.id}
									onclick={(e: MouseEvent) => {
										e.stopPropagation();
										onDeleteIngress(ingress.id);
									}}
								>
									{#if deletingIngressId === ingress.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Trash2 size={16} class="h-4 w-4" />
									{/if}
								</Button>
							</div>
						</div>

						{#if protectionExpandedId === ingress.id}
							<div
								class="border-t px-3 pb-3 pt-2"
								style="border-color: var(--surface-border);"
								transition:slide={{ duration: 150 }}
							>
								<p class="text-xs font-medium mb-2" style="color: var(--center-channel-color);">
									App protection
								</p>
								<div class="flex flex-col gap-2">
									<label
										class="flex items-center gap-2 text-xs cursor-pointer"
										style="color: var(--center-channel-color);"
									>
										<input
											type="radio"
											name="protection-{ingress.id}"
											value="none"
											bind:group={protectionMode}
										/>
										None
									</label>
									<label
										class="flex items-center gap-2 text-xs cursor-pointer"
										style="color: var(--center-channel-color);"
									>
										<input
											type="radio"
											name="protection-{ingress.id}"
											value="password"
											bind:group={protectionMode}
										/>
										Password
									</label>
									<label
										class="flex items-center gap-2 text-xs cursor-pointer"
										style="color: var(--center-channel-color);"
									>
										<input
											type="radio"
											name="protection-{ingress.id}"
											value="orchard"
											bind:group={protectionMode}
										/>
										Sign in with Orchard
									</label>
								</div>

								{#if protectionMode === 'password'}
									<div class="mt-2">
										<input
											type="password"
											class="input text-sm w-full"
											placeholder="Enter password"
											bind:value={protectionPassword}
										/>
									</div>
								{/if}

								{#if protectionMode !== 'none'}
									<div class="mt-3">
										<p class="text-xs mb-1 text-muted">Public paths</p>
										<textarea
											class="w-full text-xs rounded px-2 py-1.5 bg-surface text-fg border border-edge font-mono"
											rows="3"
											placeholder={'/api\n/webhooks/stripe'}
											bind:value={protectionBypassPaths}></textarea>
										<p class="text-xs mt-1 text-muted">
											One per line. These paths and everything under them skip the login wall, so
											APIs and webhooks keep working. Matching is on whole segments, so
											<code>/api</code> covers <code>/api/v1</code> but not <code>/apikeys</code>.
										</p>
									</div>
								{/if}

								{#if ingress.protectionBypassSecret && protectionMode !== 'none'}
									<div class="mt-2">
										<p class="text-xs mb-1" style="color: var(--surface-muted);">Bypass secret</p>
										<div class="flex items-center gap-1.5">
											<code
												class="text-xs flex-1 truncate px-2 py-1 rounded"
												style="background: var(--surface-bg); color: var(--surface-muted);"
											>
												{ingress.protectionBypassSecret}
											</code>
											<Button
												variant="ghost"
												size="sm"
												aria-label="Copy bypass secret"
												onclick={() => copyBypassSecret(ingress.protectionBypassSecret)}
											>
												{#if copiedBypass}
													<Check
														size={14}
														class="h-3.5 w-3.5"
														style="color: var(--online-indicator);"
													/>
												{:else}
													<Copy size={14} class="h-3.5 w-3.5" />
												{/if}
											</Button>
										</div>
										<p class="text-xs mt-1" style="color: var(--surface-muted);">
											Send as <code>x-orchard-protection-bypass</code> header to skip auth.
										</p>
									</div>
								{/if}

								<button
									type="button"
									class="btn btn-sm btn-primary mt-2"
									disabled={protectionUpdatingId === ingress.id ||
										(protectionMode === 'password' && !protectionPassword.trim())}
									onclick={() => saveProtection(ingress.id)}
								>
									{#if protectionUpdatingId === ingress.id}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{/if}
									Save
								</button>
							</div>
						{/if}
					</div>
				{/each}
			{:else}
				<p class="text-sm text-center py-4" style="color: var(--surface-muted);">
					No domains configured
				</p>
			{/if}
		</div>
	</SectionCard>

	<SectionCard title="Ports">
		{#snippet actions()}
			<button
				type="button"
				class="btn btn-secondary btn-sm"
				onclick={() => {
					showServiceForm = !showServiceForm;
					isEditingServices = showServiceForm;
					if (!showServiceForm) {
						onResetNewServiceForm();
						if (Object.keys(serviceEditForms).length === 0) {
							isEditingServices = false;
						}
					}
				}}
			>
				{#if showServiceForm}
					<X size={16} />
					<span>Close</span>
				{:else}
					<Plus size={16} />
					<span>Add</span>
				{/if}
			</button>
		{/snippet}

		{#if showServiceForm}
			<div
				class="surface-form rounded-xl border border-dashed p-4 mb-4"
				transition:slide={{ duration: 200 }}
			>
				<div class="flex items-center gap-2">
					<div style="flex: 1; min-width: 80px; max-width: 120px;">
						<input
							type="number"
							min="1"
							class="input text-sm"
							placeholder="80"
							value={newServiceForm.ports[0].containerPort}
							oninput={(event) => {
								const val = Number((event.currentTarget as HTMLInputElement).value);
								onUpdateNewServicePort(0, { containerPort: val, servicePort: val });
							}}
						/>
					</div>
					<div class="svc-protocol-toggle">
						<button
							type="button"
							class="svc-proto-btn"
							class:svc-proto-active={newServiceForm.ports[0].protocol === 'TCP'}
							onclick={() => onUpdateNewServicePort(0, { protocol: 'TCP' })}>TCP</button
						>
						<button
							type="button"
							class="svc-proto-btn"
							class:svc-proto-active={newServiceForm.ports[0].protocol === 'UDP'}
							onclick={() => onUpdateNewServicePort(0, { protocol: 'UDP' })}>UDP</button
						>
					</div>
					<div class="flex-1"></div>
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => {
							showServiceForm = false;
							onResetNewServiceForm();
						}}>Cancel</button
					>
					<button
						type="button"
						class="btn btn-primary btn-sm"
						onclick={onCreateService}
						disabled={creatingService}
					>
						{#if creatingService}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						Add
					</button>
				</div>

				{#if serviceFormError}
					<div class="alert alert-error mt-2">{serviceFormError}</div>
				{/if}
			</div>
		{/if}

		<div class="space-y-2">
			{#if deployment.services?.length}
				{#each deployment.services as service (service.id)}
					{@const displayedPorts =
						service.ports && service.ports.length
							? service.ports
							: [
									{
										name: service.name,
										port: service.port,
										targetPort: service.targetPort,
										protocol: service.protocol,
										nodePort: service.nodePort ?? null
									}
								]}
					{#each displayedPorts as port, portIndex (port.id ?? `${port.targetPort}/${port.protocol ?? 'TCP'}`)}
						{@const internalUrl =
							port.internalUrl ??
							(service.internalHost
								? `${service.internalHost}:${port.port ?? port.targetPort}`
								: null)}
						<div
							class="svc-port-block svc-port-row rounded-xl"
							class:svc-port-editing={serviceEditForms[service.id]}
							style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
						>
							<div class="flex items-center gap-2 px-4 py-3">
								{#if serviceEditForms[service.id]}
									<div style="flex: 1; min-width: 80px; max-width: 120px;">
										<input
											type="number"
											min="1"
											class="input text-sm"
											placeholder="80"
											value={serviceEditForms[service.id].ports[portIndex]?.containerPort ??
												port.targetPort}
											oninput={(event) => {
												const val = Number((event.currentTarget as HTMLInputElement).value);
												onUpdateServiceEditPort(service.id, portIndex, {
													containerPort: val,
													servicePort: val
												});
											}}
										/>
									</div>
									<div class="svc-protocol-toggle">
										<button
											type="button"
											class="svc-proto-btn"
											class:svc-proto-active={(serviceEditForms[service.id].ports[portIndex]
												?.protocol ?? port.protocol) === 'TCP'}
											onclick={() =>
												onUpdateServiceEditPort(service.id, portIndex, { protocol: 'TCP' })}
											>TCP</button
										>
										<button
											type="button"
											class="svc-proto-btn"
											class:svc-proto-active={(serviceEditForms[service.id].ports[portIndex]
												?.protocol ?? port.protocol) === 'UDP'}
											onclick={() =>
												onUpdateServiceEditPort(service.id, portIndex, { protocol: 'UDP' })}
											>UDP</button
										>
									</div>
								{:else}
									<span
										class="text-sm font-mono font-medium"
										style="color: var(--center-channel-color);">{port.targetPort}</span
									>
									<span class="surface-pill rounded-full px-1.5 py-0.5 text-[10px]"
										>{port.protocol}</span
									>
									{#if port.publicEnabled && port.publicPort && PUBLIC_DEPLOYMENT_DOMAIN}
										{@const pubEndpoint = `${PUBLIC_DEPLOYMENT_DOMAIN}:${port.publicPort}`}
										<button
											type="button"
											class="svc-public-pill flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono"
											onclick={() => {
												navigator.clipboard.writeText(pubEndpoint);
												toasts.add({
													title: 'Copied public endpoint',
													description: pubEndpoint,
													color: 'success'
												});
											}}
											title="Click to copy public endpoint"
										>
											<Wifi size={12} class="h-3 w-3" />
											<span>{pubEndpoint}</span>
											<Copy size={12} class="h-3 w-3 opacity-60" />
										</button>
									{/if}
								{/if}
								<div class="flex-1"></div>
								{#if !serviceEditForms[service.id] && port.id}
									{#if port.publicEnabled}
										<button
											type="button"
											class="btn btn-ghost btn-sm"
											onclick={() => onTogglePortPublic(service.id, port.id, true)}
											disabled={portPublicBusyId === port.id}
											title="Stop exposing this port publicly"
										>
											{#if portPublicBusyId === port.id}
												<Loader2 class="h-3.5 w-3.5 animate-spin" />
											{:else}
												<Lock class="h-3.5 w-3.5" />
											{/if}
											<span class="ml-1 text-xs">Unexpose</span>
										</button>
									{:else}
										<button
											type="button"
											class="btn btn-secondary btn-sm"
											onclick={() => onTogglePortPublic(service.id, port.id, false)}
											disabled={portPublicBusyId === port.id}
											title={`Open a public ${port.protocol || 'TCP'} endpoint for non-HTTP traffic`}
										>
											{#if portPublicBusyId === port.id}
												<Loader2 class="h-3.5 w-3.5 animate-spin" />
											{:else}
												<Wifi size={14} class="h-3.5 w-3.5" />
											{/if}
											<span class="ml-1 text-xs">Expose {port.protocol || 'TCP'}</span>
										</button>
									{/if}
								{/if}
								{#if !serviceEditForms[service.id]}
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										title="Edit port"
										onclick={() => onToggleServiceEdit(service)}
									>
										<Settings size={14} class="h-3.5 w-3.5" />
									</button>
								{/if}
								<button
									type="button"
									class="btn btn-ghost btn-sm"
									style="color: var(--error-text-color);"
									onclick={() => onDeleteService(service.id)}
									disabled={serviceDeletingId === service.id}
								>
									{#if serviceDeletingId === service.id}<Loader2
											class="h-3.5 w-3.5 animate-spin"
										/>{:else}<Trash2 size={14} class="h-3.5 w-3.5" />{/if}
								</button>
							</div>
							{#if internalUrl && !serviceEditForms[service.id]}
								<button
									type="button"
									class="svc-internal-row"
									onclick={() =>
										onCopyInternalUrl(internalUrl, `${service.id}:${port.id ?? portIndex}`)}
									title="Copy internal address"
								>
									<Network size={12} class="h-3 w-3 shrink-0 opacity-60" />
									<span class="svc-internal-url">{internalUrl}</span>
									{#if copiedUrlId === `${service.id}:${port.id ?? portIndex}`}
										<Check size={12} class="h-3 w-3 shrink-0" />
									{:else}
										<Copy size={12} class="h-3 w-3 shrink-0 opacity-50" />
									{/if}
								</button>
							{/if}
						</div>
					{/each}
					{#if serviceEditForms[service.id]}
						<div class="flex justify-end gap-2 pb-1" transition:slide={{ duration: 150 }}>
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								onclick={() => onToggleServiceEdit(service)}>Cancel</button
							>
							<button
								type="button"
								class="btn btn-primary btn-sm"
								onclick={() => onSaveServicePorts(service.id)}
								disabled={serviceSavingId === service.id}
							>
								{#if serviceSavingId === service.id}<Loader2
										class="h-3.5 w-3.5 animate-spin"
									/>{/if}
								Save
							</button>
						</div>
						{#if serviceEditErrors[service.id]}
							<div class="alert alert-error">{serviceEditErrors[service.id]}</div>
						{/if}
					{/if}
				{/each}
				<p class="text-xs pt-1" style="color: var(--surface-muted);">
					Exposing a port opens raw TCP/UDP access for things like game servers and bots. Hosting a
					website? Add a domain below instead.
				</p>
			{:else}
				<p class="text-sm text-center py-4" style="color: var(--surface-muted);">
					No ports configured
				</p>
			{/if}
		</div>
	</SectionCard>

	<!-- Tailscale (gated behind early access flag) -->
	{#if tailscaleFeatureEnabled}
		<SectionCard title="Tailscale">
			{#if deployment?.tailscaleExposed}
				<div
					class="rounded-xl"
					style="background-color: var(--control-bg); border: 1px solid var(--surface-border); overflow: hidden;"
				>
					<div class="flex items-center justify-between gap-3 px-4 py-3">
						<div class="flex items-center gap-3">
							<Wifi size={16} class="h-4 w-4 flex-shrink-0" style="color: var(--button-bg);" />
							<div>
								{#if tailscaleDns}
									<p class="text-sm font-medium" style="color: var(--center-channel-color);">
										{tailscaleDns}
									</p>
								{:else}
									<p class="text-sm font-medium" style="color: var(--center-channel-color);">
										{deployment.tailscaleHostname}
									</p>
								{/if}
								{#if tailscaleIp}
									<p class="text-xs" style="color: var(--surface-muted);">{tailscaleIp}</p>
								{:else}
									<p class="text-xs flex items-center gap-1" style="color: var(--surface-muted);">
										<Loader2 class="h-3 w-3 animate-spin" />
										Connecting to Tailscale...
									</p>
								{/if}
							</div>
						</div>
						<button
							onclick={onUnexposeTailscale}
							disabled={tailscaleUnexposing}
							class="btn btn-secondary btn-sm"
						>
							{#if tailscaleUnexposing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<X
									size={14}
								/>{/if}
							<span>Remove</span>
						</button>
					</div>
					{#if (tailscaleDns || tailscaleIp) && deployment.services?.length}
						<div style="border-top: 1px solid var(--surface-border);">
							{#each deployment.services as service (service.id)}
								{@const tsHost = tailscaleDns || tailscaleIp}
								{@const displayedPorts = service.ports?.length
									? service.ports
									: [
											{
												port: service.port,
												targetPort: service.targetPort,
												protocol: service.protocol
											}
										]}
								{#each displayedPorts as port (`${port.targetPort}/${port.protocol ?? 'TCP'}`)}
									{@const addr = `${tsHost}:${port.targetPort}`}
									<div
										class="flex items-center justify-between gap-2 px-4 py-2"
										style="border-bottom: 1px solid var(--surface-border);"
									>
										<div class="flex items-center gap-2 min-w-0">
											<span
												class="text-xs font-mono truncate"
												style="color: var(--center-channel-color);">{addr}</span
											>
											<span
												class="text-xs px-1.5 py-0.5 rounded"
												style="background-color: var(--surface-border); color: var(--surface-muted);"
												>{port.protocol || 'TCP'}</span
											>
										</div>
										<button
											class="btn btn-ghost btn-sm"
											onclick={() => {
												navigator.clipboard.writeText(addr);
												toasts.add({ title: 'Copied', description: addr, color: 'success' });
											}}
										>
											<Copy size={14} class="h-3.5 w-3.5" />
										</button>
									</div>
								{/each}
							{/each}
						</div>
					{/if}
				</div>
			{:else if tailscaleLinked}
				<button
					onclick={onExposeTailscale}
					disabled={tailscaleExposing}
					class="btn btn-secondary btn-sm"
				>
					{#if tailscaleExposing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Wifi
							size={14}
							class="h-3.5 w-3.5"
						/>{/if}
					<span>Expose to Tailscale</span>
				</button>
			{:else}
				<p class="text-xs" style="color: var(--surface-muted);">
					Connect your Tailscale account in <a href="/user/settings" class="underline"
						>user settings</a
					> to expose apps to your private network.
				</p>
			{/if}
		</SectionCard>
	{/if}
</div>
