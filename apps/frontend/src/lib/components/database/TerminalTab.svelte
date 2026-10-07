<script lang="ts">
	import {
		Loader2,
		X,
		RefreshCw,
		Terminal as TerminalIcon,
		Container,
		ChevronDown,
		Maximize2,
		Minimize2,
		ChevronRight,
		Skull
	} from 'lucide-svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import TerminalSettings from '$lib/components/TerminalSettings.svelte';
	import { Button, TabBar, EmptyState, Select } from '$lib/components/ui';
	import { explainExitCode, formatRelativeTime } from '$lib/utils/format';
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
		logsPodName = $bindable(''),
		logsPrevious = $bindable(false),
		killedList = [],
		killedLoading = false,
		killedLogs = {},
		killedLogsLoading = null,
		expandedKilled = null,
		onFetchLogs,
		onFetchKilled,
		onToggleKilled,
		onOpenShellTab,
		onCloseTerminalTab,
		onTerminalTitle,
		onTerminalBell,
		onTerminalSession,
		podShortName
	}: {
		database: DatabaseDetail;
		logs: string;
		logsLoading: boolean;
		logsRef: HTMLPreElement | null;
		activeConsoleTab: string;
		terminalTabs: TerminalTabType[];
		consoleExpanded: boolean;
		tailLines: number;
		logsPodName?: string;
		logsPrevious?: boolean;
		killedList?: {
			entryId: string;
			pod: string;
			container: string;
			reason: string;
			exitCode: number | null;
			finishedAt: string | null;
		}[];
		killedLoading?: boolean;
		killedLogs?: Record<string, string>;
		killedLogsLoading?: string | null;
		expandedKilled?: string | null;
		onFetchLogs: () => void;
		onFetchKilled?: () => void;
		onToggleKilled?: (entryId: string) => void;
		onOpenShellTab: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onTerminalTitle?: (id: string, title: string) => void;
		onTerminalBell?: (id: string) => void;
		onTerminalSession?: (id: string, handle: string) => void;
		podShortName: (name: string) => string;
	} = $props();

	const consoleTabs = $derived([
		{ id: 'logs', label: 'Logs' },
		{ id: 'killed', label: 'Killed' },
		...terminalTabs.map((t) => ({ id: t.id, label: t.title || t.label }))
	]);
</script>

