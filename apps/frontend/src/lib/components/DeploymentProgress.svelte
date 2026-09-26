<script lang="ts">
	import { buildPhases, formatPhase } from '$lib/components/deployment/build-phases';
	import { Loader2, Check, X, ChevronDown, ChevronUp, Github, Container } from 'lucide-svelte';
	import { flip } from 'svelte/animate';
	import { backOut } from 'svelte/easing';
	import BuildSteps from './BuildSteps.svelte';
	import { Alert } from '$lib/components/ui';

	interface Props {
		status: string;
		buildStatus?: string;
		buildStep?: string | null;
		buildLogs?: string | null;
		buildError?: string | null;
		isGitHubDeploy: boolean;
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
		buildStepTimestamps?: Record<string, number> | null;
	}

	let {
		status,
		buildStatus = 'none',
		buildStep,
		buildLogs,
		buildError,
		isGitHubDeploy,
		warnings,
		buildStepTimestamps
	}: Props = $props();

	function sanitizeLogs(logs: string | null | undefined): string {
		if (!logs) return '';

		let sanitized = logs;

		sanitized = sanitized.replace(
			/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi,
			'***REDACTED***'
		);

		sanitized = sanitized.replace(
			/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi,
			'https://***@github.com'
		);

		sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');

		sanitized = sanitized.replace(
			/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-.]+/gi,
			'$1 ***REDACTED***'
		);

		sanitized = sanitized.replace(
			/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
			'$1=***REDACTED***'
		);

		return sanitized;
	}

	// Build logs are grow-only: sanitize only content appended since the last
	// call, re-running from the last committed newline so a secret can't
	// straddle the boundary.
	let sanRawPrefix = '';
	let sanOutPrefix = '';
	function sanitizeGrowing(raw: string | null | undefined): string {
		if (!raw) return '';
		if (!raw.startsWith(sanRawPrefix)) {
			sanRawPrefix = '';
			sanOutPrefix = '';
		}
		const suffix = raw.slice(sanRawPrefix.length);
		const nl = suffix.lastIndexOf('\n');
		if (nl >= 0) {
			sanOutPrefix += sanitizeLogs(suffix.slice(0, nl + 1));
			sanRawPrefix = raw.slice(0, sanRawPrefix.length + nl + 1);
			return sanOutPrefix + sanitizeLogs(suffix.slice(nl + 1));
		}
		return sanOutPrefix + sanitizeLogs(suffix);
	}

	const sanitizedBuildLogs = $derived(sanitizeGrowing(buildLogs));

	let showLogs = $state(true); // Default to showing logs
	let failureShown = false;
	$effect(() => {
		if (buildStatus === 'failed') {
			if (!failureShown) {
				failureShown = true;
				showLogs = true;
			}
		} else {
			failureShown = false;
		}
	});
	let logsPanel: HTMLDivElement | undefined = $state();
	let previousLogsLength = $state(0);
	let currentTime = $state(Date.now());

	$effect(() => {
		if (buildStatus !== 'building') return;
		currentTime = Date.now();
		const interval = setInterval(() => {
			currentTime = Date.now();
		}, 100);
		return () => clearInterval(interval);
	});

	function getStepTimestamp(stepId: string): number | null {
		return buildStepTimestamps?.[stepId] ?? null;
	}

	// Auto-scroll to bottom when new logs arrive
	$effect(() => {
		if (sanitizedBuildLogs && logsPanel && sanitizedBuildLogs.length > previousLogsLength) {
			// Use setTimeout to ensure DOM has updated
			setTimeout(() => {
				if (logsPanel) {
					logsPanel.scrollTop = logsPanel.scrollHeight;
				}
			}, 0);
		}
		previousLogsLength = sanitizedBuildLogs?.length ?? 0;
	});

	// Define steps for GitHub deployments
	const githubSteps = [
		{
			id: 'cloning',
			label: 'Scheduling builder',
			description: 'Provisioning the build environment'
		},
		{ id: 'building', label: 'Building image', description: 'Creating Docker image' },
		{ id: 'pushing', label: 'Pushing image', description: 'Uploading to container registry' },
		{
			id: 'deploying',
			label: 'Creating app',
			description: 'Setting up Kubernetes resources'
		},
		{ id: 'complete', label: 'Done', description: 'App is ready' }
	];

	// Define steps for image-based deployments
	const imageSteps = [
		{
			id: 'deploying',
			label: 'Creating app',
			description: 'Setting up Kubernetes resources'
		},
		{ id: 'service', label: 'Creating service', description: 'Configuring network access' },
		{ id: 'complete', label: 'Spinning up pods', description: 'Starting containers' }
	];

	const steps = $derived(isGitHubDeploy ? githubSteps : imageSteps);

	function getStepIndex(stepId: string | null | undefined): number {
		if (!stepId) return -1;
		return steps.findIndex((s) => s.id === stepId);
	}

	const currentStepIndex = $derived(getStepIndex(buildStep));

	function getStepStatus(index: number): 'completed' | 'current' | 'pending' | 'error' {
		if (buildStatus === 'failed') {
			if (index < currentStepIndex) return 'completed';
			if (index === currentStepIndex) return 'error';
			return 'pending';
		}
		if (index < currentStepIndex) return 'completed';
		if (index === currentStepIndex) return 'current';
		return 'pending';
	}

	function formatDuration(seconds: number): string {
		if (seconds < 60) {
			return `${seconds.toFixed(1)}s`;
		} else {
			const minutes = Math.floor(seconds / 60);
			const remainingSeconds = Math.floor(seconds % 60);
			return `${minutes}m ${remainingSeconds}s`;
		}
	}

	function getTotalBuildSeconds(): number | null {
		if (!buildStepTimestamps) return null;
		const timestamps = Object.entries(buildStepTimestamps).filter(
			([k, v]) => !k.startsWith('__') && typeof v === 'number'
		);
		if (timestamps.length === 0) return null;
		const startTime = Math.min(...timestamps.map(([, v]) => v));
		const endTime = buildStepTimestamps['complete'];
		if (!endTime) return null;
		return Math.max(0, (endTime - startTime) / 1000);
	}

	const totalDurationSeconds = $derived(getTotalBuildSeconds());

	const phases = $derived(
		isGitHubDeploy ? buildPhases(buildStepTimestamps, currentTime, buildStatus === 'building') : []
	);
	const phaseTotal = $derived(phases.reduce((sum, p) => sum + p.ms, 0));
