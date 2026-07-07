<script lang="ts">
	import { Loader2, ExternalLink, TriangleAlert } from 'lucide-svelte';
	import {
		Check,
		ChevronDown,
		ServerCog,
		Settings,
		SlidersHorizontal,
		Terminal,
		Wifi
	} from '@jis3r/icons';
	import { isSuperAdmin } from '$lib/stores';
	import { SectionCard, StatusPill } from '$lib/components/ui';
	import type { AutoDeployStatus, GitHubDeploymentRecord } from '$lib/types/deployment';

	let {
		deployment,
		// Strategy
		strategyValue = $bindable(),
		savingStrategy,
		hasPvcVolume,
		onSaveStrategy,
		// Build options
		buildFromRoot = $bindable(),
		buildWithDepot = $bindable(),
		persistentBuildCache = $bindable(),
		buildOptionsDirty = $bindable(false),
		savingAdvanced,
		onSaveAdvanced,
		// Auto-deploy
		autoDeployStatus,
		autoDeployLoading,
		autoDeployBranch = $bindable(),
		enablingAutoDeploy,
		disablingAutoDeploy,
		githubDeployments,
		githubAppInstallUrl,
		loadingAppInstallUrl,
		onEnableAutoDeploy,
		onDisableAutoDeploy,
		onOpenGitHubAppInstall,
		// Health checks
		healthCheckEnabled = $bindable(),
		healthCheckType = $bindable(),
		healthCheckPath = $bindable(),
		healthCheckPort = $bindable(),
		healthCheckCommand = $bindable(),
		livenessEnabled = $bindable(),
		readinessEnabled = $bindable(),
		startupEnabled = $bindable(),
		healthCheckInterval = $bindable(),
		healthCheckTimeout = $bindable(),
		healthCheckRetries = $bindable(),
		startupFailureThreshold = $bindable(),
		savingHealthCheck,
		isEditingHealthCheck = $bindable(),
		onSaveHealthCheck
	}: {
		deployment: any;
		strategyValue: 'rollingUpdate' | 'recreate';
		savingStrategy: boolean;
		hasPvcVolume: boolean;
		onSaveStrategy: (next: 'rollingUpdate' | 'recreate') => void;
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		buildOptionsDirty?: boolean;
		savingAdvanced: boolean;
		onSaveAdvanced: () => void;
		autoDeployStatus: AutoDeployStatus | null;
		autoDeployLoading: boolean;
		autoDeployBranch: string;
		enablingAutoDeploy: boolean;
		disablingAutoDeploy: boolean;
		githubDeployments: GitHubDeploymentRecord[];
		githubAppInstallUrl: string | null;
		loadingAppInstallUrl: boolean;
		onEnableAutoDeploy: () => void;
		onDisableAutoDeploy: () => void;
		onOpenGitHubAppInstall: () => void;
		healthCheckEnabled: boolean;
		healthCheckType: string;
		healthCheckPath: string;
		healthCheckPort: number;
		healthCheckCommand: string;
		livenessEnabled: boolean;
		readinessEnabled: boolean;
		startupEnabled: boolean;
		healthCheckInterval: number;
		healthCheckTimeout: number;
		healthCheckRetries: number;
		startupFailureThreshold: number;
		savingHealthCheck: boolean;
		isEditingHealthCheck: boolean;
		onSaveHealthCheck: () => void;
	} = $props();
</script>

