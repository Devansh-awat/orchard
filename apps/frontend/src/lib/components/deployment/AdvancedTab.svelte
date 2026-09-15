<script lang="ts">
	import { Loader2, ExternalLink, TriangleAlert } from 'lucide-svelte';
	import {
		Activity,
		Check,
		ChevronDown,
		ServerCog,
		Settings,
		SlidersHorizontal,
		Terminal,
		Wifi
	} from '@jis3r/icons';
	import { isSuperAdmin } from '$lib/stores';
	import { SectionCard, StatusBadge, statusMeta, Button, Input } from '$lib/components/ui';
	import GitHubSourceCard from './GitHubSourceCard.svelte';
	import NodePoolPicker from './NodePoolPicker.svelte';
	import type {
		AutoDeployStatus,
		DockerfileHealthCheck,
		GitHubDeploymentRecord
	} from '$lib/types/deployment';

	let {
		deployment,
		// Source
		onSourceUpdated,
		onDeploymentUpdated,
		onRebuild,
		rebuilding,
		// Strategy
		strategyValue = $bindable(),
		savingStrategy,
		hasPvcVolume,
		onSaveStrategy,
		// Disruption budget
		pdbMinAvailable = $bindable(),
		savingPdb,
		onSavePdb,
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
		autoDeployPaths = $bindable(),
		savingAutoDeployPaths,
		onSaveAutoDeployPaths,
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
		healthCheckOverride = $bindable(false),
		savingHealthCheck,
		isEditingHealthCheck = $bindable(),
		onSaveHealthCheck,
		sections = ['source', 'strategy', 'nodepool', 'build', 'autodeploy', 'health']
	}: {
		deployment: any;
		onSourceUpdated: (updated: any) => void;
		onDeploymentUpdated?: (updated: any) => void;
		onRebuild: () => void;
		rebuilding: boolean;
		strategyValue: 'rollingUpdate' | 'recreate';
		savingStrategy: boolean;
		hasPvcVolume: boolean;
		onSaveStrategy: (next: 'rollingUpdate' | 'recreate') => void;
		pdbMinAvailable: number;
		savingPdb: boolean;
		onSavePdb: () => void;
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		buildOptionsDirty?: boolean;
		savingAdvanced: boolean;
		onSaveAdvanced: () => void;
		autoDeployStatus: AutoDeployStatus | null;
		autoDeployLoading: boolean;
		autoDeployBranch: string;
		autoDeployPaths: string;
		savingAutoDeployPaths: boolean;
		onSaveAutoDeployPaths: () => void;
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
		healthCheckOverride: boolean;
		savingHealthCheck: boolean;
		isEditingHealthCheck: boolean;
		onSaveHealthCheck: () => void;
		sections?: string[];
	} = $props();

	const replicaCount = $derived(Number(deployment.replicas ?? 1));
	const pdbDirty = $derived(Number(pdbMinAvailable) !== Number(deployment.pdbMinAvailable ?? 1));
	const pdbActive = $derived(Number(pdbMinAvailable) > 0 && replicaCount > Number(pdbMinAvailable));

	function watchPathLines(value: string) {
		return value
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.join('\n');
	}

	const savedWatchPaths = $derived(watchPathLines((autoDeployStatus?.paths ?? []).join('\n')));

	const watchPathsDirty = $derived(watchPathLines(autoDeployPaths ?? '') !== savedWatchPaths);

	const HC_METHODS = [
		{ id: 'http', label: 'Web endpoint', desc: 'Ping a URL path', icon: Wifi },
		{ id: 'tcp', label: 'Port check', desc: 'Open a TCP connection', icon: ServerCog },
		{ id: 'exec', label: 'Command', desc: 'Run a command inside the container', icon: Terminal }
	];

	const dockerfileHealthCheck = $derived(
		(deployment?.dockerfileHealthCheck ?? null) as DockerfileHealthCheck | null
	);

	const usingDockerfileHealthCheck = $derived(!!dockerfileHealthCheck && !healthCheckOverride);

	const detectedCommand = $derived.by(() => {
		const command = dockerfileHealthCheck?.command ?? [];
		if (command.length === 3 && command[1] === '-c') return command[2];
		return command.join(' ');
	});

	const detectedTiming = $derived.by(() => {
		const hc = dockerfileHealthCheck;
		if (!hc) return '';
		const parts = [
			`every ${hc.interval ?? 30}s`,
			`${hc.timeout ?? 30}s timeout`,
			`${hc.retries ?? 3} retries`
		];
		if (hc.startPeriod) parts.push(`${hc.startPeriod}s to start up`);
		return parts.join(' · ');
	});

	function setHealthCheckOverride(next: boolean) {
		healthCheckOverride = next;
		isEditingHealthCheck = true;
	}

	const HC_BEHAVIORS = $derived([
		{
			id: 'liveness',
			label: 'Restart the container',
			desc: 'Kill and restart it when the check keeps failing',
			get: () => livenessEnabled,
			set: (v: boolean) => (livenessEnabled = v)
		},
		{
			id: 'readiness',
			label: 'Stop sending traffic',
			desc: 'Pull it out of rotation until the check passes again',
			get: () => readinessEnabled,
			set: (v: boolean) => (readinessEnabled = v)
		},
		{
			id: 'startup',
			label: 'Allow extra time on startup',
			desc: 'Hold off on the other checks until the app has booted',
			get: () => startupEnabled,
			set: (v: boolean) => (startupEnabled = v)
		}
	]);
