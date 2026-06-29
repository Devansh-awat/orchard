<script lang="ts">
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
	import { formatCpu, formatMemory, formatRelativeTime, ansiToHtml } from '$lib/utils/format';
	import { motionPopover } from '$lib/utils/motion.svelte';
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
		showNewShellMenu = $bindable(),
		showNewShellMenuRender = $bindable(),
		showLogsPodMenu = $bindable(),
		showLogsPodMenuRender = $bindable(),
		onFetchLogs,
		onScaleDeployment,
		onDeletePod,
		onToggleConsoleExpand,
		onHandleNewShell,
		onOpenShell,
		onCloseTerminalTab,
		onSelectLogsPod,
		onLogsScroll,
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
		showNewShellMenu: boolean;
		showNewShellMenuRender: boolean;
		showLogsPodMenu: boolean;
		showLogsPodMenuRender: boolean;
		onFetchLogs: () => void;
		onScaleDeployment: () => void;
		onDeletePod: (podName: string) => void;
		onToggleConsoleExpand: () => void;
		onHandleNewShell: () => void;
		onOpenShell: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onSelectLogsPod: (podName: string, containerName?: string) => void;
		onLogsScroll: (e: Event) => void;
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
						class="console-tab-btn"
						class:console-tab-btn--active={activeConsoleTab === 'logs'}
						onclick={() => (activeConsoleTab = 'logs')}>Logs</button
					>

					<!-- Terminal tabs -->
					{#each terminalTabs as ttab (ttab.id)}
						<button
							class="console-tab-btn"
							class:console-tab-btn--active={activeConsoleTab === ttab.id}
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
						<!-- Pod / container picker -->
						<div class="relative custom-dropdown-container">
							<button
								class="console-source-btn"
								onclick={() => (showLogsPodMenu = !showLogsPodMenu)}
							>
								<Boxes size={12} class="h-3 w-3 opacity-40" />
								<span
									>{podLabel(selectedPod)}{selectedContainer ? ` / ${selectedContainer}` : ''}</span
								>
								<ChevronDown size={10} class="h-2.5 w-2.5 opacity-40" />
							</button>
							{#if showLogsPodMenuRender}
								<div
									class="console-compact-menu"
									style="transform-origin: top left;"
									{@attach motionPopover({
										closing: () => !showLogsPodMenu,
										onClosed: () => {
											showLogsPodMenuRender = false;
										},
										from: { y: -4, scale: 0.96, opacity: 0 }
									})}
								>
									{#each deployment.pods ?? [] as pod}
										{#each pod.containers ?? [] as cont}
											<button
												type="button"
												onclick={() => onSelectLogsPod(pod.name, cont.name)}
												class="console-compact-item"
												class:console-compact-item--active={selectedPod === pod.name &&
													selectedContainer === cont.name}
											>
												<Boxes size={10} class="h-2.5 w-2.5 shrink-0 opacity-30" />
												{podLabel(pod.name)}<span class="console-compact-sep">/</span><span
													class="console-compact-hl">{cont.name}</span
												>
											</button>
										{/each}
									{/each}
								</div>
							{/if}
						</div>

						<button
							onclick={onFetchLogs}
							disabled={logsLoading}
							class="console-icon-btn"
							title="Refresh"
						>
							{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
									size={14}
									class="h-3.5 w-3.5"
								/>{/if}
						</button>
					{/if}

					<!-- New shell -->
					<div class="relative custom-dropdown-container">
						<button class="console-action-btn" onclick={onHandleNewShell} title="Open shell in pod">
							<Terminal size={12} class="h-3 w-3" />
							Shell
						</button>
						{#if showNewShellMenuRender}
							<div
								class="console-compact-menu"
								style="transform-origin: top left;"
								{@attach motionPopover({
									closing: () => !showNewShellMenu,
									onClosed: () => {
										showNewShellMenuRender = false;
									},
									from: { y: -4, scale: 0.96, opacity: 0 }
								})}
							>
								{#each deployment.pods ?? [] as pod}
									{#each pod.containers ?? [] as cont}
										<button
											type="button"
											onclick={() => onOpenShell(pod.name, cont.name)}
											class="console-compact-item"
										>
											<Terminal size={10} class="h-2.5 w-2.5 shrink-0 opacity-40" />
											{podLabel(pod.name)}<span class="console-compact-sep">/</span><span
												class="console-compact-hl">{cont.name}</span
											>
										</button>
									{/each}
								{/each}
							</div>
						{/if}
					</div>

					<button
						onclick={onToggleConsoleExpand}
						class="console-icon-btn"
						title={consoleExpanded ? 'Collapse' : 'Expand'}
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
									class="logs-loading-more logs-loading-more--end">— start of available logs —</div>{/if}{@html ansiToHtml(
								logs
							)}</pre>
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
				<Cpu size={14} class="h-3.5 w-3.5" style="color: #b33346;" />
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
				<MemoryStick class="h-3.5 w-3.5" style="color: #e87485;" />
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
					<button
						onclick={onScaleDeployment}
						disabled={scaling}
						class="btn btn-primary btn-sm w-full"
					>
						{#if scaling}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						Scale to {scaleReplicas}
					</button>
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
							><span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>{activePods.filter(
								(pod) => pod.status?.toLowerCase() === 'ready'
							).length} ready</span
						>
						{#if activePods.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length > 0}
							<span class="inline-flex items-center gap-1"
								><span class="h-1.5 w-1.5 rounded-full bg-yellow-500"></span>{activePods.filter(
									(pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')
								).length} other</span
							>
						{/if}
					</div>
				</div>
				{#if activePods.length}
					<div class="space-y-1 overview-pods-scroll">
						{#each activePods as pod}
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
											class="h-1.5 w-1.5 rounded-full shrink-0 {pod.status?.toLowerCase() ===
											'ready'
												? 'bg-green-500'
												: ['crashing', 'failed', 'error'].includes(
															pod.status?.toLowerCase() ?? ''
													  )
													? 'bg-red-500'
													: pod.status?.toLowerCase() === 'scheduled'
														? 'bg-yellow-500'
														: 'bg-gray-400'}"
										></span>
										<span class="font-mono text-xs truncate">{podLabel(pod.name)}</span>
									</div>
									<div
										class="flex items-center gap-2 shrink-0 text-[10px] font-mono"
										style="color: var(--surface-muted);"
									>
										{#if pod.startTime}<span>{formatRelativeTime(new Date(pod.startTime))}</span
											>{/if}
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
