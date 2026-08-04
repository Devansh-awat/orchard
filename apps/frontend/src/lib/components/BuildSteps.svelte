<script lang="ts">
	import { ChevronRight, Check, X, Loader2, Database, Info } from 'lucide-svelte';
	import {
		createBuildkitParser,
		formatDuration,
		formatTimestamp,
		buildSummary,
		type BuildStep,
		type ParsedBuildLogs
	} from '$lib/utils/buildkitParser';
	import AnimatedNumber from './AnimatedNumber.svelte';
	import { stateEcho } from '$lib/utils/motion.svelte';

	interface Props {
		logs: string | null | undefined;
		// Show the messages panel (non-step lines like "Waiting for build job …").
		showMessages?: boolean;
		// When true, the step list grows to fit its content instead of scrolling
		// inside a capped box — let the parent container handle scrolling.
		fill?: boolean;
	}

	let { logs, showMessages = true, fill = false }: Props = $props();

	const parseIncremental = createBuildkitParser();
	const parsed = $derived<ParsedBuildLogs>(parseIncremental(logs));
	const summary = $derived(buildSummary(parsed));

	let filter = $state('');
	let expanded = $state<Record<string, boolean>>({});
	let showRaw = $state(false);

	function toggle(id: string) {
		expanded[id] = !expanded[id];
	}

	const autoExpanded = new Set<string>();
	$effect(() => {
		for (const step of parsed.steps) {
			if (step.status === 'error' && !autoExpanded.has(step.id)) {
				autoExpanded.add(step.id);
				if (step.output.length > 0 || step.error) expanded[step.id] = true;
			}
		}
	});

	const filteredSteps = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return parsed.steps;
		return parsed.steps.filter((s) => {
			const hay = `${s.stage ?? ''} ${s.stagePos ?? ''} ${s.command} ${s.output.join(' ')}`;
			return hay.toLowerCase().includes(q);
		});
	});

	function stageBadgeClass(step: BuildStep): string {
		const stage = (step.stage || '').toLowerCase();
		if (stage === 'internal') return 'badge-internal';
		if (stage.startsWith('depot') || stage === 'system') return 'badge-system';
		return 'badge-stage';
	}
</script>

