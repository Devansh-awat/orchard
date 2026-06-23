<script lang="ts">
	import { Loader2, Check, X, ChevronDown, ChevronUp, Github, Container } from 'lucide-svelte';
	import { flip } from 'svelte/animate';
	import { backOut } from 'svelte/easing';
	import BuildSteps from './BuildSteps.svelte';
	import AnimatedNumber from './AnimatedNumber.svelte';

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
			/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-\.]+/gi,
			'$1 ***REDACTED***'
		);

		sanitized = sanitized.replace(
			/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
			'$1=***REDACTED***'
		);

		return sanitized;
	}

	const sanitizedBuildLogs = $derived(sanitizeLogs(buildLogs));
	const sanitizedBuildError = $derived(sanitizeLogs(buildError));

	let showLogs = $state(true); // Default to showing logs
	let logsPanel: HTMLDivElement | undefined = $state();
	let previousLogsLength = $state(0);
	let currentTime = $state(Date.now());

	// Update current time every second to update elapsed time display
	$effect(() => {
		const interval = setInterval(() => {
			currentTime = Date.now();
		}, 1000);
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
		{ id: 'cloning', label: 'Cloning repository', description: 'Fetching source code from GitHub' },
		{ id: 'building', label: 'Building image', description: 'Creating Docker image' },
		{ id: 'pushing', label: 'Pushing image', description: 'Uploading to container registry' },
		{
			id: 'deploying',
			label: 'Creating deployment',
			description: 'Setting up Kubernetes resources'
		},
		{ id: 'complete', label: 'Done', description: 'Deployment is ready' }
	];

	// Define steps for image-based deployments
	const imageSteps = [
		{
			id: 'deploying',
			label: 'Creating deployment',
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
		return Math.max(0, Math.floor((endTime - startTime) / 1000));
	}

	const totalDurationSeconds = $derived(getTotalBuildSeconds());
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
					Build failed
				{:else if buildStatus === 'succeeded'}
					{#if totalDurationSeconds !== null}
						Build completed in <AnimatedNumber
							value={totalDurationSeconds}
							format={formatDuration}
						/>
					{:else}
						Build succeeded
					{/if}
				{:else}
					Deployment ready
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
							{@const duration = Math.max(0, Math.floor((nextStepStartTime - startTime) / 1000))}
							<AnimatedNumber
								value={duration}
								format={formatDuration}
								class="step-duration text-xs font-mono muted-text shrink-0"
							/>
						{/if}
					{/if}
				{:else if stepStatus === 'current' && buildStep === step.id}
					{@const startTime = getStepTimestamp(step.id)}
					{#if startTime}
						{@const elapsed = Math.max(0, Math.floor((currentTime - startTime) / 1000))}
						<AnimatedNumber
							value={elapsed}
							format={formatDuration}
							class="step-duration text-xs font-mono text-primary-600 shrink-0"
						/>
					{/if}
				{/if}
			</div>
		{/each}
	</div>

	{#if buildError && buildStatus === 'failed'}
		<div class="error-box mt-4 rounded-lg p-4">
			<p class="text-sm font-medium">Error</p>
			<p class="mt-1 text-sm font-mono whitespace-pre-wrap">
				{sanitizedBuildError}
			</p>
		</div>
	{/if}

	{#if warnings?.length && buildStatus !== 'building'}
		<div class="warning-box mt-4 rounded-lg p-4">
			<div class="flex items-start gap-2 mb-2">
				<svg class="h-5 w-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium">Pod Warnings</p>
					<div class="mt-2 space-y-2">
						{#each warnings as warning}
							<div class="text-xs">
								<span class="font-mono font-semibold">{warning.podName}:</span>
								<span class="ml-1">{warning.message}</span>
							</div>
						{/each}
					</div>
				</div>
			</div>
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
					{buildStatus === 'failed' ? 'Hide last build logs' : 'Hide logs'}
				{:else}
					<ChevronDown class="h-4 w-4" />
					{buildStatus === 'failed' ? 'Show last build logs' : 'Show logs'}
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
		padding: 0.3rem 0.6rem;
		font-size: 0.8125rem;
		opacity: 0.55;
		transition:
			padding 360ms cubic-bezier(0.34, 1.56, 0.64, 1),
			font-size 360ms cubic-bezier(0.34, 1.56, 0.64, 1),
			opacity 280ms ease,
			background-color 220ms ease;
	}

	.step-row-active {
		padding: 0.75rem 0.9rem;
		font-size: 1rem;
		font-weight: 600;
		opacity: 1;
		background-color: color-mix(in srgb, var(--button-bg) 12%, transparent);
		box-shadow: 0 4px 16px -8px color-mix(in srgb, var(--button-bg) 50%, transparent);
	}

	.step-label {
		font-size: inherit;
		transition: font-size 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	/* Grow icons with width/height — don't touch `transform` or the
	   Loader2 spin animation breaks. */
	.step-row-active :global(svg) {
		width: 1.15rem;
		height: 1.15rem;
		transition:
			width 360ms cubic-bezier(0.34, 1.56, 0.64, 1),
			height 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
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

	.error-box {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		border: 1px solid var(--error-text-color);
		color: var(--error-text-color);
	}

	.warning-box {
		background-color: var(--warning-bg);
		border: 1px solid var(--warning-border);
		color: var(--warning-text);
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
</style>
