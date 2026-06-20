<script lang="ts">
	import { Loader2, Lock, Shield, Check } from 'lucide-svelte';
	import { ChevronDown, Copy, Plus, RefreshCw, Settings, Trash2, Wifi, X } from '@jis3r/icons';
	import { slide } from 'svelte/transition';
	import { env } from '$env/dynamic/public';
	import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN || 'a.lfdl.ink';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME || 'ingress.lfdl.ink';
	const PUBLIC_DEPLOYMENT_DOMAIN = env.PUBLIC_DEPLOYMENT_DOMAIN || 'public.orchard.my';

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
		onUpdateProtection?: (ingressId: string, mode: string, password?: string) => void;
		protectionUpdatingId?: string | null;
		toasts: any;
	} = $props();

	let protectionExpandedId = $state<string | null>(null);
	let protectionMode = $state<string>('none');
	let protectionPassword = $state('');
	let copiedBypass = $state(false);

	function toggleProtection(ingress: any) {
		if (protectionExpandedId === ingress.id) {
			protectionExpandedId = null;
		} else {
			protectionExpandedId = ingress.id;
			protectionMode = ingress.protectionMode || 'none';
			protectionPassword = '';
		}
	}

	function saveProtection(ingressId: string) {
		onUpdateProtection?.(
			ingressId,
			protectionMode,
			protectionMode === 'password' ? protectionPassword : undefined
		);
	}

	async function copyBypassSecret(secret: string) {
		await navigator.clipboard.writeText(secret);
		copiedBypass = true;
		setTimeout(() => (copiedBypass = false), 2000);
	}
</script>

