<script lang="ts">
	import {
		ChevronDown,
		Database,
		History,
		Maximize2,
		Minimize2,
		Pause,
		Play,
		RefreshCw,
		SquareTerminal
	} from 'lucide-svelte';
	import { untrack } from 'svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import TerminalSettings from '$lib/components/TerminalSettings.svelte';
	import {
		Button,
		EmptyState,
		LogViewer,
		Menu,
		MenuItem,
		SelectTrigger,
		SessionTabs,
		StatusDot
	} from '$lib/components/ui';
	import { statusMeta } from '$lib/components/ui/status';
	import { ansiLogLines } from '$lib/utils/log-sources.svelte';
	import ConsoleKilled from './ConsoleKilled.svelte';
	import type { DatabaseDetail, DatabasePod, TerminalTab as TerminalTabType } from './types';

	let {
		database,
		visible = true,
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
		visible?: boolean;
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
		onFetchLogs: () => void | Promise<void>;
		onFetchKilled?: () => void;
		onToggleKilled?: (entryId: string) => void;
		onOpenShellTab: (podName: string, container: string) => void;
		onCloseTerminalTab: (id: string) => void;
		onTerminalTitle?: (id: string, title: string) => void;
		onTerminalBell?: (id: string) => void;
		onTerminalSession?: (id: string, handle: string) => void;
		podShortName: (name: string) => string;
	} = $props();

	const FOLLOW_MS = 5_000;
	const PAGE_LINES = 500;
	const MAX_LINES = 5_000;

	const dedicated = $derived(database.mode === 'cnpg' || database.mode === 'container');
	const pods = $derived(database.pods ?? []);

	const primaryName = $derived.by(() => {
		const current = database.liveStatus?.currentPrimary;
		if (current && pods.some((p) => p.name === current)) return current;
		return pods.find((p) => p.role === 'primary')?.name ?? pods[0]?.name ?? null;
	});

	const ordered = $derived(
		[...pods].sort((a, b) => Number(b.name === primaryName) - Number(a.name === primaryName))
	);

	const selectedName = $derived(logsPodName || primaryName || '');
	const podGone = $derived(
		!!logsPodName && pods.length > 0 && !pods.some((p) => p.name === logsPodName)
	);

	let paused = $state(false);
	let frozen = $state('');
	let loadingMore = $state(false);
	let scrolledUp = $state(false);
	let visibility = $state<DocumentVisibilityState>('visible');

	const shown = $derived(paused ? frozen : logs);
	const lines = $derived(ansiLogLines(shown));
	const rawCount = $derived(shown ? shown.replace(/\n+$/, '').split('\n').length : 0);
	const atStart = $derived(tailLines >= MAX_LINES || (!!shown && rawCount < tailLines));

	function roleOf(name: string) {
		if (database.mode !== 'cnpg') return null;
		return name === primaryName ? 'Primary' : 'Standby';
	}

	function containerOf(pod: DatabasePod) {
		return (
			pod.containers?.find((c) => c.name === 'postgres')?.name ??
			pod.containers?.[0]?.name ??
			'postgres'
		);
	}

	function restarted(pod: DatabasePod) {
		const statuses = pod.containerStatuses;
		if (!statuses?.length) return null;
		return statuses.some((c) => (c.restartCount ?? 0) > 0);
	}

	const sourceLabel = $derived.by(() => {
		if (!selectedName) return null;
		const role = roleOf(selectedName);
		return role ? `${podShortName(selectedName)} · ${role}` : podShortName(selectedName);
	});

	const primaryPod = $derived(pods.find((p) => p.name === primaryName) ?? null);

	$effect(() => {
		const primary = primaryName;
		if (!primary) return;
		untrack(() => {
			if (logsPodName) return;
			logsPodName = primary;
			onFetchLogs();
		});
	});

	$effect(() => {
		const following =
			visible &&
			!paused &&
			!logsPrevious &&
			!podGone &&
			activeConsoleTab === 'logs' &&
			visibility === 'visible' &&
			!!selectedName;
		if (!following) return;
		const timer = setInterval(() => onFetchLogs(), FOLLOW_MS);
		return () => clearInterval(timer);
	});

	function pick(name: string, previous: boolean) {
		paused = false;
		scrolledUp = false;
		logsPodName = name;
		logsPrevious = previous;
		onFetchLogs();
	}

	function togglePause() {
		if (!paused) frozen = logs;
		paused = !paused;
	}

	async function loadEarlier() {
		if (loadingMore || atStart || paused) return;
		loadingMore = true;
		tailLines = Math.min(tailLines + PAGE_LINES, MAX_LINES);
		try {
			await onFetchLogs();
		} finally {
			loadingMore = false;
		}
	}

	function openShell(pod: DatabasePod | null) {
		if (pod) onOpenShellTab(pod.name, containerOf(pod));
	}