</script>

<div class="deployment-progress">
	{#if buildStatus !== 'building'}
		<div class="mb-3 flex items-center gap-2">
			{#if isGitHubDeploy}
				<Github class="h-4 w-4 icon-muted" />
			{:else}
				<Container class="h-4 w-4 icon-muted" />
			{/if}
			<span class="text-sm font-medium">
				{#if buildStatus === 'failed'}
					Deployment failed
				{:else if buildStatus === 'succeeded'}
					{#if totalDurationSeconds !== null}
						Deployment completed in {formatDuration(totalDurationSeconds)}
					{:else}
						Deployment succeeded
					{/if}
				{:else}
					App ready
				{/if}
			</span>
		</div>
	{/if}

	<div class="step-list">
		{#each steps as step, index (step.id)}
			{@const stepStatus = getStepStatus(index)}
			<div
				class="step-row flex items-center gap-2 rounded-md"
				class:step-current={stepStatus === 'current'}
				class:step-error={stepStatus === 'error'}
				class:step-row-active={stepStatus === 'current'}
				animate:flip={{ duration: 500, easing: backOut }}
			>
				{#if stepStatus === 'completed'}
					<div class="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 shrink-0">
						<Check class="h-2.5 w-2.5 text-white" />
					</div>
				{:else if stepStatus === 'current'}
					<Loader2 class="h-4 w-4 shrink-0 animate-spin text-primary-500" />
				{:else if stepStatus === 'error'}
					<div class="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 shrink-0">
						<X class="h-2.5 w-2.5 text-white" />
					</div>
				{:else}
					<div class="step-pending h-4 w-4 shrink-0 rounded-full border-2"></div>
				{/if}

				<span
					class="step-label flex-1 min-w-0 truncate"
					class:text-primary-600={stepStatus === 'current'}
					class:text-red-600={stepStatus === 'error'}
					class:step-text-completed={stepStatus === 'completed'}
					class:step-text-pending={stepStatus === 'pending'}
				>
					{step.label}
				</span>

				{#if stepStatus === 'completed'}
					{@const startTime = getStepTimestamp(step.id)}
					{#if startTime}
						{@const nextStepIndex = index + 1}
						{@const nextStepStartTime =
							nextStepIndex < steps.length
								? getStepTimestamp(steps[nextStepIndex].id)
								: getStepTimestamp('complete')}
						{#if nextStepStartTime}
							{@const duration = Math.max(0, (nextStepStartTime - startTime) / 1000)}
							<span class="step-duration text-xs font-mono muted-text shrink-0">
								{formatDuration(duration)}
							</span>
						{/if}
					{/if}
				{:else if stepStatus === 'current' && buildStep === step.id}
					{@const startTime = getStepTimestamp(step.id)}
					{#if startTime}
						{@const elapsed = Math.max(0, (currentTime - startTime) / 1000)}
						<span class="step-duration text-xs font-mono text-primary-600 shrink-0">
							{formatDuration(elapsed)}
						</span>
					{/if}
				{/if}
			</div>
		{/each}
	</div>

	{#if phases.length > 1 && phaseTotal > 0}
		<div class="phase-bar" role="img" aria-label="Where the time went">
			{#each phases as p (p.id)}
				<span
					class="phase-seg phase-seg--{p.id}"
					class:phase-seg--live={p.live}
					style="flex-grow: {Math.max(p.ms, phaseTotal * 0.015)}"
					title="{p.label}: {formatPhase(p.ms)}"
				></span>
			{/each}
		</div>
		<ul class="phase-legend">
			{#each phases as p (p.id)}
				<li class="phase-item" class:phase-item--live={p.live}>
					<span class="phase-dot phase-seg--{p.id}"></span>
					<span class="phase-label">{p.label}</span>
					<span class="phase-ms">{formatPhase(p.ms)}</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if warnings?.length && buildStatus !== 'building'}
		<div class="mt-4">
			<Alert tone="warning" title="Pod warnings">
				<div class="space-y-2">
					{#each warnings as warning, i (i)}
						<div class="text-xs">
							<span class="font-mono font-semibold">{warning.podName}:</span>
							<span class="ml-1">{warning.message}</span>
						</div>
					{/each}
				</div>
			</Alert>
		</div>
	{/if}

	{#if buildLogs}
		<div class="mt-4">
			<button
				onclick={() => (showLogs = !showLogs)}
				class="logs-toggle flex items-center gap-2 text-sm font-medium transition-colors"
			>
				{#if showLogs}
					<ChevronUp class="h-4 w-4" />
					{buildStatus === 'failed' ? 'Hide last deployment logs' : 'Hide logs'}
				{:else}
					<ChevronDown class="h-4 w-4" />
					{buildStatus === 'failed' ? 'Show last deployment logs' : 'Show logs'}
				{/if}
			</button>

			{#if showLogs}
				<div bind:this={logsPanel} class="mt-2">
					<BuildSteps logs={sanitizedBuildLogs} />
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.deployment-progress {
		color: var(--center-channel-color);
	}

	.muted-text {
		color: var(--surface-muted);
	}

	.icon-muted {
		color: var(--surface-muted);
	}

	.step-item {
		background-color: transparent;
	}

	.step-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.step-row {
		padding: 0.25rem 0.6rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		opacity: 0.55;
		transition:
			padding var(--dur-base) cubic-bezier(0.34, 1.56, 0.64, 1),
			font-size var(--dur-base) cubic-bezier(0.34, 1.56, 0.64, 1),
			opacity var(--dur-base) ease,
			background-color var(--dur-base) ease;
	}

	.step-row-active {
		padding: 0.75rem 0.9rem;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		opacity: 1;
		background-color: color-mix(in srgb, var(--button-bg) 12%, transparent);
		box-shadow: 0 4px 16px -8px color-mix(in srgb, var(--button-bg) 50%, transparent);
	}

	.step-label {
		font-size: inherit;
		transition: font-size var(--dur-base) cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	/* Grow icons with width/height — don't touch `transform` or the
	   Loader2 spin animation breaks. */
	.step-row-active :global(svg) {
		width: 1.15rem;
		height: 1.15rem;
		transition:
			width var(--dur-base) cubic-bezier(0.34, 1.56, 0.64, 1),
			height var(--dur-base) cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.step-current {
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
	}

	.step-error {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	.step-pending {
		border-color: var(--surface-border);
	}

	.step-text-completed {
		color: var(--center-channel-color);
	}

	.step-text-pending {
		color: var(--surface-muted);
		opacity: 0.7;
	}

	.logs-toggle {
		color: var(--surface-muted);
	}

	.logs-toggle:hover {
		color: var(--center-channel-color);
	}

	.logs-panel {
		background-color: var(--control-bg);
		color: var(--center-channel-color);
		border: 1px solid var(--surface-border);
		font-weight: 400;
	}

	.step-duration {
		white-space: nowrap;
		opacity: 0.8;
	}

	.phase-bar {
		display: flex;
		gap: 2px;
		height: 0.375rem;
		margin-top: 0.875rem;
		border-radius: var(--radius-pill);
		overflow: hidden;
	}
	.phase-seg {
		flex-basis: 0;
		min-width: 3px;
		border-radius: 2px;
		background: var(--phase-tone, var(--surface-border));
		transition: flex-grow var(--dur-base) ease;
	}
	.phase-seg--live {
		animation: phase-pulse 1.6s ease-in-out infinite;
	}
	@keyframes phase-pulse {
		50% {
			opacity: 0.55;
		}
	}
	.phase-seg--queue {
		--phase-tone: color-mix(in srgb, var(--surface-muted) 55%, transparent);
	}
	.phase-seg--schedule {
		--phase-tone: var(--hue-amber, var(--status-warning));
	}
	.phase-seg--start {
		--phase-tone: color-mix(in srgb, var(--status-warning) 65%, var(--surface-bg));
	}
	.phase-seg--clone {
		--phase-tone: var(--hue-violet, var(--accent));
	}
	.phase-seg--build {
		--phase-tone: var(--accent);
	}
	.phase-seg--push {
		--phase-tone: var(--hue-green, var(--status-success));
	}
	.phase-seg--rollout {
		--phase-tone: color-mix(in srgb, var(--status-success) 70%, var(--surface-bg));
	}
	.phase-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 0.875rem;
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
	}
	.phase-item {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.phase-item--live {
		color: var(--text-default);
	}
	.phase-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--phase-tone, var(--surface-border));
	}
	.phase-ms {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
</style>
