<script lang="ts">
	import { Boxes, Maximize2, Minimize2, Pause, Play, SquareTerminal, X } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Menu, MenuItem, LogViewer, SelectTrigger } from '$lib/components/ui';
	import UsageCard from './UsageCard.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import ErrorsCard from './ErrorsCard.svelte';
	import PodsList from './PodsList.svelte';
	import { UsageHistory } from './usage-history.svelte';
	import { animate } from 'motion';
	import { decorativeMotion } from '$lib/utils/motion.svelte';
	import { PodLogSource } from '$lib/utils/log-sources.svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import TerminalSettings from '$lib/components/TerminalSettings.svelte';
	import type { Pod, TerminalTabInfo } from '$lib/types/deployment';
	import { replicaDrift } from './deployment-helpers';

	let {
		deployment,
		activePods,
		resourcePressure,
		selectedPod = $bindable(),
		selectedContainer = $bindable(),
		scaleReplicas = $bindable(),
		consoleExpanded,
		consoleAnimating,
		consoleVisible = true,
		consoleRef = $bindable(),
		consoleInlineRect,
		scaling,
		deletingPod,
		activeConsoleTab = $bindable(),
		terminalTabs = $bindable(),
		onScaleDeployment,
		onScaleChange,
		onDeletePod,
		onToggleConsoleExpand,
		onOpenShell,
		onCloseTerminalTab,
		onTerminalTitle,
		onTerminalBell,
		onTerminalSession,
		onSelectLogsPod,
		onSetTabMetrics,
		onRefreshPods,
		podVersions = [],
		podLabel
	}: {
		deployment: any;
		activePods: Pod[];
		resourcePressure: {
			cpuLimit: number | null;
			memLimit: number | null;
			cpuRatio: number | null;
			memRatio: number | null;
		};
		selectedPod: string;
		selectedContainer: string;
		scaleReplicas: number;
		consoleExpanded: boolean;
		consoleAnimating: boolean;
		consoleVisible?: boolean;
		consoleRef: HTMLDivElement | null;
		consoleInlineRect: { top: number; left: number; width: number; height: number } | null;
		scaling: boolean;
		deletingPod: string | null;
		activeConsoleTab: string;
		terminalTabs: TerminalTabInfo[];
		onScaleDeployment: () => void;
		onScaleChange: (value: number) => void;
		onDeletePod: (podName: string) => void;
		onToggleConsoleExpand: () => void;
		onOpenShell: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onTerminalTitle?: (id: string, title: string) => void;
		onTerminalBell?: (id: string) => void;
		onTerminalSession?: (id: string, handle: string) => void;
		onSelectLogsPod: (podName: string, containerName?: string) => void;
		onSetTabMetrics: (view?: 'metrics' | 'errors') => void;
		onRefreshPods: () => void;
		podVersions?: import('./health').ClassifiedPod[];
		podLabel: (podName: string) => string;
	} = $props();

	const usage = new UsageHistory();

	$effect(() => {
		const id = deployment?.id;
		if (id) untrack(() => usage.load(id));
	});

	$effect(() => {
		const cpu = deployment?.totalCpuUsage;
		const mem = deployment?.totalMemoryUsage;
		untrack(() => usage.push(cpu, mem));
	});

	const drift = $derived(deployment ? replicaDrift(deployment) : null);

	let showPreviousLogs = $state(false);
	let logsPaused = $state(false);
	let logStream = $state<'live' | 'down'>('live');
	let logStreamAttempt = $state(0);
	let visibility = $state<DocumentVisibilityState>('visible');
	let logsScrolledUp = $state(false);

	const logSource = new PodLogSource({
		podName: () => selectedPod,
		namespace: () => deployment?.namespace ?? 'default',
		container: () => selectedContainer,
		previous: () => showPreviousLogs
	});

	let crashLogsFor: string | null = null;

	$effect(() => {
		const pod = selectedPod;
		const container = selectedContainer;
		if (!pod || !container) return;
		const wantsCrash = crashLogsFor === `${pod}/${container}`;
		crashLogsFor = null;
		untrack(() => {
			showPreviousLogs = wantsCrash;
			logsScrolledUp = false;
			logSource.clear();
			logSource.refresh();
		});
	});

	$effect(() => {
		logStreamAttempt;
		const id = deployment?.id;
		const pod = selectedPod;
		const following =
			!logsPaused && !showPreviousLogs && activeConsoleTab === 'logs' && visibility === 'visible';
		if (!following || !id || !pod || !selectedContainer) return;
		let wake: ReturnType<typeof setTimeout> | null = null;
		let down: ReturnType<typeof setTimeout> | null = null;
		const markDown = () => {
			down ??= setTimeout(() => (logStream = 'down'), 4_000);
		};
		markDown();
		const es = new EventSource(
			`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/stream?tailLines=1`
		);
		es.onopen = () => {
			if (down) clearTimeout(down);
			down = null;
			logStream = 'live';
			untrack(() => logSource.refresh(true));
		};
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) logStream = 'down';
			else markDown();
		};
		es.onmessage = (e) => {
			if (wake) return;
			try {
				const data = JSON.parse(e.data);
				const lines: { pod?: string }[] = data.lines ?? [];
				if (!lines.some((l) => !l.pod || l.pod === pod)) return;
			} catch {
				return;
			}
			wake = setTimeout(() => {
				wake = null;
				logSource.refresh(true);
			}, 300);
		};
		return () => {
			es.close();
			if (wake) clearTimeout(wake);
			if (down) clearTimeout(down);
			logStream = 'live';
		};
	});

	const sourceLabel = $derived(
		selectedPod
			? `${podLabel(selectedPod)}${selectedContainer ? ` / ${selectedContainer}` : ''}`
			: null
	);

	const shellCombos = $derived(
		((deployment.pods ?? []) as Pod[]).flatMap((pod) =>
			(pod.containers ?? []).map((c) => ({ podName: pod.name, container: c.name }))
		)
	);

	function revealConsole() {
		const el = consoleRef;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const offscreen = r.top < 0 || r.bottom > window.innerHeight;
		if (offscreen) {
			el.scrollIntoView({
				behavior: decorativeMotion() ? 'smooth' : 'auto',
				block: 'nearest'
			});
		}
		if (!decorativeMotion()) return;
		animate(el, { '--console-flash': [0, 1, 0] }, { duration: 1.1, ease: 'easeOut' });
	}

	function openCurrentLogs(pod: Pod, containerName?: string) {
		const container = containerName ?? pod.containers?.[0]?.name ?? selectedContainer;
		crashLogsFor = null;
		activeConsoleTab = 'logs';
		onSelectLogsPod(pod.name, container);
		showPreviousLogs = false;
		logSource.resetPagination();
		logSource.refresh();
		revealConsole();
	}

	function openCrashLogs(pod: Pod, containerName?: string) {
		const crashed = (pod.containers ?? []).find(
			(c) => c.lastTermination?.reason || (c.restartCount ?? 0) > 0
		);
		const container =
			containerName ?? crashed?.name ?? pod.containers?.[0]?.name ?? selectedContainer;
		crashLogsFor = `${pod.name}/${container}`;
		activeConsoleTab = 'logs';
		selectedPod = pod.name;
		selectedContainer = container;
		showPreviousLogs = true;
		logSource.resetPagination();
		logSource.refresh();
		revealConsole();
	}
