<script lang="ts">
	import { Loader2, MemoryStick, TriangleAlert } from 'lucide-svelte';
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
	import { formatCpu, formatMemory, formatRelativeTime, ansiToHtmlLines } from '$lib/utils/format';
	import { Button, Menu, MenuItem } from '$lib/components/ui';
	import { ArrowDown } from 'lucide-svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import type { Pod, TerminalTabInfo } from '$lib/types/deployment';

	let {
		deployment,
		activePods,
		selectedPod = $bindable(),
		selectedContainer = $bindable(),
		scaleReplicas = $bindable(),
		logs,
		logsLoading,
		logsError = null,
		loadingMoreLogs,
		logsAtMax,
		tailLines,
		logsOutputRef = $bindable(),
		consoleExpanded,
		consoleAnimating,
		consoleRef = $bindable(),
		consoleInlineRect,
		isDragging,
		sliderRef = $bindable(),
		sliderPercentage,
		scaling,
		deletingPod,
		activeConsoleTab = $bindable(),
		terminalTabs = $bindable(),
		onFetchLogs,
		liveLogs = false,
		onToggleLiveLogs,
		showPreviousLogs,
		selectedContainerHasPrevious,
		onTogglePreviousLogs,
		onScaleDeployment,
		onDeletePod,
		onToggleConsoleExpand,
		onOpenShell,
		onCloseTerminalTab,
		onSelectLogsPod,
		onLogsScroll,
		logsScrolledUp = false,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onTrackClick,
		onSetTabMetrics,
		onKeydownSlider,
		getStatusColor,
		podLabel
	}: {
		deployment: any;
		activePods: Pod[];
		selectedPod: string;
		selectedContainer: string;
		scaleReplicas: number;
		logs: string;
		logsLoading: boolean;
		logsError?: string | null;
		loadingMoreLogs: boolean;
		logsAtMax: boolean;
		tailLines: number;
		logsOutputRef: HTMLPreElement | null;
		consoleExpanded: boolean;
		consoleAnimating: boolean;
		consoleRef: HTMLDivElement | null;
		consoleInlineRect: { top: number; left: number; width: number; height: number } | null;
		isDragging: boolean;
		sliderRef: HTMLDivElement | null;
		sliderPercentage: number;
		scaling: boolean;
		deletingPod: string | null;
		activeConsoleTab: string;
		terminalTabs: TerminalTabInfo[];
		onFetchLogs: () => void;
		liveLogs?: boolean;
		onToggleLiveLogs?: () => void;
		showPreviousLogs: boolean;
		selectedContainerHasPrevious: boolean;
		onTogglePreviousLogs: () => void;
		onScaleDeployment: () => void;
		onDeletePod: (podName: string) => void;
		onToggleConsoleExpand: () => void;
		onOpenShell: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onSelectLogsPod: (podName: string, containerName?: string) => void;
		onLogsScroll: (e: Event) => void;
		logsScrolledUp?: boolean;
		onPointerDown: (e: PointerEvent) => void;
		onPointerMove: (e: PointerEvent) => void;
		onPointerUp: (e: PointerEvent) => void;
		onPointerCancel: (e: PointerEvent) => void;
		onTrackClick: (e: MouseEvent) => void;
		onSetTabMetrics: () => void;
		onKeydownSlider: (e: KeyboardEvent) => void;
		getStatusColor: (status: string) => string;
		podLabel: (podName: string) => string;
	} = $props();

	const LOG_MAX_LINES = 50_000;

	const logLines = $derived.by(() => {
		if (!logs) return [] as { key: string; html: string }[];
		const seen = new Map<string, number>();
		return ansiToHtmlLines(logs).map((html) => {
			const n = seen.get(html) ?? 0;
			seen.set(html, n + 1);
			return { key: n ? `${html}#${n}` : html, html };
		});
	});

	let newLogsWhileScrolled = $state(false);
	let prevLogLineCount = 0;
	$effect(() => {
		const count = logLines.length;
		if (count > prevLogLineCount && logsScrolledUp) newLogsWhileScrolled = true;
		if (!logsScrolledUp) newLogsWhileScrolled = false;
		prevLogLineCount = count;
	});

	function jumpToLatest() {
		newLogsWhileScrolled = false;
		if (logsOutputRef) {
			logsOutputRef.scrollTo({ top: logsOutputRef.scrollHeight, behavior: 'smooth' });
		}
	}

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
</script>

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
							onclick={() => (activeConsoleTab = ttab.id)}
						>
							{ttab.label}
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
									<span
										>{podLabel(selectedPod)}{selectedContainer
											? ` / ${selectedContainer}`
											: ''}</span
									>
									<ChevronDown size={10} class="h-2.5 w-2.5 opacity-40" />
								</button>
							{/snippet}
							{#each deployment.pods ?? [] as pod (pod.name)}
								{#each pod.containers ?? [] as cont (cont.name)}
									<MenuItem onclick={() => onSelectLogsPod(pod.name, cont.name)}>
										<Boxes size={14} class="shrink-0 opacity-40" />
										<span
											class:font-semibold={selectedPod === pod.name &&
												selectedContainer === cont.name}>{podLabel(pod.name)} / {cont.name}</span
										>
									</MenuItem>
								{/each}
							{/each}
						</Menu>

						<button
							onclick={onTogglePreviousLogs}
							disabled={!selectedContainerHasPrevious && !showPreviousLogs}
							class="console-btn"
							class:console-btn--warn={showPreviousLogs}
							class:console-btn--active={showPreviousLogs}
							title={showPreviousLogs
								? 'Showing logs from the previous (terminated) container. Click for current.'
								: selectedContainerHasPrevious
									? 'Show logs from the previous (terminated) container'
									: 'No previous container logs available'}
						>
							{showPreviousLogs ? 'Previous' : 'Current'}
						</button>

						<button
							onclick={onFetchLogs}
							disabled={logsLoading}
							class="console-btn console-btn--icon"
							title="Refresh"
							aria-label="Refresh logs"
						>
							{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
									size={14}
									class="h-3.5 w-3.5"
								/>{/if}
						</button>

						{#if onToggleLiveLogs}
							<button
								class="console-btn"
								class:console-btn--live={liveLogs}
								onclick={onToggleLiveLogs}
								title={liveLogs ? 'Stop following new logs' : 'Follow new logs as they arrive'}
							>
								{#if liveLogs}
									<span class="console-tail-dot"></span>
								{/if}
								Live
							</button>
						{/if}
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
					{#if logsLoading && !logs}
						<div class="console-empty">
							<Loader2 class="h-4 w-4 animate-spin" />
							<span>Loading logs...</span>
						</div>
					{:else if logs}
						<pre
							class="console-output"
							bind:this={logsOutputRef}
							onscroll={onLogsScroll}>{#if loadingMoreLogs}<div class="logs-loading-more"><Loader2
										class="h-3 w-3 animate-spin"
									/> Loading earlier logs…</div>{:else if logsAtMax || tailLines >= LOG_MAX_LINES}<div
									class="logs-loading-more logs-loading-more--end">Start of available logs</div>{/if}{#each logLines as line (line.key)}<span
									class="console-line"
									><!-- eslint-disable-line svelte/no-at-html-tags -->{@html line.html}</span
								>{/each}</pre>
						{#if newLogsWhileScrolled}
							<button type="button" class="console-newlogs" onclick={jumpToLatest}>
								<ArrowDown size={12} /> New logs
							</button>
						{/if}
					{:else if logsError}
						<div class="console-empty">
							<TriangleAlert class="h-4 w-4" style="color: var(--error-text-color);" />
							<span style="color: var(--error-text-color);">{logsError}</span>
						</div>
					{:else}
						<div class="console-empty">
							<Terminal size={16} class="h-4 w-4 opacity-30" />
							<span>{selectedPod ? 'No output yet' : 'Select a pod to view logs'}</span>
						</div>
					{/if}
				{:else}
					{#each terminalTabs as ttab (ttab.id)}
						<PodTerminal
							podName={ttab.podName}
							namespace={deployment.namespace || 'default'}
							container={ttab.container}
							visible={activeConsoleTab === ttab.id}
						/>
					{/each}
				{/if}
			</div>
		</div>
	</div>

	<!-- Right sidebar: stats + scale + pods -->
	<div class="flex flex-col gap-4 overview-right min-h-0">
		<!-- Resource stats as compact cards. Charts moved to the Metrics tab. -->
		<div class="stat-card">
			<div class="stat-card-header">
				<Cpu size={14} class="h-3.5 w-3.5" style="color: var(--color-primary-600);" />
				<span class="stat-card-label">CPU</span>
				<button
					class="stat-card-expand"
					title="Open Metrics tab"
					aria-label="Open Metrics tab"
					onclick={onSetTabMetrics}
				>
					<Activity size={12} class="h-3 w-3" />
				</button>
			</div>
			<p class="stat-card-value">{formatCpu(deployment.totalCpuUsage)}</p>
		</div>

		<div class="stat-card">
			<div class="stat-card-header">
				<MemoryStick class="h-3.5 w-3.5" style="color: var(--color-primary-400);" />
				<span class="stat-card-label">Memory</span>
				<button
					class="stat-card-expand"
					title="Open Metrics tab"
					aria-label="Open Metrics tab"
					onclick={onSetTabMetrics}
				>
					<Activity size={12} class="h-3 w-3" />
				</button>
			</div>
			<p class="stat-card-value">{formatMemory(deployment.totalMemoryUsage)}</p>
		</div>

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
							<div class="console-pod-row-wrap">
								<button
									class="console-pod-row console-pod-row--compact"
									class:console-pod-row--active={selectedPod === pod.name}
									onclick={() => {
										selectedPod = pod.name;
										if (pod.containers?.length) selectedContainer = pod.containers[0].name;
									}}
								>
									<div class="flex items-center gap-2 min-w-0">
										<span
											class="h-1.5 w-1.5 rounded-full shrink-0"
											style="background-color: {pod.status?.toLowerCase() === 'ready'
												? 'var(--online-indicator)'
												: ['crashing', 'failed', 'error'].includes(pod.status?.toLowerCase() ?? '')
													? 'var(--error-text-color)'
													: pod.status?.toLowerCase() === 'scheduled'
														? 'var(--away-indicator)'
														: 'var(--surface-muted)'};"
										></span>
										<span class="font-mono text-xs truncate">{podLabel(pod.name)}</span>
									</div>
									<div
										class="flex items-center gap-2 shrink-0 text-[10px] font-mono"
										style="color: var(--surface-muted);"
									>
										{#if pod.startTime}<span>{formatRelativeTime(new Date(pod.startTime))}</span
											>{/if}
										{#if term}
											<span
												class="badge text-[9px] px-1 py-0.5"
												style="background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent); color: var(--error-text-color);"
												title="Last terminated: {term.reason}{term.exitCode != null
													? ` (exit ${term.exitCode})`
													: ''}">{term.reason}</span
											>
										{:else if (pod.restartCount ?? 0) > 0}
											<span
												class="badge text-[9px] px-1 py-0.5"
												style="background-color: color-mix(in srgb, var(--away-indicator) 15%, transparent); color: var(--away-indicator);"
												title="{pod.restartCount} restart(s)">↻ {pod.restartCount}</span
											>
										{/if}
										<span class="badge {getStatusColor(pod.status)} text-[9px] px-1 py-0.5"
											>{pod.status}</span
										>
									</div>
								</button>
								<button
									class="pod-delete-btn"
									title="Delete pod"
									onclick={() => onDeletePod(pod.name)}
									disabled={deletingPod === pod.name}
								>
									{#if deletingPod === pod.name}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<Trash2 size={12} class="h-3 w-3" />
									{/if}
								</button>
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