<div class="build-steps" class:build-steps-fill={fill}>
	<div class="bs-header">
		<div class="bs-title">
			<span class="bs-title-text">Logs</span>
			<AnimatedNumber
				value={summary.total}
				format={(n) => {
					const r = Math.round(n);
					return `${r} ${r === 1 ? 'step' : 'steps'}`;
				}}
				class="bs-step-count"
			/>
		</div>
		<div class="bs-header-actions">
			{#if summary.cached > 0}
				<span class="bs-summary-pill bs-summary-cached" title="Cached steps">
					<Database class="h-3 w-3" />
					<AnimatedNumber value={summary.cached} format={(n) => `${Math.round(n)} cached`} />
				</span>
			{/if}
			<button
				type="button"
				class="bs-raw-toggle"
				onclick={() => (showRaw = !showRaw)}
				title="Toggle raw log view"
			>
				{showRaw ? 'Stepped view' : 'Raw logs'}
			</button>
		</div>
	</div>

	{#if !showRaw}
		<div class="bs-filter">
			<input type="text" placeholder="Filter steps…" bind:value={filter} class="bs-filter-input" />
		</div>

		<div class="bs-list" class:bs-list-fill={fill}>
			{#each filteredSteps as step (step.id)}
				{@const isOpen = expanded[step.id]}
				{@const hasOutput = step.output.length > 0 || !!step.error}
				<div
					class="bs-row motion-echo"
					class:bs-row-running={step.status === 'running'}
					class:bs-row-error={step.status === 'error'}
					style:--echo-color={step.status === 'error'
						? 'var(--status-error)'
						: 'var(--status-progress)'}
					{@attach stateEcho(() => step.status)}
				>
					<button
						type="button"
						class="bs-row-main"
						onclick={() => hasOutput && toggle(step.id)}
						disabled={!hasOutput}
						title={hasOutput ? (isOpen ? 'Collapse' : 'Expand') : ''}
					>
						<span class="bs-status" data-status={step.status}>
							{#if step.status === 'done'}
								<Check class="h-3 w-3" />
							{:else if step.status === 'cached'}
								<Database class="h-3 w-3" />
							{:else if step.status === 'error'}
								<X class="h-3 w-3" />
							{:else if step.status === 'running'}
								<Loader2 class="h-3 w-3 animate-spin" />
							{:else}
								<span class="bs-dot"></span>
							{/if}
						</span>

						<span class="bs-timestamp">{formatTimestamp(step.firstSeenAt)}</span>

						<span class="bs-badges">
							{#if step.stage}
								<span class="bs-badge {stageBadgeClass(step)}">{step.stage}</span>
							{/if}
							{#if step.stagePos}
								<span class="bs-badge bs-badge-pos">{step.stagePos}</span>
							{/if}
							{#if step.transferred}
								<span class="bs-badge bs-badge-size">{step.transferred}</span>
							{/if}
						</span>

						<span class="bs-command" title={step.command}>{step.command || `Step #${step.id}`}</span
						>

						<span class="bs-right">
							{#if step.status === 'cached'}
								<span class="bs-cached-pill">cached</span>
							{:else if step.durationSec !== null}
								<AnimatedNumber
									value={step.durationSec}
									format={formatDuration}
									class="bs-duration"
								/>
							{/if}
							{#if hasOutput}
								<ChevronRight class="h-3.5 w-3.5 bs-chevron {isOpen ? 'bs-chevron-open' : ''}" />
							{/if}
						</span>
					</button>

					{#if isOpen && hasOutput}
						<pre class="bs-output">{#if step.error}<span class="bs-output-error"
									>ERROR: {step.error}
</span>{/if}{step.output.join('\n')}</pre>
					{/if}
				</div>
			{:else}
				<div class="bs-empty">
					{#if parsed.steps.length === 0}
						Waiting for deployment output…
					{:else}
						No steps match "{filter}".
					{/if}
				</div>
			{/each}
		</div>

		{#if showMessages && parsed.messages.length > 0}
			<details class="bs-messages">
				<summary class="bs-messages-summary">
					<Info class="h-3.5 w-3.5" />
					System messages ({parsed.messages.length})
				</summary>
				<div class="bs-messages-list">
					{#each parsed.messages as msg, i (i)}
						<div class="bs-message bs-message-{msg.level.toLowerCase()}">
							{#if msg.timestamp}
								<span class="bs-timestamp">{formatTimestamp(msg.timestamp)}</span>
							{/if}
							<span class="bs-message-level">{msg.level}</span>
							<span class="bs-message-text">{msg.text}</span>
						</div>
					{/each}
				</div>
			</details>
		{/if}
	{:else}
		<pre class="bs-raw" class:bs-raw-fill={fill}>{logs ?? ''}</pre>
	{/if}
</div>

<style>
	.build-steps {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-sm);
		background-color: var(--control-bg);
		overflow: hidden;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}

	/* When rendered inside another container (e.g. the log modal), drop the
	   card chrome so it doesn't look like a panel-in-a-panel. */
	.build-steps-fill {
		border: none;
		border-radius: 0;
		background-color: transparent;
		overflow: visible;
	}

	.build-steps-fill .bs-header {
		background-color: transparent;
		padding-left: 0;
		padding-right: 0;
	}

	.build-steps-fill .bs-filter {
		padding-left: 0;
		padding-right: 0;
	}

	.bs-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 0.875rem;
		border-bottom: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}

	.bs-title {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}

	.bs-title-text {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.bs-step-count {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
	}

	.bs-header-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.bs-summary-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.bs-summary-cached {
		background-color: rgba(74, 222, 128, 0.15);
		color: rgb(34, 197, 94);
	}

	.bs-raw-toggle {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		background: transparent;
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-xs);
		padding: 0.25rem 0.5rem;
		cursor: pointer;
		transition:
			color var(--dur-fast),
			border-color var(--dur-fast);
	}

	.bs-raw-toggle:hover {
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--center-channel-color) 30%, var(--surface-border));
	}

	.bs-filter {
		padding: 0.5rem 0.875rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.bs-filter-input {
		width: 100%;
		background-color: transparent;
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-xs);
		padding: 0.5rem 0.75rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--center-channel-color);
		outline: none;
	}

	.bs-filter-input::placeholder {
		color: var(--surface-muted);
	}

	.bs-filter-input:focus {
		border-color: color-mix(in srgb, var(--button-bg) 60%, var(--surface-border));
	}

	.bs-list {
		max-height: 28rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.bs-list-fill {
		max-height: none;
		overflow-y: visible;
	}

	.bs-row {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.bs-row:last-child {
		border-bottom: none;
	}

	.bs-row-running {
		background-color: color-mix(in srgb, var(--button-bg) 6%, transparent);
	}

	.bs-row-error {
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
	}

	.bs-row-main {
		display: grid;
		grid-template-columns: auto auto auto 1fr auto;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0.875rem;
		background: transparent;
		border: none;
		cursor: pointer;
		color: inherit;
		text-align: left;
		font-family: inherit;
	}

	.bs-row-main:disabled {
		cursor: default;
	}

	.bs-row-main:not(:disabled):hover {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.bs-status {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-pill);
	}

	.bs-status[data-status='done'] {
		background-color: rgb(34, 197, 94);
		color: white;
	}

	.bs-status[data-status='cached'] {
		background-color: rgba(34, 197, 94, 0.25);
		color: rgb(34, 197, 94);
	}

	.bs-status[data-status='error'] {
		background-color: rgb(239, 68, 68);
		color: white;
	}

	.bs-status[data-status='running'] {
		background-color: transparent;
		color: var(--button-bg, rgb(59, 130, 246));
	}

	.bs-status[data-status='pending'],
	.bs-status[data-status='canceled'] {
		background-color: transparent;
	}

	.bs-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--surface-muted);
		opacity: 0.6;
	}

	.bs-timestamp {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.bs-badges {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.bs-badge {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-xs);
		white-space: nowrap;
	}

	.badge-stage {
		background-color: color-mix(in srgb, var(--button-bg) 18%, transparent);
		color: var(--button-bg, rgb(59, 130, 246));
	}

	.badge-internal {
		background-color: color-mix(in srgb, var(--surface-muted) 18%, transparent);
		color: var(--surface-muted);
	}

	.badge-system {
		background-color: rgba(168, 85, 247, 0.18);
		color: rgb(168, 85, 247);
	}

	.bs-badge-pos {
		background-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
		color: var(--center-channel-color);
		opacity: 0.85;
	}

	.bs-badge-size {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.bs-command {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.bs-right {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.bs-duration {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
	}

	.bs-cached-pill {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-xs);
		background-color: rgba(34, 197, 94, 0.15);
		color: rgb(34, 197, 94);
	}

	.bs-chevron {
		color: var(--surface-muted);
		transition: transform var(--dur-fast);
	}

	:global(.bs-chevron-open) {
		transform: rotate(90deg);
	}

	.bs-output {
		margin: 0;
		padding: 0.75rem 0.875rem 0.875rem 3.5rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 24rem;
		overflow-y: auto;
	}

	.bs-output-error {
		color: rgb(239, 68, 68);
		font-weight: 600;
	}

	.bs-empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}

	.bs-messages {
		border-top: 1px solid var(--surface-border);
	}

	.bs-messages-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
		cursor: pointer;
		user-select: none;
	}

	.bs-messages-summary:hover {
		color: var(--center-channel-color);
	}

	.bs-messages-list {
		padding: 0 0.875rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.bs-message {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	.bs-message-level {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		padding: 0.05rem 0.35rem;
		border-radius: var(--radius-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.bs-message-info .bs-message-level {
		background-color: rgba(59, 130, 246, 0.15);
		color: rgb(59, 130, 246);
	}

	.bs-message-error .bs-message-level {
		background-color: rgba(239, 68, 68, 0.18);
		color: rgb(239, 68, 68);
	}

	.bs-message-warning .bs-message-level {
		background-color: rgba(245, 158, 11, 0.18);
		color: rgb(245, 158, 11);
	}

	.bs-message-text {
		color: var(--center-channel-color);
		word-break: break-word;
		white-space: pre-wrap;
	}

	.bs-message-error .bs-message-text {
		color: rgb(239, 68, 68);
	}

	.bs-message-warning .bs-message-text {
		color: rgb(245, 158, 11);
	}

	.bs-raw-fill {
		max-height: none;
		overflow-y: visible;
	}

	.bs-raw {
		margin: 0;
		padding: 0.875rem;
		max-height: 28rem;
		overflow-y: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--center-channel-color);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