</script>

<svelte:document bind:visibilityState={visibility} />

<div class="overview-board">
	<div class="main">
		<div
			bind:this={consoleRef}
			class="console-panel"
			class:console-expanded={consoleExpanded}
			class:console-animating={consoleAnimating}
			class:console-at-fullscreen={consoleExpanded}
			style={consoleInlineRect && !consoleExpanded
				? `top:${consoleInlineRect.top}px;left:${consoleInlineRect.left}px;width:${consoleInlineRect.width}px;height:${consoleInlineRect.height}px;`
				: ''}
		>
			<div class="bar">
				<div class="sessions" role="tablist" aria-label="Console">
					<button
						type="button"
						role="tab"
						class="session"
						aria-selected={activeConsoleTab === 'logs'}
						onclick={() => (activeConsoleTab = 'logs')}>Logs</button
					>
					{#each terminalTabs as ttab (ttab.id)}
						<span
							class="session session--term"
							class:session--bell={ttab.bell && activeConsoleTab !== ttab.id}
						>
							<button
								type="button"
								role="tab"
								class="session-hit"
								aria-selected={activeConsoleTab === ttab.id}
								title={ttab.title || ttab.label}
								onclick={() => {
									ttab.bell = false;
									activeConsoleTab = ttab.id;
								}}
							>
								<SquareTerminal size={13} aria-hidden="true" />
								<span class="session-title">{ttab.title || ttab.label}</span>
							</button>
							<button
								type="button"
								class="session-close"
								aria-label="Close {ttab.title || ttab.label}"
								onclick={() => onCloseTerminalTab(ttab.id)}
							>
								<X size={12} />
							</button>
						</span>
					{/each}
				</div>

				<div class="tools">
					{#if activeConsoleTab === 'logs'}
						<Menu placement="bottom-end">
							{#snippet trigger(attrs, isOpen)}
								<SelectTrigger
									{...attrs}
									open={isOpen}
									size="sm"
									mono
									value={sourceLabel}
									placeholder="Pick a pod"
								/>
							{/snippet}
							{#each deployment.pods ?? [] as pod (pod.name)}
								{#each pod.containers ?? [] as cont (cont.name)}
									{@const here = selectedPod === pod.name && selectedContainer === cont.name}
									{@const crashed = !!cont.lastTermination?.reason || (cont.restartCount ?? 0) > 0}
									<MenuItem
										icon={Boxes}
										checked={here && !showPreviousLogs}
										onclick={() => openCurrentLogs(pod, cont.name)}
									>
										{podLabel(pod.name)} / {cont.name}
									</MenuItem>
									{#if crashed}
										<MenuItem
											icon={SquareTerminal}
											checked={here && showPreviousLogs}
											description="Output from before the last crash"
											onclick={() => openCrashLogs(pod, cont.name)}
										>
											{podLabel(pod.name)} / {cont.name}
										</MenuItem>
									{/if}
								{/each}
							{/each}
						</Menu>
						{#if !showPreviousLogs}
							<Button
								variant="ghost"
								size="sm"
								icon={logsPaused ? Play : Pause}
								label={logsPaused ? 'Resume logs' : 'Pause logs'}
								onclick={() => (logsPaused = !logsPaused)}
							/>
						{/if}
					{/if}

					<Menu placement="bottom-end">
						{#snippet trigger(attrs)}
							<Button
								{...attrs}
								variant="secondary"
								size="sm"
								icon={SquareTerminal}
								disabled={shellCombos.length === 0}
								onclick={(e: MouseEvent) => {
									if (shellCombos.length === 1) {
										onOpenShell(shellCombos[0].podName, shellCombos[0].container);
										return;
									}
									(attrs as { onclick?: (e: Event) => void }).onclick?.(e);
								}}>Shell</Button
							>
						{/snippet}
						{#each shellCombos as combo (`${combo.podName}/${combo.container}`)}
							<MenuItem
								icon={SquareTerminal}
								onclick={() => onOpenShell(combo.podName, combo.container)}
							>
								{podLabel(combo.podName)} / {combo.container}
							</MenuItem>
						{/each}
					</Menu>

					<TerminalSettings />

					<Button
						variant="ghost"
						size="sm"
						icon={consoleExpanded ? Minimize2 : Maximize2}
						label={consoleExpanded ? 'Collapse console' : 'Expand console'}
						onclick={onToggleConsoleExpand}
					/>
				</div>
			</div>

			<div class="console-body">
				{#if activeConsoleTab === 'logs'}
					<div class="logs">
						<LogViewer
							lines={logSource.lines}
							loading={logSource.loading}
							loadingMore={logSource.loadingMore}
							error={logSource.error}
							atStart={logSource.atStart}
							bind:scrolledUp={logsScrolledUp}
							onLoadEarlier={() => logSource.loadEarlier()}
						>
							{#snippet empty()}
								<div class="console-empty">
									<SquareTerminal size={16} aria-hidden="true" />
									<span>{selectedPod ? 'No output yet' : 'Pick a pod to read its logs'}</span>
								</div>
							{/snippet}
						</LogViewer>
						{#if selectedPod && !showPreviousLogs && (logsPaused || logStream === 'down')}
							<div class="logs-notice" role="status">
								{#if logsPaused}
									<StatusDot meta={statusMeta('neutral', 'Paused')} size={8} />
									<span>Paused</span>
									<Button variant="secondary" size="sm" onclick={() => (logsPaused = false)}
										>Resume</Button
									>
								{:else}
									<StatusDot meta={statusMeta('warning', 'Reconnecting', true)} size={8} />
									<span>Logs aren't updating</span>
									<Button variant="secondary" size="sm" onclick={() => logStreamAttempt++}
										>Retry</Button
									>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
				{#each terminalTabs as ttab (ttab.id)}
					<PodTerminal
						podName={ttab.podName}
						namespace={deployment.namespace || 'default'}
						container={ttab.container}
						visible={consoleVisible && activeConsoleTab === ttab.id}
						resizeFrozen={consoleAnimating}
						sessionHandle={ttab.sessionHandle}
						onTitle={(title) => onTerminalTitle?.(ttab.id, title)}
						onBell={() => onTerminalBell?.(ttab.id)}
						onSession={(handle) => onTerminalSession?.(ttab.id, handle)}
					/>
				{/each}
			</div>
		</div>
	</div>

	<div class="side">
		<PodsList
			versions={podVersions}
			deploymentId={deployment.id}
			pods={activePods}
			warnings={deployment.warnings ?? []}
			replicas={deployment.replicas ?? 0}
			bind:scaleReplicas
			{scaling}
			{drift}
			{selectedPod}
			{podLabel}
			podHref={(name) =>
				`/${$page.params.orgSlug}/pods/${name}?namespace=${deployment?.namespace ?? 'default'}`}
			onScale={onScaleDeployment}
			onChange={onScaleChange}
			onSelect={(pod) => openCurrentLogs(pod)}
			onCrashLogs={(pod) => openCrashLogs(pod)}
			onShell={onOpenShell}
			onDelete={onDeletePod}
			onSimulated={onRefreshPods}
		/>
		<UsageCard
			cpu={deployment.totalCpuUsage}
			mem={deployment.totalMemoryUsage}
			cpuLimit={resourcePressure?.cpuLimit ?? null}
			memLimit={resourcePressure?.memLimit ?? null}
			cpuRatio={resourcePressure?.cpuRatio ?? null}
			memRatio={resourcePressure?.memRatio ?? null}
			history={usage}
			onopen={() => onSetTabMetrics('metrics')}
		/>
		<ErrorsCard deploymentId={deployment.id} onopen={() => onSetTabMetrics('errors')} />
	</div>
</div>

<style>
	.overview-board {
		display: grid;
		grid-template-columns: minmax(0, 1.618fr) minmax(21rem, 1fr);
		gap: 1rem;
		height: 100%;
		min-height: 0;
	}
	.main {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		min-height: 0;
	}
	.main > .console-panel {
		flex: 1 1 0;
		height: auto;
		min-height: 14rem;
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		overflow: clip;
	}
	.main > .console-panel.console-at-fullscreen {
		border-radius: 0;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		min-height: 0;
		margin: -2px;
		padding: 2px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.side > :global(.pods) {
		flex: 0 1 auto;
		min-height: min(100%, 12.25rem);
	}
	@media (max-height: 49rem) {
		.side > :global(.pods) {
			min-height: min(100%, 9rem);
		}
	}
	.side > :global(.usage-card) {
		flex: 0 0 auto;
	}
	.side > :global(.errors) {
		flex: 1 1 0;
		min-height: 3.5rem;
		container: errors / size;
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.5rem;
		border-bottom: 1px solid var(--console-edge);
	}
	.sessions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		margin-block: -0.25rem;
		padding-block: 0.25rem;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.session {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 1.75rem;
		padding: 0 0.75rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--console-dim);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}
	.session:hover,
	.session--term:has(.session-hit:hover) {
		background: var(--console-hover);
		color: var(--console-text);
	}
	.session[aria-selected='true'],
	.session--term:has([aria-selected='true']) {
		background: var(--bg-surface);
		color: var(--console-text);
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
	.session--term {
		gap: 0.125rem;
		padding: 0 0.25rem 0 0.75rem;
	}
	.session--bell .session-hit {
		color: var(--status-warning);
	}
	.session-hit {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 12rem;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.session-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.session-close {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border: none;
		border-radius: 50%;
		background: none;
		color: var(--console-faint);
		cursor: pointer;
	}
	.session-close:hover {
		background: var(--console-hover);
		color: var(--console-text);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}
	.bar :global(:is(.button, .trigger)) {
		border-radius: 999px;
		corner-shape: round;
	}
	.bar :global(.trigger--sm) {
		padding-inline: 0.75rem 0.5rem;
	}
	.logs {
		position: relative;
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}
	.logs-notice {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.25rem 0.25rem 0.875rem;
		border-radius: 999px;
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			var(--shadow-raised);
		color: var(--text-default);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		translate: -50% 0;
	}
	.logs-notice :global(.button) {
		border-radius: 999px;
		corner-shape: round;
	}
	.console-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--console-faint);
		font-size: var(--text-callout);
	}
	@media (max-width: 64rem) {
		.overview-board {
			grid-template-columns: minmax(0, 1fr);
			height: auto;
		}
		.main > .console-panel {
			flex: none;
			height: 32rem;
		}
	}
</style>
