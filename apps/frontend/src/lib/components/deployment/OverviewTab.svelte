<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Loader2, MemoryStick } from 'lucide-svelte';
	import {
		Activity,
		Boxes,
		ChevronDown,
		Cpu,
		Maximize2,
		Minimize2,
		RefreshCw,
		Terminal,
		Trash2,
		X
	} from '@jis3r/icons';
	import { untrack } from 'svelte';
	import { page } from '$app/stores';
	import { SquareArrowOutUpRight } from 'lucide-svelte';
	import { formatCpu, formatMemory, formatRelativeTime, explainExitCode } from '$lib/utils/format';
	import {
		Button,
		Menu,
		MenuItem,
		StatusDot,
		StatusBadge,
		podStatus,
		LogViewer
	} from '$lib/components/ui';
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
		isDragging,
		sliderRef = $bindable(),
		sliderPercentage,
		scaling,
		deletingPod,
		activeConsoleTab = $bindable(),
		terminalTabs = $bindable(),
		onScaleDeployment,
		onDeletePod,
		onToggleConsoleExpand,
		onOpenShell,
		onCloseTerminalTab,
		onTerminalTitle,
		onTerminalBell,
		onTerminalSession,
		onSelectLogsPod,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onTrackClick,
		onSetTabMetrics,
		onKeydownSlider,
		podLabel,
		aside = undefined
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
		isDragging: boolean;
		sliderRef: HTMLDivElement | null;
		sliderPercentage: number;
		scaling: boolean;
		deletingPod: string | null;
		activeConsoleTab: string;
		terminalTabs: TerminalTabInfo[];
		onScaleDeployment: () => void;
		onDeletePod: (podName: string) => void;
		onToggleConsoleExpand: () => void;
		onOpenShell: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onTerminalTitle?: (id: string, title: string) => void;
		onTerminalBell?: (id: string) => void;
		onTerminalSession?: (id: string, handle: string) => void;
		onSelectLogsPod: (podName: string, containerName?: string) => void;
		onPointerDown: (e: PointerEvent) => void;
		onPointerMove: (e: PointerEvent) => void;
		onPointerUp: (e: PointerEvent) => void;
		onPointerCancel: (e: PointerEvent) => void;
		onTrackClick: (e: MouseEvent) => void;
		onSetTabMetrics: () => void;
		onKeydownSlider: (e: KeyboardEvent) => void;
		podLabel: (podName: string) => string;
		aside?: Snippet;
	} = $props();

	function meterFor(ratio: number | null | undefined) {
		if (ratio == null) return null;
		const pct = Math.min(Math.max(ratio, 0), 1) * 100;
		return {
			pct,
			level: ratio >= 0.95 ? 'error' : ratio >= 0.85 ? 'warning' : 'normal'
		};
	}

	const cpuMeter = $derived(meterFor(resourcePressure?.cpuRatio));
	const memMeter = $derived(meterFor(resourcePressure?.memRatio));
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

	const shellCombos = $derived(
		((deployment.pods ?? []) as Pod[]).flatMap((pod) =>
			(pod.containers ?? []).map((c) => ({ podName: pod.name, container: c.name }))
		)
	);

	function podTermination(pod: Pod): { reason: string; exitCode?: number | null } | null {
		for (const c of pod.containers ?? []) {
			if (c.lastTermination?.reason && c.lastTermination.reason !== 'Completed') {
				return { reason: c.lastTermination.reason, exitCode: c.lastTermination.exitCode };
			}
		}
		return null;
	}

	function selectPod(pod: Pod) {
		selectedPod = pod.name;
		if (pod.containers?.length) selectedContainer = pod.containers[0].name;
	}

	function restartPhrase(restarts: number, exitCode?: number | null) {
		const after = exitCode != null ? ` after exit ${exitCode}` : '';
		if (restarts === 0) return `Crashed once${after}`;
		if (restarts === 1) return `Restarted once${after}`;
		return `Restarted ${restarts} times${after}`;
	}

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