{#if database.mode !== 'cnpg' && database.mode !== 'container'}
	<EmptyState
		title="Terminal needs a dedicated database"
		description="Terminal access requires a managed database (CNPG or container mode)."
	/>
{:else}
	{@const pod = database.pods?.[0] ?? null}
	<div
		class="console-panel"
		class:console-expanded={consoleExpanded}
		class:console-at-fullscreen={consoleExpanded}
	>
		<div class="console-toolbar">
			<div class="console-toolbar-left">
				<TabBar tabs={consoleTabs} bind:value={activeConsoleTab}>
					{#snippet tab(t)}
						<span>{t.label}</span>
						{#if t.id !== 'logs' && t.id !== 'killed'}
							<span
								class="console-tab-close"
								role="button"
								tabindex="-1"
								onclick={(e) => {
									e.stopPropagation();
									onCloseTerminalTab(t.id);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.stopPropagation();
										onCloseTerminalTab(t.id);
									}
								}}
							>
								<X class="h-2.5 w-2.5" />
							</span>
						{/if}
					{/snippet}
				</TabBar>
			</div>
			<div class="console-toolbar-right">
				{#if activeConsoleTab === 'killed'}
					<span class="db-hint" style="margin: 0;">Terminated in the last 24h</span>
					<Button
						variant="ghost"
						size="sm"
						loading={killedLoading}
						onclick={() => onFetchKilled?.()}
					>
						Refresh
					</Button>
				{:else if activeConsoleTab === 'logs'}
					{#if (database.pods?.length ?? 0) > 1}
						<div class="tt-pod-select">
							<Select
								value={logsPodName || pod?.name || ''}
								aria-label="Pod to read logs from"
								onchange={(e: Event) => {
									logsPodName = (e.currentTarget as HTMLSelectElement).value;
									onFetchLogs();
								}}
							>
								{#each database.pods ?? [] as p (p.name)}
									<option value={p.name}>{podShortName(p.name)}</option>
								{/each}
							</Select>
						</div>
					{/if}
					<Button
						variant={logsPrevious ? 'primary' : 'ghost'}
						size="sm"
						onclick={() => {
							logsPrevious = !logsPrevious;
							onFetchLogs();
						}}
						title="Read the container that died instead of the one running now"
					>
						Previous
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={(e: MouseEvent) => {
							e.preventDefault();
							tailLines =
								tailLines === 100 ? 200 : tailLines === 200 ? 500 : tailLines === 500 ? 1000 : 100;
							onFetchLogs();
						}}
						title="Cycle tail size"
					>
						<Container class="h-3 w-3 opacity-40" />
						<span>{podShortName(logsPodName || pod?.name || '')} / postgres</span>
						<ChevronDown class="h-2.5 w-2.5 opacity-40" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={onFetchLogs}
						loading={logsLoading}
						title={`Refresh (tail ${tailLines})`}
						aria-label="Refresh logs"
					>
						{#if !logsLoading}<RefreshCw class="h-3.5 w-3.5" />{/if}
					</Button>
				{/if}
				<Button
					variant="secondary"
					size="sm"
					disabled={!pod}
					onclick={() => pod && onOpenShellTab(pod.name, 'postgres')}
					title={pod ? 'Open shell in pod' : 'Waiting for the Postgres pod'}
				>
					<TerminalIcon class="h-3 w-3" />
					Shell
				</Button>
				<TerminalSettings />
				<Button
					variant="ghost"
					size="sm"
					onclick={() => (consoleExpanded = !consoleExpanded)}
					title={consoleExpanded ? 'Collapse' : 'Expand'}
					aria-label={consoleExpanded ? 'Collapse' : 'Expand'}
				>
					{#if consoleExpanded}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2
							class="h-3.5 w-3.5"
						/>{/if}
				</Button>
			</div>
		</div>

		<div class="console-body">
			{#if activeConsoleTab === 'killed'}
				{#if killedLoading && killedList.length === 0}
					<div class="console-empty">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span>Loading...</span>
					</div>
				{:else if killedList.length === 0}
					<div class="console-empty">
						<Skull class="h-4 w-4 opacity-30" />
						<span>Nothing has been killed in the last 24 hours</span>
					</div>
				{:else}
					<div class="tt-killed-list">
						{#each killedList as k (k.entryId)}
							{@const why = explainExitCode(k.exitCode, k.reason)}
							<div class="tt-killed-card">
								<button
									class="tt-killed-head"
									type="button"
									onclick={() => onToggleKilled?.(k.entryId)}
								>
									<ChevronRight
										class="h-3.5 w-3.5 shrink-0"
										style="transform: rotate({expandedKilled === k.entryId
											? 90
											: 0}deg); transition: transform var(--dur-fast) ease;"
									/>
									<div class="tt-killed-main">
										<span class="tt-killed-title">{why?.short ?? k.reason}</span>
										<span class="tt-killed-meta">
											{k.reason}{#if k.exitCode != null}&nbsp;&middot; exit {k.exitCode}{/if}
											&middot; {podShortName(k.pod)}{#if k.finishedAt}&nbsp;&middot;
												{formatRelativeTime(new Date(k.finishedAt))}{/if}
										</span>
									</div>
								</button>
								{#if expandedKilled === k.entryId}
									{#if killedLogsLoading === k.entryId}
										<div class="console-empty">
											<Loader2 class="h-4 w-4 animate-spin" />
											<span>Loading captured logs...</span>
										</div>
									{:else if killedLogs[k.entryId]}
										<pre class="console-output tt-killed-logs">{killedLogs[k.entryId]}</pre>
									{:else}
										<div class="console-empty">
											<span>No logs were captured before this container died</span>
										</div>
									{/if}
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{:else if activeConsoleTab === 'logs'}
				{#if !pod}
					<div class="console-empty">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span>Waiting for the Postgres pod to be scheduled</span>
					</div>
				{:else if logsLoading && !logs}
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
			{/if}
			{#each terminalTabs as ttab (ttab.id)}
				<PodTerminal
					podName={ttab.podName}
					namespace={database.namespace!}
					container={ttab.container}
					visible={activeConsoleTab === ttab.id}
					sessionHandle={ttab.sessionHandle}
					onTitle={(title) => onTerminalTitle?.(ttab.id, title)}
					onBell={() => onTerminalBell?.(ttab.id)}
					onSession={(handle) => onTerminalSession?.(ttab.id, handle)}
				/>
			{/each}
		</div>
	</div>
{/if}

<style>
	.tt-pod-select {
		width: 11rem;
		min-width: 0;
	}
	.tt-killed-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		overflow-y: auto;
	}
	.tt-killed-card {
		border: 1px solid var(--border-edge);
		border-radius: var(--radius-md);
		background-color: var(--bg-raised);
		overflow: hidden;
	}
	.tt-killed-head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		text-align: left;
		background: none;
		border: none;
		cursor: pointer;
		color: inherit;
	}
	.tt-killed-main {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.tt-killed-title {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-fg);
	}
	.tt-killed-meta {
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.tt-killed-logs {
		max-height: 22rem;
		border-top: 1px solid var(--border-edge);
	}
</style>
