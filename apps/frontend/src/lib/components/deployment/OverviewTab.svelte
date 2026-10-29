<script lang="ts">
	import { Boxes, Maximize2, Minimize2, RefreshCw, SquareTerminal, X } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Menu, MenuItem, LogViewer, SelectTrigger } from '$lib/components/ui';
	import UsageCard from './UsageCard.svelte';
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
	let liveLogs = $state(false);
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
		if (!liveLogs || activeConsoleTab !== 'logs') return;
		if (!selectedPod || !selectedContainer) return;
		logSource.refresh(true);
		const handle = setInterval(() => {
			if (document.hidden) return;
			logSource.refresh(true);
		}, 2000);
		return () => clearInterval(handle);
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

<div class="overview-board">
	<div class="main">
		<div
			bind:this={consoleRef}
			class="console-panel"
			class:console-expanded={consoleExpanded || consoleAnimating}
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
						<Button
							variant="ghost"
							size="sm"
							icon={RefreshCw}
							label="Refresh logs"
							loading={logSource.loading}
							onclick={() => logSource.refresh()}
						/>
						<button
							type="button"
							class="live"
							class:live--on={liveLogs}
							aria-pressed={liveLogs}
							title={liveLogs ? 'Stop following new logs' : 'Follow new logs as they arrive'}
							onclick={() => (liveLogs = !liveLogs)}
						>
							<span class="live-dot" aria-hidden="true"></span>Live
						</button>
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
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.375rem 0.5rem 0.375rem 0.375rem;
		border-bottom: 1px solid var(--console-edge);
	}
	.sessions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.session {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 1.75rem;
		padding: 0 0.625rem;
		border: none;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
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
			0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
	.session--term {
		gap: 0.125rem;
		padding: 0 0.25rem 0 0.5rem;
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
		border-radius: calc(0.3125rem * var(--corner-scale));
		corner-shape: var(--corner);
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
	.live {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 1.75rem;
		padding: 0 0.625rem;
		border: none;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: transparent;
		color: var(--console-dim);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}
	.live:hover {
		background: var(--console-hover);
		color: var(--console-text);
	}
	.live-dot {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--console-faint);
	}
	.live--on {
		background: var(--status-success-bg);
		color: var(--status-success);
	}
	.live--on .live-dot {
		background: var(--status-success);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--status-success) 22%, transparent);
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