<div class="space-y-5">
	<!-- Tailscale (gated behind early access flag) -->
	{#if tailscaleFeatureEnabled}
		<div class="card rounded-2xl p-5">
			<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
				<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Tailscale</p>
			</div>
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
							{#each deployment.services as service}
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
								{#each displayedPorts as port}
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
					> to expose deployments to your private network.
				</p>
			{/if}
		</div>
	{/if}

	<!-- Ports -->
	<div class="card rounded-2xl p-5">
		<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Ports</p>
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
		</div>

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
				{#each deployment.services as service}
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
					{#each displayedPorts as port, portIndex}
						<div
							class="svc-port-row flex items-center gap-2 rounded-xl px-4 py-3"
							class:svc-port-editing={serviceEditForms[service.id]}
							style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
						>
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
								{#if port.publicEnabled && port.publicPort}
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
										title="Expose this port to the public internet"
									>
										{#if portPublicBusyId === port.id}
											<Loader2 class="h-3.5 w-3.5 animate-spin" />
										{:else}
											<Wifi size={14} class="h-3.5 w-3.5" />
										{/if}
										<span class="ml-1 text-xs">Expose publicly</span>
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
								class="btn btn-ghost btn-sm text-red-500"
								onclick={() => onDeleteService(service.id)}
								disabled={serviceDeletingId === service.id}
							>
								{#if serviceDeletingId === service.id}<Loader2
										class="h-3.5 w-3.5 animate-spin"
									/>{:else}<Trash2 size={14} class="h-3.5 w-3.5" />{/if}
							</button>
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
			{:else}
				<p class="text-sm text-center py-4" style="color: var(--surface-muted);">
					No ports configured
				</p>
			{/if}
		</div>
	</div>

	<!-- Domains -->
	<div class="card rounded-2xl p-5">
		<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Domains</p>
			{#if deployment.project?.id}
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					onclick={() => {
						showDomainForm = !showDomainForm;
						if (!showDomainForm) onResetDomainForm();
					}}
				>
					{#if showDomainForm}
						<X size={16} />
						<span>Close</span>
					{:else}
						<Plus size={16} />
						<span>Add</span>
					{/if}
				</button>
			{/if}
		</div>

		{#if showDomainForm}
			<div
				class="surface-form rounded-xl border border-dashed p-4 mb-4"
				transition:slide={{ duration: 200 }}
			>
				<div class="flex flex-wrap gap-2 items-end">
					<div class="flex-[2] min-w-[160px]">
						<p class="text-xs mb-1" style="color: var(--surface-muted);">Domain</p>
						<input
							type="text"
							class="input text-sm"
							placeholder="example.com"
							bind:value={newDomainHost}
						/>
					</div>
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={onGenerateRandomDomain}
						title={`Generate a free *.${APP_DOMAIN} domain`}
					>
						<RefreshCw size={14} class="h-3.5 w-3.5" />
						Auto
					</button>
				</div>
				<p class="text-xs mt-1" style="color: var(--surface-muted);">
					For custom domains, point a CNAME record to <code>{INGRESS_CNAME}</code>.
				</p>

				{#if domainServiceOptions.length > 1}
					<div class="mt-3">
						<p class="text-xs mb-1" style="color: var(--surface-muted);">Forward to</p>
						<select class="input text-sm" bind:value={newDomainServiceKey}>
							{#each domainServiceOptions as option}
								<option value={option.key}>{option.label}</option>
							{/each}
						</select>
					</div>
				{/if}

				<label class="dm-toggle-row">
					<div class="dm-toggle-text">
						<span class="dm-toggle-label">Enable SSL</span>
						<span class="dm-toggle-hint">Automatically provisions a Let's Encrypt certificate</span>
					</div>
					<input type="checkbox" class="dm-toggle-input" bind:checked={newDomainTlsEnabled} />
					<span class="dm-toggle-track"><span class="dm-toggle-thumb"></span></span>
				</label>

				<button
					type="button"
					class="mt-3 text-xs font-medium inline-flex items-center gap-1"
					style="color: var(--surface-muted); background: none; border: none; cursor: pointer; padding: 0;"
					onclick={() => (showDomainAdvanced = !showDomainAdvanced)}
				>
					<ChevronDown
						size={12}
						class="h-3 w-3"
						style={showDomainAdvanced ? '' : 'transform: rotate(-90deg);'}
					/>
					Advanced
				</button>

				{#if showDomainAdvanced}
					<div class="mt-2" transition:slide={{ duration: 150 }}>
						<p class="text-xs mb-1" style="color: var(--surface-muted);">Path</p>
						<input
							type="text"
							class="input text-sm font-mono"
							placeholder="/"
							bind:value={newDomainPath}
						/>
						<p class="text-xs mt-1" style="color: var(--surface-muted);">
							Route a specific path here (e.g. <code>/api</code>). Leave as <code>/</code> to catch all
							traffic.
						</p>
					</div>
				{/if}

				{#if newDomainConflict}
					<div
						class="mt-3 p-2 rounded-lg text-xs border"
						style="background-color: color-mix(in srgb, {newDomainConflict.pathCollision
							? 'var(--error-text-color)'
							: 'var(--sidebar-text-active-border)'} 10%, transparent); border-color: color-mix(in srgb, {newDomainConflict.pathCollision
							? 'var(--error-text-color)'
							: 'var(--sidebar-text-active-border)'} 25%, transparent); color: var(--center-channel-color);"
					>
						{#if newDomainConflict.pathCollision}
							<strong>Path in use.</strong>
							<code>{newDomainNormalizedHost}{newDomainNormalizedPath}</code> is already routed. Choose
							a different path below.
						{:else if newDomainConflict.otherDeployment}
							<strong>Sharing domain.</strong>
							{newDomainNormalizedHost} already routes to another deployment. Traffic to
							<code>{newDomainNormalizedPath}</code> will be added to the existing ingress.
						{:else}
							Adding <code>{newDomainNormalizedPath}</code> to the existing {newDomainNormalizedHost}
							ingress.
						{/if}
					</div>
				{/if}

				{#if domainFormError}
					<div class="alert alert-error mt-3">{domainFormError}</div>
				{/if}

				<div class="mt-3 flex justify-end gap-2">
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => {
							showDomainForm = false;
							onResetDomainForm();
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						class="btn btn-primary btn-sm"
						onclick={onCreateDomain}
						disabled={creatingDomain ||
							!newDomainNormalizedHost ||
							!newDomainServiceKey ||
							newDomainConflict?.pathCollision}
					>
						{#if creatingDomain}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						Create
					</button>
				</div>
			</div>
		{/if}
		<div class="space-y-2">
			{#if deployment.ingresses?.length}
				{#each deployment.ingresses as ingress}
					<div
						class="rounded-xl overflow-hidden"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
					>
						<div class="svc-port-row flex w-full items-center justify-between gap-3 p-3 text-left">
							<a
								href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
								target="_blank"
								rel="noopener noreferrer"
								class="flex-1 min-w-0 text-left no-underline transition hover:opacity-80"
							>
								{#if ingress.protectionMode && ingress.protectionMode !== 'none'}
									<p class="text-xs text-indigo-400 mb-1">
										<Shield class="inline h-3 w-3 mr-1" />
										{ingress.protectionMode === 'password'
											? 'Password protected'
											: 'Orchard sign-in'}
									</p>
								{:else if ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd')}
									<p class="text-xs text-amber-500 mb-1">
										<Lock class="inline h-3 w-3 mr-1" />
										Auth
									</p>
								{/if}
								<p class="text-sm font-medium" style="color: var(--center-channel-color);">
									{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}
								</p>
								{#if ingress.address}
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
										{ingress.address}
									</p>
								{/if}
							</a>
							<div class="flex items-center gap-1.5">
								{#if onUpdateProtection}
									<button
										type="button"
										onclick={(e) => {
											e.stopPropagation();
											toggleProtection(ingress);
										}}
										class="btn btn-sm"
										style="background-color: transparent; border: 1px solid var(--surface-border); color: {protectionExpandedId ===
										ingress.id
											? 'var(--sidebar-text-active-border)'
											: 'var(--surface-muted)'};"
										aria-label="Protection settings"
									>
										<Shield size={16} class="h-4 w-4" />
									</button>
								{/if}
								<button
									type="button"
									onclick={(e) => {
										e.stopPropagation();
										onDeleteIngress(ingress.id);
									}}
									disabled={deletingIngressId === ingress.id}
									class="btn btn-sm"
									style="background-color: transparent; border: 1px solid var(--surface-border); color: var(--surface-muted);"
									aria-label="Remove domain"
								>
									{#if deletingIngressId === ingress.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Trash2 size={16} class="h-4 w-4" />
									{/if}
								</button>
							</div>
						</div>

						{#if protectionExpandedId === ingress.id}
							<div
								class="border-t px-3 pb-3 pt-2"
								style="border-color: var(--surface-border);"
								transition:slide={{ duration: 150 }}
							>
								<p class="text-xs font-medium mb-2" style="color: var(--center-channel-color);">
									Deployment Protection
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
											<button
												type="button"
												class="btn btn-sm"
												style="background-color: transparent; border: 1px solid var(--surface-border); color: var(--surface-muted);"
												onclick={() => copyBypassSecret(ingress.protectionBypassSecret)}
											>
												{#if copiedBypass}
													<Check size={14} class="h-3.5 w-3.5 text-green-400" />
												{:else}
													<Copy size={14} class="h-3.5 w-3.5" />
												{/if}
											</button>
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
	</div>
</div>