{#snippet podHead(pod: Pod, meta: ReturnType<typeof podStatus>)}
	<span class="pod-item-top">
		<StatusDot {meta} size={6} />
		<span class="pod-item-name">{podLabel(pod.name)}</span>
		{#if pod.startTime}
			<span class="pod-item-age">{formatRelativeTime(new Date(pod.startTime))}</span>
		{/if}
	</span>
	<span class="pod-item-sub">
		<span class="pod-item-status status--{meta.kind}">{meta.label}</span>
	</span>
{/snippet}

<div class="grid gap-5 items-stretch overview-grid">
	<!-- Left: Console (hero) -->
	<div class="flex flex-col gap-5 min-w-0 overview-left">
		<!-- Console / Logs + Terminal -->
		<div
			bind:this={consoleRef}
			class="console-panel"
			class:console-expanded={consoleExpanded || consoleAnimating}
			class:console-animating={consoleAnimating}
			class:console-at-fullscreen={consoleExpanded}
			style={consoleInlineRect && !consoleExpanded
				? `top:${consoleInlineRect.top}px;left:${consoleInlineRect.left}px;width:${consoleInlineRect.width}px;height:${consoleInlineRect.height}px;`
				: consoleInlineRect && consoleExpanded
					? ''
					: ''}
		>
			<!-- Console toolbar -->
			<div class="console-toolbar">
				<div class="console-toolbar-left">
					<!-- Logs tab with source picker -->
					<button
						class="console-btn"
						class:console-btn--active={activeConsoleTab === 'logs'}
						onclick={() => (activeConsoleTab = 'logs')}>Logs</button
					>

					<!-- Terminal tabs -->
					{#each terminalTabs as ttab (ttab.id)}
						<button
							class="console-btn"
							class:console-btn--active={activeConsoleTab === ttab.id}
							class:console-btn--bell={ttab.bell && activeConsoleTab !== ttab.id}
							title={ttab.title || ttab.label}
							onclick={() => {
								ttab.bell = false;
								activeConsoleTab = ttab.id;
							}}
						>
							<span class="console-tab-title">{ttab.title || ttab.label}</span>
							<span
								class="console-tab-close"
								role="button"
								tabindex="-1"
								onclick={(e) => {
									e.stopPropagation();
									onCloseTerminalTab(ttab.id);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.stopPropagation();
										onCloseTerminalTab(ttab.id);
									}
								}}
							>
								<X size={10} />
							</span>
						</button>
					{/each}
				</div>

				<div class="console-toolbar-right">
					{#if activeConsoleTab === 'logs'}
						<Menu placement="bottom-end">
							{#snippet trigger(attrs, _open)}
								<button class="console-btn" {...attrs}>
									<Boxes size={12} class="h-3 w-3 opacity-40" />
									<span class="console-src-label"
										>{podLabel(selectedPod)}{selectedContainer
											? ` / ${selectedContainer}`
											: ''}</span
									>
									{#if showPreviousLogs}
										<span class="console-src-tag">crashed</span>
									{/if}
									<ChevronDown size={10} class="h-2.5 w-2.5 opacity-40" />
								</button>
							{/snippet}
							{#each deployment.pods ?? [] as pod (pod.name)}
								{#each pod.containers ?? [] as cont (cont.name)}
									{@const isCur =
										selectedPod === pod.name &&
										selectedContainer === cont.name &&
										!showPreviousLogs}
									{@const isCrash =
										selectedPod === pod.name && selectedContainer === cont.name && showPreviousLogs}
									{@const crashed = !!cont.lastTermination?.reason || (cont.restartCount ?? 0) > 0}
									<MenuItem onclick={() => openCurrentLogs(pod, cont.name)}>
										<Boxes size={14} class="shrink-0 opacity-40" />
										<span class:font-semibold={isCur}>{podLabel(pod.name)} / {cont.name}</span>
									</MenuItem>
									{#if crashed}
										<MenuItem onclick={() => openCrashLogs(pod, cont.name)}>
											<Terminal size={14} class="shrink-0 opacity-40" />
											<span class:font-semibold={isCrash}
												>{podLabel(pod.name)} / {cont.name}
												<span class="console-src-tag">crashed</span></span
											>
										</MenuItem>
									{/if}
								{/each}
							{/each}
						</Menu>

						<button
							onclick={() => logSource.refresh()}
							disabled={logSource.loading}
							class="console-btn console-btn--icon"
							title="Refresh"
							aria-label="Refresh logs"
						>
							{#if logSource.loading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
									size={14}
									class="h-3.5 w-3.5"
								/>{/if}
						</button>

						<button
							class="console-btn"
							class:console-btn--live={liveLogs}
							onclick={() => (liveLogs = !liveLogs)}
							title={liveLogs ? 'Stop following new logs' : 'Follow new logs as they arrive'}
						>
							{#if liveLogs}
								<span class="console-tail-dot"></span>
							{/if}
							Live
						</button>
					{/if}

					<Menu placement="bottom-end">
						{#snippet trigger(attrs, _open)}
							<button
								class="console-btn console-btn--outline"
								title={shellCombos.length === 0
									? 'No running containers to open a shell in'
									: 'Open shell in pod'}
								disabled={shellCombos.length === 0}
								{...attrs}
								onclick={(e: MouseEvent) => {
									if (shellCombos.length === 0) return;
									if (shellCombos.length === 1) {
										onOpenShell(shellCombos[0].podName, shellCombos[0].container);
										return;
									}
									(attrs as { onclick?: (e: Event) => void }).onclick?.(e);
								}}
							>
								<Terminal size={12} class="h-3 w-3" />
								Shell
							</button>
						{/snippet}
						{#each deployment.pods ?? [] as pod (pod.name)}
							{#each pod.containers ?? [] as cont (cont.name)}
								<MenuItem onclick={() => onOpenShell(pod.name, cont.name)}>
									<Terminal size={14} class="shrink-0 opacity-40" />
									{podLabel(pod.name)} / {cont.name}
								</MenuItem>
							{/each}
						{/each}
					</Menu>

					<TerminalSettings />

					<button
						onclick={onToggleConsoleExpand}
						class="console-btn console-btn--icon"
						title={consoleExpanded ? 'Collapse' : 'Expand'}
						aria-label={consoleExpanded ? 'Collapse console' : 'Expand console'}
					>
						{#if consoleExpanded}<Minimize2 size={14} class="h-3.5 w-3.5" />{:else}<Maximize2
								size={14}
								class="h-3.5 w-3.5"
							/>{/if}
					</button>
				</div>
			</div>

			<!-- Console body -->
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
								<Terminal size={16} class="h-4 w-4 opacity-30" />
								<span>{selectedPod ? 'No output yet' : 'Select a pod to view logs'}</span>
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

	<!-- Right sidebar: stats + scale + pods -->
	<div class="flex flex-col gap-4 overview-right min-h-0">
		{#if aside}{@render aside()}{/if}
		<!-- Resource stats as compact cards. Charts moved to the Metrics tab. -->
		<button
			type="button"
			class="stat-card stat-card--link"
			title="Open metrics"
			onclick={onSetTabMetrics}
		>
			<div class="stat-card-header">
				<Cpu size={14} class="h-3.5 w-3.5" style="color: var(--color-primary-600);" />
				<span class="stat-card-label">CPU</span>
				<span class="stat-card-expand">
					<Activity size={12} class="h-3 w-3" />
				</span>
			</div>
			<p class="stat-card-value">
				{formatCpu(deployment.totalCpuUsage)}{#if resourcePressure?.cpuLimit != null}<span
						class="stat-card-limit">/ {formatCpu(resourcePressure.cpuLimit)}</span
					>{/if}
			</p>
			{#if cpuMeter}
				<div
					class="stat-card-meter"
					role="progressbar"
					aria-label="CPU used"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(cpuMeter.pct)}
				>
					<span
						class="stat-card-meter-fill stat-card-meter-fill--{cpuMeter.level}"
						style="width: {cpuMeter.pct}%"
					></span>
				</div>
			{/if}
		</button>

		<button
			type="button"
			class="stat-card stat-card--link"
			title="Open metrics"
			onclick={onSetTabMetrics}
		>
			<div class="stat-card-header">
				<MemoryStick class="h-3.5 w-3.5" style="color: var(--color-primary-400);" />
				<span class="stat-card-label">Memory</span>
				<span class="stat-card-expand">
					<Activity size={12} class="h-3 w-3" />
				</span>
			</div>
			<p class="stat-card-value">
				{formatMemory(deployment.totalMemoryUsage)}{#if resourcePressure?.memLimit != null}<span
						class="stat-card-limit">/ {formatMemory(resourcePressure.memLimit)}</span
					>{/if}
			</p>
			{#if memMeter}
				<div
					class="stat-card-meter"
					role="progressbar"
					aria-label="Memory used"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(memMeter.pct)}
				>
					<span
						class="stat-card-meter-fill stat-card-meter-fill--{memMeter.level}"
						style="width: {memMeter.pct}%"
					></span>
				</div>
			{/if}
		</button>

		<!-- Scale -->
		<div class="card rounded-2xl p-4">
			<div class="flex items-center justify-between mb-2">
				<p
					class="text-xs font-semibold uppercase tracking-wide"
					style="color: var(--surface-muted);"
				>
					Replicas
				</p>
				<span class="text-lg font-bold font-mono" style="color: var(--center-channel-color);"
					>{scaleReplicas}</span
				>
			</div>
			{#if drift}
				<p class="replica-drift">
					{#if drift.stopped}
						Stopped. Kubernetes is running 0 pods; starting it again returns to {drift.desired}.
					{:else}
						Kubernetes is running {drift.observed}, not {drift.desired}. Scale to re-apply.
					{/if}
				</p>
			{/if}
			<div class="slider-container" style="padding: 4px 0;">
				<div
					bind:this={sliderRef}
					class="slider-wrapper"
					class:dragging={isDragging}
					role="slider"
					tabindex="0"
					aria-valuemin="0"
					aria-valuemax="20"
					aria-valuenow={scaleReplicas}
					aria-label="Desired replicas"
					onpointerdown={onPointerDown}
					onpointermove={onPointerMove}
					onpointerup={onPointerUp}
					onpointercancel={onPointerCancel}
					onclick={onTrackClick}
					onkeydown={onKeydownSlider}
				>
					<div class="slider-track">
						<div class="slider-range" style="width: {sliderPercentage}%;"></div>
					</div>
					<div
						class="slider-thumb"
						class:dragging={isDragging}
						style="left: {sliderPercentage}%;"
					></div>
				</div>
			</div>
			<div
				class="flex items-center justify-between text-[10px]"
				style="color: var(--surface-muted);"
			>
				<span>0</span>
				<span>20</span>
			</div>
			{#if scaleReplicas !== deployment.replicas}
				<div
					class="flex items-center justify-end pt-2.5 mt-2.5 border-t"
					style="border-color: var(--surface-border);"
				>
					<Button
						variant="primary"
						size="sm"
						class="w-full"
						loading={scaling}
						onclick={onScaleDeployment}
					>
						Scale to {scaleReplicas}
					</Button>
				</div>
			{/if}

			<!-- Pods (merged into Replicas card) -->
			<div class="mt-3 pt-3 border-t" style="border-color: var(--surface-border);">
				<div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
					<div class="flex items-center gap-2">
						<p
							class="text-xs font-semibold uppercase tracking-wide"
							style="color: var(--surface-muted);"
						>
							Pods
						</p>
						<span class="text-xs font-mono" style="color: var(--surface-muted);"
							>{activePods.length}</span
						>
					</div>
					<div class="flex gap-2.5 text-[11px]" style="color: var(--surface-muted);">
						<span class="inline-flex items-center gap-1"
							><span
								class="h-1.5 w-1.5 rounded-full"
								style="background-color: var(--online-indicator);"
							></span>{activePods.filter((pod) => pod.status?.toLowerCase() === 'ready').length} ready</span
						>
						{#if activePods.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length > 0}
							<span class="inline-flex items-center gap-1"
								><span
									class="h-1.5 w-1.5 rounded-full"
									style="background-color: var(--away-indicator);"
								></span>{activePods.filter(
									(pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')
								).length} other</span
							>
						{/if}
					</div>
				</div>
				{#if activePods.length}
					<div class="space-y-1 overview-pods-scroll">
						{#each activePods as pod (pod.name)}
							{@const term = podTermination(pod)}
							{@const meta = podStatus(pod.status)}
							<div
								class="pod-item"
								class:pod-item--active={selectedPod === pod.name}
								class:pod-item--crashed={!!term}
							>
								<button class="pv-b" onclick={() => selectPod(pod)}>
									<span class="pv-b-row">
										<span class="pv-b-name">{podLabel(pod.name)}</span>
										<StatusBadge {meta} />
									</span>
									{#if pod.startTime}
										<span class="pv-b-age"
											>Started {formatRelativeTime(new Date(pod.startTime))}</span
										>
									{/if}
									{#if term}
										{@const why = explainExitCode(term.exitCode, term.reason)}
										<span class="pv-b-crash"
											>{restartPhrase(pod.restartCount ?? 0, term.exitCode)}</span
										>
										{#if why}<span class="pv-b-why">{why.short}</span>{/if}
									{/if}
								</button>
								{#if term}
									<button
										class="pv-b-act"
										aria-label="View crash logs for {pod.name}"
										onclick={() => openCrashLogs(pod)}
									>
										<Terminal size={12} class="h-3 w-3" />
										<span>View crash logs</span>
									</button>
								{/if}
								<span class="pod-item-actions">
									<a
										class="pod-item-btn"
										title="Open pod details"
										aria-label="Open pod details"
										href="/{$page.params
											.orgSlug}/pods/{pod.name}?namespace={deployment?.namespace ?? 'default'}"
									>
										<SquareArrowOutUpRight size={12} class="h-3 w-3" />
									</a>
									<button
										class="pod-item-btn pod-item-btn--danger"
										title="Delete pod"
										aria-label="Delete pod"
										onclick={() => onDeletePod(pod.name)}
										disabled={deletingPod === pod.name}
									>
										{#if deletingPod === pod.name}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<Trash2 size={12} class="h-3 w-3" />
										{/if}
									</button>
								</span>
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-center py-3" style="color: var(--surface-muted);">
						No pods reporting yet
					</p>
				{/if}
			</div>
		</div>
	</div>
</div>