</script>

<div class="space-y-5">
	{#if sections.includes('source') && deployment.githubRepo}
		<GitHubSourceCard {deployment} onUpdated={onSourceUpdated} {onRebuild} {rebuilding} />
	{/if}

	{#if sections.includes('strategy')}
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

		<SectionCard title="Disruption budget">
			{#snippet actions()}
				<Button
					variant="primary"
					size="sm"
					loading={savingPdb}
					disabled={savingPdb || !pdbDirty}
					onclick={onSavePdb}
				>
					Save
				</Button>
			{/snippet}
			<p class="strategy-card-desc">
				How many pods Kubernetes must keep ready while it drains the node underneath them, during a
				cluster upgrade or a maintenance move. Set it to 0 to let the app go all the way down.
			</p>
			<div class="hc-field mt-3">
				<label class="hc-label" for="pdb-min-available">Keep ready during a drain</label>
				<div class="hc-num-wrap">
					<input
						id="pdb-min-available"
						type="number"
						class="hc-num"
						bind:value={pdbMinAvailable}
						min="0"
						max="100"
					/>
					<span class="hc-num-suffix">of {replicaCount} {replicaCount === 1 ? 'pod' : 'pods'}</span>
				</div>
			</div>
			{#if Number(pdbMinAvailable) <= 0}
				<div class="strategy-note mt-3">
					<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
					<span>No budget is set, so a node drain may take every pod of this app down at once.</span
					>
				</div>
			{:else if !pdbActive}
				<div class="strategy-note mt-3">
					<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
					<span
						>This app runs {replicaCount}
						{replicaCount === 1 ? 'replica' : 'replicas'}, so the budget is kept as a setting but
						not enforced: one that covers every pod you have would block node drains forever instead
						of moving the app. It starts applying above {pdbMinAvailable} replicas.</span
					>
				</div>
			{/if}
		</SectionCard>
	{/if}

	{#if sections.includes('nodepool')}
		<NodePoolPicker
			deploymentId={deployment.id}
			nodePoolId={deployment.nodePoolId}
			onSaved={onDeploymentUpdated}
		/>
	{/if}

	{#if sections.includes('build')}
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
	{/if}

	{#if sections.includes('autodeploy')}
		<SectionCard title="Auto-deploy">
			{#snippet actions()}
				{#if deployment.githubRepo && autoDeployStatus?.enabled}
					<StatusBadge meta={statusMeta('success', 'Active')} />
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
					<p class="text-sm text-muted">
						Pushes to <code class="font-mono rounded px-1.5 py-0.5 text-xs bg-raised text-fg"
							>{autoDeployStatus.branch}</code
						>
						{savedWatchPaths.length > 0
							? 'that change a watched path trigger a new deployment.'
							: 'trigger a new deployment automatically.'}
					</p>
					<div class="mt-3">
						<p class="text-xs mb-1.5 font-medium text-muted">Watch paths</p>
						<textarea
							class="w-full text-xs rounded px-2 py-1.5 bg-surface text-fg border border-edge font-mono"
							rows="3"
							placeholder="apps/web/**&#10;packages/ui/**&#10;!**/*.md"
							bind:value={autoDeployPaths}></textarea>
						<div class="mt-1.5 flex items-end justify-between gap-3">
							<p class="text-xs text-muted">
								One glob per line. A push only builds when it changes a file matching one of them,
								and a line starting with <code class="font-mono">!</code> ignores matches. Leave it empty
								to build on every push.
							</p>
							<Button
								size="sm"
								disabled={!watchPathsDirty || savingAutoDeployPaths}
								onclick={onSaveAutoDeployPaths}
								class="shrink-0"
							>
								{#if savingAutoDeployPaths}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								<span>Save</span>
							</Button>
						</div>
					</div>
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
					{:else if autoDeployStatus?.linked === false}
						<div
							class="mt-3 flex items-center justify-between gap-3 rounded-xl p-4"
							style="background-color: var(--warning-bg); border: 1px solid var(--warning-border);"
						>
							<div>
								<p class="text-sm font-medium" style="color: var(--warning-text);">
									Auto-deploy is on but not connected
								</p>
								<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
									This deployment isn't bound to a GitHub App installation, so pushes never reach
									it. Nothing builds, and nothing reports an error. Reconnect to bind it; your
									branch and watch paths are kept.
								</p>
							</div>
							<button
								onclick={onEnableAutoDeploy}
								disabled={enablingAutoDeploy || !autoDeployBranch}
								class="btn btn-primary btn-sm shrink-0"
							>
								{#if enablingAutoDeploy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								<span>Reconnect</span>
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
					<div class="mt-3">
						<p class="text-xs mb-1.5 font-medium text-muted">Watch paths (optional)</p>
						<textarea
							class="w-full text-xs rounded px-2 py-1.5 bg-surface text-fg border border-edge font-mono"
							rows="2"
							placeholder="apps/web/**&#10;!**/*.md"
							bind:value={autoDeployPaths}></textarea>
						<p class="text-xs mt-1 text-muted">
							One glob per line. Only pushes changing a matching file will build. Leave it empty to
							build on every push.
						</p>
					</div>
				{/if}

				{#if githubDeployments.length > 0}
					<details class="mt-4 group">
						<summary
							class="cursor-pointer text-xs font-medium"
							style="color: var(--surface-muted);"
						>
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
										<code class="text-[11px] font-mono"
											>{ghDeployment.commitSha.substring(0, 7)}</code
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
	{/if}

	{#if sections.includes('health')}
		<SectionCard title="Health checks">
			{#snippet actions()}
				<Button size="sm" loading={savingHealthCheck} onclick={onSaveHealthCheck}>Save</Button>
			{/snippet}
			<div
				class="hc-root"
				onchange={() => (isEditingHealthCheck = true)}
				oninput={() => (isEditingHealthCheck = true)}
			>
				{#if dockerfileHealthCheck}
					<div class="hc-detected" class:hc-detected--inactive={healthCheckOverride}>
						<span class="hc-detected-icon"><Terminal size={18} class="h-4 w-4" /></span>
						<div class="hc-detected-text">
							<span class="hc-detected-title">
								{usingDockerfileHealthCheck
									? 'Running the HEALTHCHECK from your Dockerfile'
									: 'Your Dockerfile has a HEALTHCHECK, and these settings replace it'}
							</span>
							<code class="hc-detected-cmd">{detectedCommand}</code>
							<span class="hc-detected-meta">{detectedTiming}</span>
						</div>
						<Button
							size="sm"
							variant={usingDockerfileHealthCheck ? 'secondary' : 'ghost'}
							onclick={() => setHealthCheckOverride(!healthCheckOverride)}
						>
							{usingDockerfileHealthCheck ? 'Set your own' : 'Go back to it'}
						</Button>
					</div>
				{/if}

				{#if !usingDockerfileHealthCheck}
					<button
						type="button"
						class="hc-master"
						role="switch"
						aria-checked={healthCheckEnabled}
						onclick={() => {
							healthCheckEnabled = !healthCheckEnabled;
							isEditingHealthCheck = true;
						}}
					>
						<span class="hc-master-icon"><Activity size={18} class="h-4 w-4" /></span>
						<span class="hc-master-text">
							<span class="hc-master-title">Health checks</span>
							<span class="hc-master-sub">
								{healthCheckEnabled
									? 'Orchard watches your app and recovers it automatically'
									: 'Crashes and hangs go undetected until you notice them'}
							</span>
						</span>
						<span class="hc-switch"><span class="hc-switch-knob"></span></span>
					</button>

					{#if healthCheckEnabled}
						<section class="hc-group">
							<h3 class="hc-group-title">Check method</h3>
							<div class="hc-methods" role="radiogroup" aria-label="Health check method">
								{#each HC_METHODS as method (method.id)}
									{@const MethodIcon = method.icon}
									<button
										type="button"
										role="radio"
										aria-checked={healthCheckType === method.id}
										class="hc-method"
										class:hc-method--active={healthCheckType === method.id}
										onclick={() => {
											healthCheckType = method.id;
											isEditingHealthCheck = true;
										}}
									>
										<span class="hc-method-icon"><MethodIcon size={18} class="h-4 w-4" /></span>
										<span class="hc-method-label">{method.label}</span>
										<span class="hc-method-desc">{method.desc}</span>
									</button>
								{/each}
							</div>

							<div class="hc-config">
								{#if healthCheckType === 'http'}
									<div class="hc-config-row">
										<div class="hc-field hc-field--grow">
											<label class="hc-label" for="hc-path">Path</label>
											<Input id="hc-path" bind:value={healthCheckPath} placeholder="/health" />
										</div>
										<div class="hc-field hc-field--port">
											<label class="hc-label" for="hc-port">Port</label>
											<input
												id="hc-port"
												type="number"
												class="hc-num"
												bind:value={healthCheckPort}
												placeholder="80"
											/>
										</div>
									</div>
									<p class="hc-config-hint">
										A GET request here should return 2xx while your app is healthy
									</p>
								{:else if healthCheckType === 'tcp'}
									<div class="hc-config-row">
										<div class="hc-field hc-field--port">
											<label class="hc-label" for="hc-tcp-port">Port</label>
											<input
												id="hc-tcp-port"
												type="number"
												class="hc-num"
												bind:value={healthCheckPort}
												placeholder="80"
											/>
										</div>
									</div>
									<p class="hc-config-hint">
										Orchard opens a connection to this port and closes it again
									</p>
								{:else}
									<div class="hc-config-row">
										<div class="hc-field hc-field--grow">
											<label class="hc-label" for="hc-cmd">Command</label>
											<Input
												id="hc-cmd"
												bind:value={healthCheckCommand}
												placeholder="cat /tmp/healthy"
											/>
										</div>
									</div>
									<p class="hc-config-hint">
										Runs inside the container and should exit 0 while healthy
									</p>
								{/if}
							</div>
						</section>

						<section class="hc-group">
							<h3 class="hc-group-title">On failure</h3>
							<div class="hc-list">
								{#each HC_BEHAVIORS as behavior (behavior.id)}
									{@const on = behavior.get()}
									<button
										type="button"
										class="hc-row"
										role="switch"
										aria-checked={on}
										onclick={() => {
											behavior.set(!on);
											isEditingHealthCheck = true;
										}}
									>
										<span class="hc-check" class:hc-check--on={on}>
											{#if on}<Check size={12} class="h-3 w-3" />{/if}
										</span>
										<span class="hc-row-text">
											<span class="hc-row-title">{behavior.label}</span>
											<span class="hc-row-desc">{behavior.desc}</span>
										</span>
									</button>
								{/each}
							</div>
						</section>

						<details class="hc-advanced">
							<summary class="hc-advanced-summary">
								<span>Timing</span>
								<ChevronDown size={14} class="h-3.5 w-3.5 hc-advanced-chevron" />
							</summary>
							<div class="hc-timing">
								<div class="hc-field">
									<label class="hc-label" for="hc-interval">Check every</label>
									<div class="hc-num-wrap">
										<input
											id="hc-interval"
											type="number"
											class="hc-num"
											bind:value={healthCheckInterval}
											min="1"
										/>
										<span class="hc-num-suffix">seconds</span>
									</div>
								</div>
								<div class="hc-field">
									<label class="hc-label" for="hc-timeout">Wait up to</label>
									<div class="hc-num-wrap">
										<input
											id="hc-timeout"
											type="number"
											class="hc-num"
											bind:value={healthCheckTimeout}
											min="1"
										/>
										<span class="hc-num-suffix">seconds</span>
									</div>
								</div>
								<div class="hc-field">
									<label class="hc-label" for="hc-retries">Fail after</label>
									<div class="hc-num-wrap">
										<input
											id="hc-retries"
											type="number"
											class="hc-num"
											bind:value={healthCheckRetries}
											min="1"
										/>
										<span class="hc-num-suffix">failures</span>
									</div>
								</div>
								{#if startupEnabled}
									<div class="hc-field">
										<label class="hc-label" for="hc-startup-retries">Startup grace</label>
										<div class="hc-num-wrap">
											<input
												id="hc-startup-retries"
												type="number"
												class="hc-num"
												bind:value={startupFailureThreshold}
												min="1"
											/>
											<span class="hc-num-suffix">attempts</span>
										</div>
									</div>
								{/if}
							</div>
						</details>
					{/if}
				{/if}
			</div>
		</SectionCard>
	{/if}
</div>