<div class="space-y-5">
	<SectionCard title="Update strategy">
		<div class="strategy-grid">
			<button
				type="button"
				class="strategy-card"
				class:strategy-card--active={strategyValue === 'rollingUpdate'}
				disabled={savingStrategy || hasPvcVolume}
				onclick={() => onSaveStrategy('rollingUpdate')}
			>
				<div class="flex items-center justify-between gap-2">
					<span class="strategy-card-title">Rolling update</span>
					{#if strategyValue === 'rollingUpdate'}
						<Check size={14} class="text-primary-500" />
					{/if}
				</div>
				<p class="strategy-card-desc">
					Bring up new pods, then drain the old ones, with zero downtime.
				</p>
			</button>
			<button
				type="button"
				class="strategy-card"
				class:strategy-card--active={strategyValue === 'recreate'}
				disabled={savingStrategy}
				onclick={() => onSaveStrategy('recreate')}
			>
				<div class="flex items-center justify-between gap-2">
					<span class="strategy-card-title">Recreate</span>
					{#if strategyValue === 'recreate'}
						<Check size={14} class="text-primary-500" />
					{/if}
				</div>
				<p class="strategy-card-desc">
					Tear down all pods first, then start the new ones. Expect brief downtime.
				</p>
			</button>
		</div>
		{#if hasPvcVolume}
			<div class="strategy-note mt-3">
				<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
				<span
					>This app has a PVC volume, so rolling updates are unavailable. Pods can't share a
					ReadWriteOnce volume during a rolling cutover.</span
				>
			</div>
		{/if}
	</SectionCard>

	<SectionCard title="Build">
		{#snippet actions()}
			{#if deployment.githubRepo}
				<button
					onclick={onSaveAdvanced}
					disabled={savingAdvanced || !buildOptionsDirty}
					class="btn btn-primary btn-sm"
				>
					{#if savingAdvanced}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>Save</span>
				</button>
			{/if}
		{/snippet}
		{#if deployment.githubRepo}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="adv-toggle-row"
				onclick={() => {
					buildFromRoot = !buildFromRoot;
					buildOptionsDirty = true;
				}}
			>
				<div class="adv-toggle-info">
					<span class="adv-toggle-label">Build from repository root</span>
					<span class="adv-toggle-desc"
						>Use the repo root as Docker build context instead of the Dockerfile directory</span
					>
				</div>
				<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
					<input
						type="checkbox"
						bind:checked={buildFromRoot}
						onchange={() => (buildOptionsDirty = true)}
					/>
					<span class="adv-switch-track"></span>
				</label>
			</div>
			{#if $isSuperAdmin}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="adv-toggle-row"
					onclick={() => {
						persistentBuildCache = !persistentBuildCache;
						buildOptionsDirty = true;
					}}
				>
					<div class="adv-toggle-info">
						<span class="adv-toggle-label">Persistent build cache</span>
						<span class="adv-toggle-desc"
							>Keep a warm build daemon between deploys so unchanged layers rebuild instantly</span
						>
					</div>
					<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
						<input
							type="checkbox"
							bind:checked={persistentBuildCache}
							onchange={() => (buildOptionsDirty = true)}
						/>
						<span class="adv-switch-track"></span>
					</label>
				</div>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="adv-toggle-row"
					onclick={() => {
						buildWithDepot = !buildWithDepot;
						buildOptionsDirty = true;
					}}
				>
					<div class="adv-toggle-info">
						<span class="adv-toggle-label">Orchard's super builds</span>
						<span class="adv-toggle-desc"
							>Use Orchard's high-performance hosted builders for faster builds</span
						>
					</div>
					<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
						<input
							type="checkbox"
							bind:checked={buildWithDepot}
							onchange={() => (buildOptionsDirty = true)}
						/>
						<span class="adv-switch-track"></span>
					</label>
				</div>
			{/if}
		{:else}
			<p class="text-xs" style="color: var(--surface-muted);">
				Build settings are only available for apps deployed from GitHub.
			</p>
		{/if}
	</SectionCard>

	<SectionCard title="Auto-deploy">
		{#snippet actions()}
			{#if deployment.githubRepo && autoDeployStatus?.enabled}
				<StatusPill tone="online" label="Active" />
				<button
					onclick={onDisableAutoDeploy}
					disabled={disablingAutoDeploy}
					class="btn btn-ghost btn-sm"
					style="color: var(--error-text-color);"
				>
					{#if disablingAutoDeploy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>Disable</span>
				</button>
			{/if}
		{/snippet}
		{#if deployment.githubRepo}
			{#if autoDeployLoading}
				<div class="flex items-center justify-center py-4">
					<Loader2 class="h-4 w-4 animate-spin" style="color: var(--surface-muted);" />
				</div>
			{:else if autoDeployStatus?.enabled}
				<p class="text-sm" style="color: var(--surface-muted);">
					Pushes to <code
						class="font-mono rounded px-1.5 py-0.5 text-xs"
						style="background-color: var(--control-bg); color: var(--center-channel-color);"
						>{autoDeployStatus.branch}</code
					> trigger a new deployment automatically.
				</p>
				{#if !autoDeployStatus?.appInstalled}
					<div
						class="mt-3 flex items-center justify-between gap-3 rounded-xl p-4"
						style="background-color: var(--control-bg); border: 1px dashed var(--error-text-color);"
					>
						<div>
							<p class="text-sm font-medium" style="color: var(--error-text-color);">
								GitHub App can't access this repository
							</p>
							<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
								Auto-deploy is enabled, but the App isn't installed on this repo or "Only select
								repositories" doesn't include it. Pushes won't trigger deployments until access is
								granted.
							</p>
						</div>
						<button
							onclick={onOpenGitHubAppInstall}
							disabled={!githubAppInstallUrl || loadingAppInstallUrl}
							class="btn btn-primary btn-sm shrink-0"
						>
							{#if loadingAppInstallUrl}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							<ExternalLink class="h-3.5 w-3.5" />
							<span>Configure</span>
						</button>
					</div>
				{/if}
			{:else if !autoDeployStatus?.appInstalled}
				<div
					class="flex items-center justify-between gap-3 rounded-xl p-4"
					style="background-color: var(--control-bg); border: 1px dashed var(--surface-border);"
				>
					<div>
						<p class="text-sm font-medium" style="color: var(--center-channel-color);">
							GitHub App required
						</p>
						<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
							Install it on your repository to enable automatic deployments.
						</p>
					</div>
					<button
						onclick={onOpenGitHubAppInstall}
						disabled={!githubAppInstallUrl || loadingAppInstallUrl}
						class="btn btn-primary btn-sm shrink-0"
					>
						{#if loadingAppInstallUrl}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						<ExternalLink class="h-3.5 w-3.5" />
						<span>Install</span>
					</button>
				</div>
			{:else}
				<div class="flex gap-2 items-end">
					<div class="flex-1">
						<p class="text-xs mb-1.5 font-medium" style="color: var(--surface-muted);">
							Deploy on push to branch
						</p>
						<input
							type="text"
							bind:value={autoDeployBranch}
							placeholder={deployment.githubBranch || 'main'}
							class="input text-sm font-mono"
						/>
					</div>
					<button
						onclick={onEnableAutoDeploy}
						disabled={enablingAutoDeploy || !autoDeployBranch}
						class="btn btn-primary btn-sm"
					>
						{#if enablingAutoDeploy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						<span>Enable</span>
					</button>
				</div>
			{/if}

			{#if githubDeployments.length > 0}
				<details class="mt-4 group">
					<summary class="cursor-pointer text-xs font-medium" style="color: var(--surface-muted);">
						Recent deployments ({githubDeployments.length})
					</summary>
					<div class="mt-2 space-y-1">
						{#each githubDeployments.slice(0, 5) as ghDeployment (ghDeployment.id)}
							<div
								class="flex items-center justify-between rounded-lg px-2.5 py-1.5"
								style="background-color: var(--control-bg);"
							>
								<div class="flex items-center gap-2">
									{#if ghDeployment.status === 'success'}
										<div
											class="h-1.5 w-1.5 rounded-full"
											style="background-color: var(--online-indicator);"
										></div>
									{:else if ghDeployment.status === 'failure' || ghDeployment.status === 'error'}
										<div
											class="h-1.5 w-1.5 rounded-full"
											style="background-color: var(--error-text-color);"
										></div>
									{:else if ghDeployment.status === 'in_progress'}
										<div
											class="h-1.5 w-1.5 rounded-full animate-pulse"
											style="background-color: var(--away-indicator);"
										></div>
									{:else}
										<div
											class="h-1.5 w-1.5 rounded-full"
											style="background-color: var(--surface-muted);"
										></div>
									{/if}
									<code class="text-[11px] font-mono">{ghDeployment.commitSha.substring(0, 7)}</code
									>
									<span class="text-[11px]" style="color: var(--surface-muted);"
										>{ghDeployment.ref}</span
									>
								</div>
								<div
									class="flex items-center gap-1.5 text-[11px]"
									style="color: var(--surface-muted);"
								>
									<span>{new Date(ghDeployment.createdAt).toLocaleDateString()}</span>
									{#if ghDeployment.logUrl}
										<a
											href={ghDeployment.logUrl}
											class="hover:underline"
											style="color: var(--link-color);"
											target="_blank"><ExternalLink class="h-2.5 w-2.5" /></a
										>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</details>
			{/if}
		{:else}
			<p class="text-xs" style="color: var(--surface-muted);">
				Only available for apps deployed from GitHub.
			</p>
		{/if}
	</SectionCard>

	<SectionCard title="Health checks" class="overflow-hidden">
		{#snippet actions()}
			<button
				onclick={onSaveHealthCheck}
				disabled={savingHealthCheck}
				class="btn btn-primary btn-sm"
			>
				{#if savingHealthCheck}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
				<span>Save</span>
			</button>
		{/snippet}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			onchange={() => (isEditingHealthCheck = true)}
			oninput={() => (isEditingHealthCheck = true)}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="hc-toggle-card"
				class:hc-toggle-card--on={healthCheckEnabled}
				onclick={() => {
					healthCheckEnabled = !healthCheckEnabled;
					isEditingHealthCheck = true;
				}}
			>
				<div class="hc-toggle-icon-wrap" class:hc-toggle-icon-wrap--on={healthCheckEnabled}>
					{#if healthCheckEnabled}
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg
						>
					{:else}
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M22 12h-20" /></svg
						>
					{/if}
				</div>
				<div class="hc-toggle-text">
					<span class="hc-toggle-title"
						>{healthCheckEnabled ? 'Health checks are on' : 'Health checks are off'}</span
					>
					<span class="hc-toggle-subtitle">
						{#if healthCheckEnabled}
							Your app will be automatically restarted if it stops responding
						{:else}
							Turn on to automatically detect and recover from crashes
						{/if}
					</span>
				</div>
				<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
					<input
						type="checkbox"
						bind:checked={healthCheckEnabled}
						onchange={() => (isEditingHealthCheck = true)}
					/>
					<span class="adv-switch-track"></span>
				</label>
			</div>

			{#if healthCheckEnabled}
				<div class="adv-divider -mx-5 mt-5"></div>

				<div class="pt-5 space-y-5">
					<!-- How to check -->
					<div>
						<p class="text-xs font-semibold mb-1" style="color: var(--center-channel-color);">
							How should we check your app?
						</p>
						<p class="text-xs mb-3" style="color: var(--surface-muted);">
							Pick the method that matches your app setup.
						</p>
						<div class="hc-method-grid">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-method-card"
								class:hc-method-card--active={healthCheckType === 'http'}
								onclick={() => {
									healthCheckType = 'http';
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-method-top">
									<span class="hc-method-icon"><Wifi size={20} class="h-5 w-5" /></span>
									<span class="hc-method-badge">Recommended</span>
								</div>
								<span class="hc-method-label">Web endpoint</span>
								<span class="hc-method-desc">Ping a URL path on your app</span>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-method-card"
								class:hc-method-card--active={healthCheckType === 'tcp'}
								onclick={() => {
									healthCheckType = 'tcp';
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-method-top">
									<span class="hc-method-icon"><ServerCog size={20} class="h-5 w-5" /></span>
								</div>
								<span class="hc-method-label">Port check</span>
								<span class="hc-method-desc">Check if a port is accepting connections</span>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-method-card"
								class:hc-method-card--active={healthCheckType === 'exec'}
								onclick={() => {
									healthCheckType = 'exec';
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-method-top">
									<span class="hc-method-icon"><Terminal size={20} class="h-5 w-5" /></span>
								</div>
								<span class="hc-method-label">Custom command</span>
								<span class="hc-method-desc">Run a command inside your container</span>
							</div>
						</div>
					</div>

					<!-- Endpoint config based on type -->
					<div class="hc-config-section">
						{#if healthCheckType === 'http'}
							<div class="hc-config-row">
								<div class="flex-[3] min-w-[140px]">
									<label class="hc-field-label" for="hc-path">URL path to check</label>
									<div class="hc-input-with-hint">
										<input
											id="hc-path"
											type="text"
											bind:value={healthCheckPath}
											placeholder="/health"
											class="input text-sm font-mono"
										/>
										<span class="hc-input-hint"
											>We'll send a GET request here to see if your app is alive</span
										>
									</div>
								</div>
								<div class="w-24">
									<label class="hc-field-label" for="hc-port">Port</label>
									<input
										id="hc-port"
										type="number"
										bind:value={healthCheckPort}
										placeholder="80"
										class="input text-sm font-mono"
									/>
								</div>
							</div>
						{:else if healthCheckType === 'tcp'}
							<div class="hc-config-row">
								<div class="w-28">
									<label class="hc-field-label" for="hc-tcp-port">Port to check</label>
									<div class="hc-input-with-hint">
										<input
											id="hc-tcp-port"
											type="number"
											bind:value={healthCheckPort}
											placeholder="80"
											class="input text-sm font-mono"
										/>
										<span class="hc-input-hint">We'll try to open a connection to this port</span>
									</div>
								</div>
							</div>
						{:else}
							<div class="hc-config-row">
								<div class="flex-1 min-w-[200px]">
									<label class="hc-field-label" for="hc-cmd">Command to run</label>
									<div class="hc-input-with-hint">
										<input
											id="hc-cmd"
											type="text"
											bind:value={healthCheckCommand}
											placeholder="cat /tmp/healthy"
											class="input text-sm font-mono"
										/>
										<span class="hc-input-hint">Should exit with code 0 when healthy</span>
									</div>
								</div>
							</div>
						{/if}
					</div>

					<!-- What should happen -->
					<div>
						<p class="text-xs font-semibold mb-1" style="color: var(--center-channel-color);">
							What should happen when the check fails?
						</p>
						<p class="text-xs mb-3" style="color: var(--surface-muted);">
							Choose the recovery behaviors you want.
						</p>
						<div class="hc-behavior-list">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-behavior-item"
								class:hc-behavior-item--active={livenessEnabled}
								onclick={() => {
									livenessEnabled = !livenessEnabled;
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-behavior-check" class:hc-behavior-check--on={livenessEnabled}>
									{#if livenessEnabled}
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="3"
											stroke-linecap="round"
											stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
										>
									{/if}
								</div>
								<div class="hc-behavior-text">
									<span class="hc-behavior-title">Restart if unhealthy</span>
									<span class="hc-behavior-desc"
										>Automatically restart the container if it stops responding</span
									>
								</div>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-behavior-item"
								class:hc-behavior-item--active={readinessEnabled}
								onclick={() => {
									readinessEnabled = !readinessEnabled;
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-behavior-check" class:hc-behavior-check--on={readinessEnabled}>
									{#if readinessEnabled}
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="3"
											stroke-linecap="round"
											stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
										>
									{/if}
								</div>
								<div class="hc-behavior-text">
									<span class="hc-behavior-title">Stop sending traffic if failing</span>
									<span class="hc-behavior-desc"
										>Temporarily stop routing requests to this container while it recovers</span
									>
								</div>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hc-behavior-item"
								class:hc-behavior-item--active={startupEnabled}
								onclick={() => {
									startupEnabled = !startupEnabled;
									isEditingHealthCheck = true;
								}}
							>
								<div class="hc-behavior-check" class:hc-behavior-check--on={startupEnabled}>
									{#if startupEnabled}
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="3"
											stroke-linecap="round"
											stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
										>
									{/if}
								</div>
								<div class="hc-behavior-text">
									<span class="hc-behavior-title">Allow extra time on startup</span>
									<span class="hc-behavior-desc"
										>Give your app more time to start up before checking its health</span
									>
								</div>
							</div>
						</div>
					</div>

					<!-- Timing — collapsible advanced -->
					<details class="hc-advanced-details">
						<summary class="hc-advanced-summary">
							<Settings size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
							<span>Advanced timing settings</span>
							<ChevronDown
								size={14}
								class="h-3.5 w-3.5 hc-advanced-chevron"
								style="color: var(--surface-muted);"
							/>
						</summary>
						<div class="hc-timing-grid">
							<div class="hc-timing-card">
								<label class="hc-timing-card-label" for="hc-interval">Check every</label>
								<div class="hc-timing-input-wrap">
									<input
										id="hc-interval"
										type="number"
										bind:value={healthCheckInterval}
										min="1"
										class="input text-sm font-mono hc-timing-input"
									/>
									<span class="hc-timing-suffix">seconds</span>
								</div>
								<span class="hc-timing-card-hint">How often to run the health check</span>
							</div>
							<div class="hc-timing-card">
								<label class="hc-timing-card-label" for="hc-timeout">Wait up to</label>
								<div class="hc-timing-input-wrap">
									<input
										id="hc-timeout"
										type="number"
										bind:value={healthCheckTimeout}
										min="1"
										class="input text-sm font-mono hc-timing-input"
									/>
									<span class="hc-timing-suffix">seconds</span>
								</div>
								<span class="hc-timing-card-hint">Max time to wait for a response</span>
							</div>
							<div class="hc-timing-card">
								<label class="hc-timing-card-label" for="hc-retries">Fail after</label>
								<div class="hc-timing-input-wrap">
									<input
										id="hc-retries"
										type="number"
										bind:value={healthCheckRetries}
										min="1"
										class="input text-sm font-mono hc-timing-input"
									/>
									<span class="hc-timing-suffix">failures</span>
								</div>
								<span class="hc-timing-card-hint">Consecutive failures before taking action</span>
							</div>
							{#if startupEnabled}
								<div class="hc-timing-card">
									<label class="hc-timing-card-label" for="hc-startup-retries">Startup grace</label>
									<div class="hc-timing-input-wrap">
										<input
											id="hc-startup-retries"
											type="number"
											bind:value={startupFailureThreshold}
											min="1"
											class="input text-sm font-mono hc-timing-input"
										/>
										<span class="hc-timing-suffix">attempts</span>
									</div>
									<span class="hc-timing-card-hint">Extra attempts allowed during startup</span>
								</div>
							{/if}
						</div>
					</details>
				</div>
			{/if}
		</div>
	</SectionCard>
</div>
