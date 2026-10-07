<script lang="ts">
	import { Check, Copy, Plus, X } from 'lucide-svelte';
	import { Skeleton } from '$lib/components/ui';
	import PodTerminal from '$lib/components/PodTerminal.svelte';

	let {
		sandboxId,
		name,
		running,
		booting = false,
		active
	}: {
		sandboxId: string;
		name: string;
		running: boolean;
		booting?: boolean;
		active: boolean;
	} = $props();

	type Tab = { id: string; label: string };

	let tabs = $state<Tab[]>([]);
	let activeTab = $state('');
	let copied = $state(false);
	let seq = 0;
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	const command = $derived(`orchard sandbox ssh ${name}`);
	const endpoint = $derived(`/apiv1/sandboxes/${encodeURIComponent(sandboxId)}/terminal`);

	function openSession() {
		seq += 1;
		const id = `sh-${seq}-${Date.now().toString(36)}`;
		tabs = [...tabs, { id, label: `Shell ${seq}` }];
		activeTab = id;
	}

	function closeSession(id: string) {
		const index = tabs.findIndex((t) => t.id === id);
		if (index === -1) return;
		const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTab === id) activeTab = next?.id ?? '';
	}

	async function copyCommand() {
		await navigator.clipboard.writeText(command);
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1500);
	}

	let bootstrapped = false;
	let lastKey = '';

	$effect(() => {
		const key = `${sandboxId}:${running}`;
		if (key === lastKey) return;
		lastKey = key;
		bootstrapped = false;
		tabs = [];
		activeTab = '';
		seq = 0;
	});

	$effect(() => {
		if (!active || !running || bootstrapped) return;
		bootstrapped = true;
		openSession();
	});

	$effect(() => {
		return () => {
			if (copyTimer) clearTimeout(copyTimer);
		};
	});
</script>

<div class="term-root">
	{#if !running}
		<div class="term-gate">
			{#if booting}
				<Skeleton height="0.75rem" width="60%" />
				<Skeleton height="0.75rem" width="80%" />
				<p class="term-note">The sandbox is still setting up. The shell opens when it is ready.</p>
			{:else}
				<p class="term-note">Start the sandbox to open a shell.</p>
			{/if}
		</div>
	{:else}
		<div class="term-tabs" role="tablist" aria-label="Terminal sessions">
			<div class="term-tabs-strip">
				{#each tabs as tab (tab.id)}
					<div class="term-tab" class:term-tab--active={tab.id === activeTab}>
						<button
							type="button"
							role="tab"
							class="term-tab-btn"
							aria-selected={tab.id === activeTab}
							onclick={() => (activeTab = tab.id)}
						>
							{tab.label}
						</button>
						<button
							type="button"
							class="term-tab-close"
							aria-label={`Close ${tab.label}`}
							onclick={() => closeSession(tab.id)}
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				{/each}
			</div>
			<button
				type="button"
				class="term-tab-add"
				aria-label="New terminal session"
				title="New terminal session"
				onclick={openSession}
			>
				<Plus class="h-3.5 w-3.5" />
			</button>
		</div>

		<div class="term-surface">
			{#each tabs as tab (tab.id)}
				<div
					class="term-pane"
					class:term-pane--hidden={tab.id !== activeTab}
					role="tabpanel"
					aria-label={tab.label}
				>
					<PodTerminal {endpoint} visible={active && tab.id === activeTab} />
				</div>
			{/each}
			{#if tabs.length === 0}
				<div class="term-gate">
					<p class="term-note">No open sessions.</p>
					<button type="button" class="term-open" onclick={openSession}>
						<Plus class="h-3.5 w-3.5" /> New terminal
					</button>
				</div>
			{/if}
		</div>

		<div class="term-foot">
			<code class="term-code">{command}</code>
			<button type="button" class="term-copy" aria-label="Copy shell command" onclick={copyCommand}>
				{#if copied}<Check size={12} />{:else}<Copy size={12} />{/if}
			</button>
		</div>
	{/if}
</div>

<style>
	.term-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg-app);
	}

	.term-gate {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		flex: 1;
		min-height: 0;
		padding: var(--space-6) var(--space-4);
		text-align: center;
	}

	.term-note {
		margin: 0;
		max-width: 20rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
	}

	.term-open {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.5rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-open:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.term-tabs {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
		height: var(--sbw-row, 2.25rem);
		padding: 0 var(--space-1) 0 var(--space-2);
		border-bottom: 1px solid var(--border-default);
	}

	.term-tabs-strip {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.term-tabs-strip::-webkit-scrollbar {
		display: none;
	}

	.term-tab {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 1.5rem;
		padding-right: 0.125rem;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-tab:hover {
		background: var(--bg-hover);
		color: var(--text-muted);
	}

	.term-tab--active {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.term-tab-btn {
		height: 100%;
		padding: 0 var(--space-1) 0 var(--space-2);
		border: none;
		background: none;
		color: inherit;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.term-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-tab-close:hover {
		background: var(--bg-sunken);
		color: var(--text-default);
	}

	.term-tab-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-tab-add:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.term-tab-add:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.term-surface {
		position: relative;
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: var(--space-2);
	}

	.term-pane {
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.term-pane--hidden {
		display: none;
	}

	.term-pane :global(.pod-terminal) {
		background: transparent;
	}

	.term-foot {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		height: 1.75rem;
		padding: 0 var(--space-1) 0 var(--space-2);
		border-top: 1px solid var(--border-default);
	}

	.term-code {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.term-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-copy:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
</style>
