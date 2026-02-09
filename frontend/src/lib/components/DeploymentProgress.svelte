<script lang="ts">
	import { Progress } from 'melt/builders';
	import { Loader2, Check, X, ChevronDown, ChevronUp, Github, Container } from 'lucide-svelte';

	interface Props {
		status: string;
		buildStep?: string | null;
		buildLogs?: string | null;
		buildError?: string | null;
		isGitHubDeploy: boolean;
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
	}

	let { status, buildStep, buildLogs, buildError, isGitHubDeploy, warnings }: Props = $props();

	let showLogs = $state(true); // Default to showing logs
	let logsPanel: HTMLDivElement | undefined = $state();
	let previousLogsLength = $state(0);
	let stepStartTimes = $state<Map<string, number>>(new Map());
	let currentTime = $state(Date.now());
	let previousBuildStep = $state<string | null | undefined>(null);

	// Track step start times - extract from logs first, then track new steps
	$effect(() => {
		if (buildLogs) {
			// Extract start times from logs for all steps
			const stepsToCheck = ['cloning', 'building', 'pushing', 'deploying'];
			for (const stepId of stepsToCheck) {
				const logStartTime = getStepStartTimeFromLogs(stepId);
				if (logStartTime && !stepStartTimes.has(stepId)) {
					stepStartTimes.set(stepId, logStartTime);
				}
			}
		}

		// For current step, ensure we have a start time
		if (buildStep) {
			const stepId = buildStep;
			if (!stepStartTimes.has(stepId)) {
				// If we couldn't find it in logs, use current time as fallback
				stepStartTimes.set(stepId, Date.now());
			}
			previousBuildStep = stepId;
		}
	});

	// Update current time every second to update elapsed time display
	$effect(() => {
		const interval = setInterval(() => {
			currentTime = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	// Auto-scroll to bottom when new logs arrive
	$effect(() => {
		if (buildLogs && logsPanel && buildLogs.length > previousLogsLength) {
			// Use setTimeout to ensure DOM has updated
			setTimeout(() => {
				if (logsPanel) {
					logsPanel.scrollTop = logsPanel.scrollHeight;
				}
			}, 0);
		}
		previousLogsLength = buildLogs?.length ?? 0;
	});

	// Define steps for GitHub deployments
	const githubSteps = [
		{ id: 'cloning', label: 'Cloning repository', description: 'Fetching source code from GitHub' },
		{ id: 'building', label: 'Building image', description: 'Creating Docker image' },
		{ id: 'pushing', label: 'Pushing image', description: 'Uploading to container registry' },
		{ id: 'deploying', label: 'Creating deployment', description: 'Setting up Kubernetes resources' },
		{ id: 'complete', label: 'Done', description: 'Deployment is ready' }
	];

	// Define steps for image-based deployments
	const imageSteps = [
		{ id: 'deploying', label: 'Creating deployment', description: 'Setting up Kubernetes resources' },
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
		if (status === 'failed') {
			if (index < currentStepIndex) return 'completed';
			if (index === currentStepIndex) return 'error';
			return 'pending';
		}
		if (index < currentStepIndex) return 'completed';
		if (index === currentStepIndex) return 'current';
		return 'pending';
	}

	function getStepStartTimeFromLogs(stepId: string): number | null {
		if (!buildLogs) return null;
		
		const stepStartPatterns: Record<string, RegExp> = {
			cloning: /\[INFO\] Cloning repository/i,
			building: /\[INFO\] Building image/i,
			pushing: /\[INFO\] Pushing image to/i,
			deploying: /\[INFO\] Creating Kubernetes deployment/i
		};

		const pattern = stepStartPatterns[stepId];
		if (!pattern) return null;

		const lines = buildLogs.split('\n');
		for (const line of lines) {
			if (pattern.test(line)) {
				// Extract timestamp from log line: [timestamp] [LEVEL] message
				const timestampMatch = line.match(/^\[(\d+)\]/);
				if (timestampMatch && timestampMatch[1]) {
					return parseInt(timestampMatch[1], 10);
				}
			}
		}

		return null;
	}

	function extractStepDuration(stepId: string): string | null {
		if (!buildLogs) return null;
		
		// First try to extract from completion messages with explicit durations
		const stepPatterns: Record<string, RegExp[]> = {
			cloning: [
				/\[INFO\] Repository cloned successfully in ([\d.]+)s/i,
				/\[ERROR\] Failed to clone repository.*?took ([\d.]+)s/i
			],
			building: [
				/\[INFO\] Successfully built image:.*?\(took ([\d.]+)s\)/i,
				/\[ERROR\] Docker build failed.*?\(took ([\d.]+)s\)/i
			],
			pushing: [
				/\[INFO\] Successfully pushed image:.*?\(took ([\d.]+)s\)/i,
				/\[ERROR\] Docker push failed.*?\(took ([\d.]+)s\)/i
			]
		};

		const patterns = stepPatterns[stepId];
		if (patterns) {
			for (const pattern of patterns) {
				const match = buildLogs.match(pattern);
				if (match && match[1]) {
					const seconds = parseFloat(match[1]);
					return formatDuration(seconds);
				}
			}
		}

		// If no explicit duration found, calculate from start to end timestamps
		const startTime = getStepStartTimeFromLogs(stepId);
		if (!startTime) return null;

		const stepEndPatterns: Record<string, RegExp> = {
			cloning: /\[(INFO|ERROR)\] Repository cloned|Failed to clone repository/i,
			building: /\[(INFO|ERROR)\] Successfully built image|Docker build failed/i,
			pushing: /\[(INFO|ERROR)\] Successfully pushed image|Docker push failed/i,
			deploying: /\[(INFO|ERROR)\] Deployment created|Failed to create deployment/i
		};

		const endPattern = stepEndPatterns[stepId];
		if (!endPattern) return null;

		const lines = buildLogs.split('\n');
		let endTime: number | null = null;

		for (const line of lines) {
			if (endPattern.test(line)) {
				const timestampMatch = line.match(/^\[(\d+)\]/);
				if (timestampMatch && timestampMatch[1]) {
					endTime = parseInt(timestampMatch[1], 10);
					break;
				}
			}
		}

		if (endTime) {
			const duration = (endTime - startTime) / 1000;
			return formatDuration(duration);
		}

		return null;
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

	// Progress percentage
	const progressValue = $derived(() => {
		if (status === 'running' || status === 'warning' || status === 'stopped' || buildStep === 'complete') return 100;
		if (status === 'failed') return ((currentStepIndex + 1) / steps.length) * 100;
		if (currentStepIndex < 0) return 0;
		return ((currentStepIndex + 0.5) / steps.length) * 100;
	});

	const progress = new Progress({
		value: () => progressValue()
	});
</script>

<div class="deployment-progress">
	<div class="mb-6">
		<div class="flex items-center justify-between mb-2">
			<div class="flex items-center gap-2">
				{#if isGitHubDeploy}
					<Github class="h-5 w-5 icon-muted" />
				{:else}
					<Container class="h-5 w-5 icon-muted" />
				{/if}
				<span class="text-sm font-medium">
					{#if status === 'building'}
						Building deployment..
					{:else if status === 'pending'}
						Provisioning...
					{:else if status === 'failed'}
						Deployment failed
					{:else if status === 'warning'}
						Deployment has warnings
					{:else if status === 'stopped'}
						Deployment stopped
					{:else}
						Deployment ready
					{/if}
				</span>
			</div>
			<span class="text-sm muted-text">{Math.round(progressValue())}%</span>
		</div>

		<div
			{...progress.root}
			class="progress-track relative h-2 w-full overflow-hidden rounded-full"
		>
			<div
				{...progress.progress}
				class="h-full transition-all duration-500 ease-out {status === 'failed' || status === 'stopped'
					? 'bg-red-500'
					: status === 'warning'
					? 'bg-amber-500'
					: 'bg-primary-500'}"
				style="width: {progressValue()}%"
			></div>
		</div>
	</div>

	<div class="space-y-1">
		{#each steps as step, index}
			{@const stepStatus = getStepStatus(index)}
			<div
				class="step-item flex items-start gap-3 rounded-lg px-3 py-2 transition-colors"
				class:step-current={stepStatus === 'current'}
				class:step-error={stepStatus === 'error'}
			>
				<div class="mt-0.5">
					{#if stepStatus === 'completed'}
						<div class="flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
							<Check class="h-3 w-3 text-white" />
						</div>
					{:else if stepStatus === 'current'}
						<div class="flex h-5 w-5 items-center justify-center">
							<Loader2 class="h-5 w-5 animate-spin text-primary-500" />
						</div>
					{:else if stepStatus === 'error'}
						<div class="flex h-5 w-5 items-center justify-center rounded-full bg-red-500">
							<X class="h-3 w-3 text-white" />
						</div>
					{:else}
						<div class="step-pending h-5 w-5 rounded-full border-2"></div>
					{/if}
				</div>
				<div class="flex-1 min-w-0">
					<div class="flex items-center justify-between gap-2">
						<p
							class="text-sm font-medium"
							class:text-primary-600={stepStatus === 'current'}
							class:text-red-600={stepStatus === 'error'}
							class:step-text-completed={stepStatus === 'completed'}
							class:step-text-pending={stepStatus === 'pending'}
						>
							{step.label}
						</p>
						{#if stepStatus === 'completed'}
							{@const duration = extractStepDuration(step.id)}
							{#if duration}
								<span class="step-duration text-xs font-mono muted-text">{duration}</span>
							{:else}
								{@const startTime = stepStartTimes.get(step.id) || getStepStartTimeFromLogs(step.id)}
								{#if startTime}
									{@const nextStepIndex = index + 1}
									{@const nextStepStartTime = nextStepIndex < steps.length ? (stepStartTimes.get(steps[nextStepIndex].id) || getStepStartTimeFromLogs(steps[nextStepIndex].id)) : null}
									{#if nextStepStartTime}
										{@const duration = Math.floor((nextStepStartTime - startTime) / 1000)}
										<span class="step-duration text-xs font-mono muted-text">{formatDuration(duration)}</span>
									{/if}
								{/if}
							{/if}
						{:else if stepStatus === 'current' && buildStep === step.id}
							{@const startTime = stepStartTimes.get(step.id) || getStepStartTimeFromLogs(step.id) || Date.now()}
							{@const elapsed = Math.max(0, Math.floor((currentTime - startTime) / 1000))}
							<span class="step-duration text-xs font-mono text-primary-600">{formatDuration(elapsed)}</span>
						{/if}
					</div>
					<p
						class="text-xs"
						class:muted-text={stepStatus === 'current' || stepStatus === 'completed'}
						class:step-text-pending={stepStatus === 'pending'}
					>
						{step.description}
					</p>
				</div>
			</div>
		{/each}
	</div>

	{#if buildError && status === 'failed'}
		<div class="error-box mt-4 rounded-lg p-4">
			<p class="text-sm font-medium">Error</p>
			<p class="mt-1 text-sm font-mono whitespace-pre-wrap">
				{buildError}
			</p>
		</div>
	{/if}

	{#if warnings?.length && (status === 'running' || status === 'warning' || status === 'stopped')}
		<div class="warning-box mt-4 rounded-lg p-4">
			<div class="flex items-start gap-2 mb-2">
				<svg class="h-5 w-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
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
					{status === 'failed' ? 'Hide last build logs' : 'Hide logs'}
				{:else}
					<ChevronDown class="h-4 w-4" />
					{status === 'failed' ? 'Show last build logs' : 'Show logs'}
				{/if}
			</button>

			{#if showLogs}
				<div
					bind:this={logsPanel}
					class="logs-panel mt-2 max-h-80 overflow-y-auto rounded-lg p-4 text-xs font-mono"
				>
					{#each (buildLogs?.split('\n').filter(l => l.trim()) || []) as line}
						{@const match = line.match(/^\[(\d+)\]\s*\[(INFO|ERROR|WARNING)\]\s*(.+)$/)}
						{#if match}
							{@const [_, timestamp, level, message] = match}
							<div class="log-line mb-1" class:log-info={level === 'INFO'} class:log-error={level === 'ERROR'} class:log-warning={level === 'WARNING'}>
								<span class="log-level log-level-{level.toLowerCase()}">{level}</span>
								<span class="log-message">{message}</span>
							</div>
						{:else}
							{@const oldMatch = line.match(/^\[(INFO|ERROR|WARNING)\]\s*(.+)$/)}
							{#if oldMatch}
								{@const [_, level, message] = oldMatch}
								<div class="log-line mb-1" class:log-info={level === 'INFO'} class:log-error={level === 'ERROR'} class:log-warning={level === 'WARNING'}>
									<span class="log-level log-level-{level.toLowerCase()}">{level}</span>
									<span class="log-message">{message}</span>
								</div>
							{:else}
								<div class="log-line mb-1 log-info">
									<span class="log-message">{line}</span>
								</div>
							{/if}
						{/if}
					{/each}
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

	.progress-track {
		background-color: var(--surface-border);
	}

	.step-item {
		background-color: transparent;
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
		background-color: rgba(245, 158, 11, 0.1);
		border: 1px solid rgba(245, 158, 11, 0.3);
		color: rgb(245, 158, 11);
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
	}

	.log-line {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		line-height: 1.5;
		padding: 0.25rem 0;
	}

	.log-level {
		flex-shrink: 0;
		font-weight: 600;
		padding: 0.125rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.log-level-info {
		background-color: rgba(59, 130, 246, 0.15);
		color: rgb(59, 130, 246);
	}

	.log-level-error {
		background-color: rgba(239, 68, 68, 0.15);
		color: rgb(239, 68, 68);
	}

	.log-level-warning {
		background-color: rgba(245, 158, 11, 0.15);
		color: rgb(245, 158, 11);
	}

	.log-message {
		flex: 1;
		color: var(--center-channel-color);
		word-break: break-word;
	}

	.log-error .log-message {
		color: rgb(239, 68, 68);
	}

	.log-warning .log-message {
		color: rgb(245, 158, 11);
	}

	.step-duration {
		white-space: nowrap;
		opacity: 0.8;
	}
</style>