</script>

<svelte:document bind:visibilityState={visibility} />

<div class="console" class:console--full={consoleExpanded}>
	{#if !dedicated}
		<EmptyState
			title="Terminal needs a dedicated database"
			description="Terminal access requires a managed database (CNPG or container mode)."
		/>
	{:else}
		<div class="bar">
			<SessionTabs
				label="Console"
				items={[
					{ id: 'logs', label: 'Logs' },
					{ id: 'killed', label: 'Killed' },
					...terminalTabs.map((t) => ({
						id: t.id,
						label: t.title || t.label,
						icon: SquareTerminal,
						closable: true,
						bell: t.bell
					}))
				]}
				bind:value={activeConsoleTab}
				onselect={(id) => {
					const t = terminalTabs.find((x) => x.id === id);
					if (t) t.bell = false;
				}}
				onclose={onCloseTerminalTab}
			/>

			<div class="tools">
				{#if activeConsoleTab === 'logs'}
					<Menu placement="bottom-end">
						{#snippet trigger(attrs, isOpen)}
							<SelectTrigger
								shape="capsule"
								{...attrs}
								open={isOpen}
								size="sm"
								mono
								prefix={logsPrevious ? 'Previous' : undefined}
								value={sourceLabel}
								placeholder="Pick an instance"
							/>
						{/snippet}
						{#each ordered as pod (pod.name)}
							{@const here = selectedName === pod.name}
							{@const role = roleOf(pod.name)}
							{@const died = restarted(pod)}
							<MenuItem
								icon={Database}
								checked={here && !logsPrevious}
								description={role ?? undefined}
								onclick={() => pick(pod.name, false)}
							>
								{podShortName(pod.name)}
							</MenuItem>
							{#if died !== false || (here && logsPrevious)}
								<MenuItem
									icon={History}
									checked={here && logsPrevious}
									description="Output from before the last restart"
									onclick={() => pick(pod.name, true)}
								>
									{podShortName(pod.name)}
								</MenuItem>
							{/if}
						{/each}
					</Menu>
					{#if !logsPrevious}
						<Button
							shape="capsule"
							variant="ghost"
							size="sm"
							icon={paused ? Play : Pause}
							label={paused ? 'Resume logs' : 'Pause logs'}
							onclick={togglePause}
						/>
					{/if}
				{:else if activeConsoleTab === 'killed' && killedList.length > 0}
					<Button
						shape="capsule"
						variant="ghost"
						size="sm"
						icon={RefreshCw}
						label="Check again"
						loading={killedLoading}
						onclick={() => onFetchKilled?.()}
					/>
				{/if}

				<Button
					shape="capsule"
					variant="secondary"
					size="sm"
					icon={SquareTerminal}
					disabled={!primaryPod}
					title={primaryPod
						? `Open a shell on ${podShortName(primaryPod.name)}`
						: 'Waiting for the Postgres pod'}
					onclick={() => openShell(primaryPod)}>Shell</Button
				>
				{#if pods.length > 1}
					<Menu placement="bottom-end">
						{#snippet trigger(attrs)}
							<Button
								shape="capsule"
								{...attrs}
								variant="ghost"
								size="sm"
								icon={ChevronDown}
								label="Open a shell on another instance"
							/>
						{/snippet}
						{#each ordered as pod (pod.name)}
							<MenuItem
								icon={SquareTerminal}
								description={roleOf(pod.name) ?? undefined}
								onclick={() => openShell(pod)}
							>
								{podShortName(pod.name)}
							</MenuItem>
						{/each}
					</Menu>
				{/if}

				<TerminalSettings />

				<Button
					shape="capsule"
					variant="ghost"
					size="sm"
					icon={consoleExpanded ? Minimize2 : Maximize2}
					label={consoleExpanded ? 'Collapse console' : 'Expand console'}
					onclick={() => (consoleExpanded = !consoleExpanded)}
				/>
			</div>
		</div>

		<div class="stage">
			{#if activeConsoleTab === 'logs'}
				<div class="logs">
					<LogViewer
						toolbar
						filename={selectedName ? `${podShortName(selectedName)}-postgres` : 'postgres'}
						{lines}
						loading={logsLoading && !logs}
						{loadingMore}
						{atStart}
						bind:scrolledUp
						onLoadEarlier={loadEarlier}
					>
						{#snippet empty()}
							<div class="quiet">
								<SquareTerminal size={16} aria-hidden="true" />
								<span
									>{selectedName
										? 'No output yet'
										: 'Waiting for the Postgres pod to be scheduled'}</span
								>
							</div>
						{/snippet}
					</LogViewer>
					{#if selectedName && !logsPrevious && (podGone || paused)}
						<div class="notice" role="status">
							{#if podGone}
								<StatusDot meta={statusMeta('neutral', 'Gone')} size={8} />
								<span>{podShortName(selectedName)} is gone</span>
								{#if primaryName && primaryName !== selectedName}
									<Button
										shape="capsule"
										variant="secondary"
										size="sm"
										onclick={() => primaryName && pick(primaryName, false)}
										>Show {podShortName(primaryName)}</Button
									>
								{/if}
							{:else}
								<StatusDot meta={statusMeta('neutral', 'Paused')} size={8} />
								<span>Paused</span>
								<Button shape="capsule" variant="secondary" size="sm" onclick={togglePause}
									>Resume</Button
								>
							{/if}
						</div>
					{/if}
				</div>
			{:else if activeConsoleTab === 'killed'}
				<ConsoleKilled
					list={killedList}
					loading={killedLoading}
					logs={killedLogs}
					logsLoading={killedLogsLoading}
					expanded={expandedKilled}
					onToggle={onToggleKilled}
					onRefresh={onFetchKilled}
					{podShortName}
				/>
			{/if}
			{#each terminalTabs as ttab (ttab.id)}
				<PodTerminal
					podName={ttab.podName}
					namespace={database.namespace ?? 'default'}
					container={ttab.container}
					visible={visible && activeConsoleTab === ttab.id}
					sessionHandle={ttab.sessionHandle}
					onTitle={(title) => onTerminalTitle?.(ttab.id, title)}
					onBell={() => onTerminalBell?.(ttab.id)}
					onSession={(handle) => onTerminalSession?.(ttab.id, handle)}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.console {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-width: 0;
		min-height: 0;
		border: 1px solid var(--console-edge);
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		color: var(--console-text);
		overflow: clip;
	}
	.console--full {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		height: auto;
		border: none;
		border-radius: 0;
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
	.tools {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}
	.stage {
		position: relative;
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		padding: 0.75rem;
		overflow: hidden;
	}
	.logs {
		position: relative;
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}
	.notice {
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
	.quiet {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--console-faint);
		font-size: var(--text-callout);
	}
</style>
