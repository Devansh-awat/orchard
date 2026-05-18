<script lang="ts">
	import {
		Loader2,
		X,
		RefreshCw,
		Terminal as TerminalIcon,
		Container,
		ChevronDown,
		Maximize2,
		Minimize2
	} from 'lucide-svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import type { DatabaseDetail, TerminalTab as TerminalTabType } from './types';

	let {
		database,
		logs,
		logsLoading,
		logsRef = $bindable(),
		activeConsoleTab = $bindable(),
		terminalTabs = $bindable(),
		consoleExpanded = $bindable(),
		tailLines = $bindable(),
		onFetchLogs,
		onOpenShellTab,
		onCloseTerminalTab,
		podShortName,
	}: {
		database: DatabaseDetail;
		logs: string;
		logsLoading: boolean;
		logsRef: HTMLPreElement | null;
		activeConsoleTab: string;
		terminalTabs: TerminalTabType[];
		consoleExpanded: boolean;
		tailLines: number;
		onFetchLogs: () => void;
		onOpenShellTab: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		podShortName: (name: string) => string;
	} = $props();
</script>

{#if database.mode !== 'cnpg' && database.mode !== 'container'}
	<div class="backups-empty">
		<p class="db-hint">Terminal access requires a managed database (CNPG or container mode).</p>
	</div>
{:else if !database.pods || !database.pods.length}
	<div class="backups-empty">
		<Loader2 class="h-4 w-4 animate-spin" />
		<p class="db-hint" style="margin: 0;">Waiting for the Postgres pod to be scheduled…</p>
	</div>
{:else}
	{@const pod = database.pods[0]}
	<div
		class="console-panel"
		class:console-expanded={consoleExpanded}
		class:console-at-fullscreen={consoleExpanded}
	>
		<div class="console-toolbar">
			<div class="console-toolbar-left">
				<button
					class="console-tab-btn"
					class:console-tab-btn--active={activeConsoleTab === 'logs'}
					onclick={() => (activeConsoleTab = 'logs')}
				>Logs</button>
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
							onclick={(e) => { e.stopPropagation(); onCloseTerminalTab(ttab.id); }}
							onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onCloseTerminalTab(ttab.id); } }}
						>
							<X class="h-2.5 w-2.5" />
						</span>
					</button>
				{/each}
			</div>
			<div class="console-toolbar-right">
				{#if activeConsoleTab === 'logs'}
					<button
						class="console-source-btn"
						onclick={(e) => { e.preventDefault(); tailLines = tailLines === 100 ? 200 : tailLines === 200 ? 500 : tailLines === 500 ? 1000 : 100; onFetchLogs(); }}
						title="Cycle tail size"
					>
						<Container class="h-3 w-3 opacity-40" />
						<span>{podShortName(pod.name)} / postgres</span>
						<ChevronDown class="h-2.5 w-2.5 opacity-40" />
					</button>
					<button onclick={onFetchLogs} disabled={logsLoading} class="console-icon-btn" title={`Refresh (tail ${tailLines})`}>
						{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
					</button>
				{/if}
				<button class="console-action-btn" onclick={() => onOpenShellTab(pod.name, 'postgres')} title="Open shell in pod">
					<TerminalIcon class="h-3 w-3" />
					Shell
				</button>
				<button
					onclick={() => (consoleExpanded = !consoleExpanded)}
					class="console-icon-btn"
					title={consoleExpanded ? 'Collapse' : 'Expand'}
				>
					{#if consoleExpanded}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}
				</button>
			</div>
		</div>

		<div class="console-body">
			{#if activeConsoleTab === 'logs'}
				{#if logsLoading && !logs}
					<div class="console-empty">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span>Loading logs...</span>
					</div>
				{:else if logs}
					<pre bind:this={logsRef} class="console-output">{logs}</pre>
				{:else}
					<div class="console-empty">
						<TerminalIcon class="h-4 w-4 opacity-30" />
						<span>No output yet</span>
					</div>
				{/if}
			{:else}
				{#each terminalTabs as ttab (ttab.id)}
					<PodTerminal
						podName={ttab.podName}
						namespace={database.namespace!}
						container={ttab.container}
						visible={activeConsoleTab === ttab.id}
					/>
				{/each}
			{/if}
		</div>
	</div>
{/if}
