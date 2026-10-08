<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { ChevronDown, Eye, Globe, Play, Plus, Radio, Square, X } from 'lucide-svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { getGreenhouseApp } from './app.svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import * as api from './api';
	import { modKey } from './format';
	import { VIEWER_ONLY, isLegacy, type MachineWorkspace } from './workspace.svelte';
	import type { DockTab, GhPort, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession | null } = $props();

	const app = getGreenhouseApp();
	const mod = modKey();

	type Scripts = {
		setup: string | null;
		run: string | null;
		ports: number[];
		setupState: 'none' | 'running' | 'done' | 'failed';
		running: boolean;
	};

	const terminals = new SvelteMap<string, string[]>();
	const active = new SvelteMap<string, DockTab>();
	let scripts = $state.raw<Scripts | null>(null);
	let ports = $state.raw<GhPort[] | null>(null);
	let runBusy = $state(false);

	const key = $derived(session?.id ?? '_machine');
	const list = $derived(terminals.get(key) ?? ['1']);
	const scripted = $derived(!!session && !isLegacy(session));
	const tab = $derived<DockTab>(active.get(key) ?? (scripted ? 'setup' : 'term:1'));
	const mode = $derived<'rw' | 'ro'>(ws.canEdit ? 'rw' : 'ro');
	const others = $derived(ws.live.others);
	const runMeta = $derived(
		scripts?.running ? statusMeta('success', 'Running', true) : statusMeta('neutral', 'Stopped')
	);
	const setupMeta = $derived.by(() => {
		switch (scripts?.setupState) {
			case 'running':
				return statusMeta('progress', 'Running', true);
			case 'done':
				return statusMeta('success', 'Done');
			case 'failed':
				return statusMeta('error', 'Failed');
			default:
				return null;
		}
	});

	function endpoint(n: string, m: 'rw' | 'ro' = mode) {
		return ws.env.terminalEndpoint(ws.sandboxId, session?.id ?? '', n, m);
	}

	async function loadScripts() {
		if (!session || !scripted || !ws.running) return;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${ws.sandboxId}/sessions/${session.id}/scripts`);
			if (res.ok) scripts = (await res.json()) as Scripts;
		} catch {
			scripts = null;
		}
	}

	async function loadPorts() {
		if (!session || !scripted || !ws.running) return;
		const res = await api.listPorts(ws.sandboxId, session.id);
		ports = res.ok ? res.data.ports : [];
	}

	$effect(() => {
		void key;
		void ws.running;
		untrack(() => {
			scripts = null;
			ports = null;
			void loadScripts();
			void loadPorts();
		});
		if (!app.layout.dockOpen) return;
		const timer = setInterval(() => {
			if (document.hidden) return;
			void loadPorts();
			void loadScripts();
		}, 8_000);
		return () => clearInterval(timer);
	});

	function select(next: DockTab) {
		active.set(key, next);
		if (!app.layout.dockOpen) app.layout.toggle('dock');
	}

	function addTerminal() {
		const current = terminals.get(key) ?? ['1'];
		const used = new Set(current.map(Number));
		let n = 1;
		while (used.has(n)) n++;
		const next = String(n);
		terminals.set(key, [...current, next]);
		select(`term:${next}`);
	}

	function closeTerminal(n: string) {
		const current = terminals.get(key) ?? ['1'];
		const index = current.indexOf(n);
		const next = current.filter((t) => t !== n);
		terminals.set(key, next);
		if (tab === `term:${n}`) {
			const fallback = next[index] ?? next[index - 1];
			active.set(key, fallback ? `term:${fallback}` : scripted ? 'setup' : 'ports');
		}
	}

	async function run(action: 'start' | 'stop') {
		if (!session || runBusy) return;
		runBusy = true;
		try {
			await api.runScript(ws.sandboxId, session.id, action);
			await loadScripts();
			if (action === 'start') select('run');
		} catch (e) {
			toasts.add({
				title: action === 'start' ? 'Could not start the run script' : 'Could not stop it',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			runBusy = false;
		}
	}

	export function focusTerminal() {
		select(`term:${list[0] ?? '1'}`);
	}

	export function newTerminal() {
		addTerminal();
	}
</script>

<section class="dock" aria-label="Terminal dock">
	<div class="tabs" role="tablist" aria-label="Dock">
		<button
			type="button"
			class="gh-ibtn dock-toggle"
			aria-label={app.layout.dockOpen ? 'Collapse dock' : 'Expand dock'}
			title="{app.layout.dockOpen ? 'Collapse' : 'Expand'} ({mod}J)"
			aria-expanded={app.layout.dockOpen}
			onclick={() => app.layout.toggle('dock')}
		>
			<span class="chev" class:chev--closed={!app.layout.dockOpen}
				><ChevronDown size={14} strokeWidth={1.75} /></span
			>
		</button>
		{#if scripted}
			<button
				type="button"
				role="tab"
				class="tab"
				aria-selected={tab === 'setup'}
				onclick={() => select('setup')}
			>
				Setup
				{#if setupMeta}<StatusDot meta={setupMeta} size={6} />{/if}
			</button>
			<button
				type="button"
				role="tab"
				class="tab"
				aria-selected={tab === 'run'}
				onclick={() => select('run')}
			>
				Run
				{#if scripts?.running}<StatusDot meta={runMeta} size={6} />{/if}
			</button>
		{/if}
		{#each list as n (n)}
			<div class="tab-wrap" class:tab-wrap--on={tab === `term:${n}`}>
				<button
					type="button"
					role="tab"
					class="tab"
					aria-selected={tab === `term:${n}`}
					onclick={() => select(`term:${n}`)}
				>
					Terminal{list.length > 1 ? ` ${n}` : ''}
				</button>
				{#if list.length > 1}
					<button
						type="button"
						class="tab-x"
						aria-label="Close terminal {n}"
						onclick={() => closeTerminal(n)}
					>
						<X size={12} strokeWidth={2} />
					</button>
				{/if}
			</div>
		{/each}
		<button
			type="button"
			class="gh-ibtn"
			aria-label="New terminal"
			title="New terminal"
			disabled={!ws.running}
			onclick={addTerminal}
		>
			<Plus size={14} strokeWidth={1.75} />
		</button>
		{#if scripted}
			<button
				type="button"
				role="tab"
				class="tab"
				aria-selected={tab === 'ports'}
				onclick={() => select('ports')}
			>
				Ports
				{#if ports && ports.length > 0}<span class="gh-num count">{ports.length}</span>{/if}
			</button>
		{/if}
		<span class="grow"></span>
		{#if scripted}
			{#if scripts?.running}
				<button
					type="button"
					class="gh-btn run"
					disabled={!ws.canEdit || runBusy}
					onclick={() => run('stop')}
					title="Stop the run script"
				>
					<Square size={12} strokeWidth={2} /> Stop
				</button>
			{:else}
				<button
					type="button"
					class="gh-btn run"
					disabled={!ws.canEdit || runBusy || !ws.running || (scripts !== null && !scripts.run)}
					title={!ws.canEdit
						? VIEWER_ONLY
						: scripts && !scripts.run
							? 'Add a "run" script to .orchard/greenhouse.json'
							: (scripts?.run ?? 'Run')}
					onclick={() => run('start')}
				>
					<Play size={12} strokeWidth={2} /> Run
				</button>
			{/if}
		{/if}
	</div>

	{#if app.layout.dockOpen}
		<div class="body">
			{#if !ws.running}
				<p class="note">Start the machine to open a terminal.</p>
			{:else}
				{#if scripted && session}
					{#key `${session.id}:setup`}
						<div class="pane" class:pane--on={tab === 'setup'}>
							{#if scripts && !scripts.setup && scripts.setupState === 'none'}
								<p class="note">
									No setup script. Add <code class="gh-mono">"setup"</code> to
									<code class="gh-mono">.orchard/greenhouse.json</code> to install dependencies in every
									new session.
								</p>
							{:else}
								<PodTerminal endpoint={endpoint('setup', 'ro')} visible={tab === 'setup'} />
							{/if}
						</div>
					{/key}
					{#key `${session.id}:run`}
						<div class="pane" class:pane--on={tab === 'run'}>
							{#if scripts?.running || tab === 'run'}
								{#if scripts && !scripts.running}
									<p class="note">
										{scripts.run
											? 'The run script is stopped. Press Run to start it.'
											: 'No run script. Add "run" to .orchard/greenhouse.json to start your dev server from here.'}
									</p>
								{:else}
									<PodTerminal endpoint={endpoint('run', 'ro')} visible={tab === 'run'} />
								{/if}
							{/if}
						</div>
					{/key}
					<div class="pane pane--ports gh-scroll" class:pane--on={tab === 'ports'}>
						{#if ports === null}
							<p class="note">Looking for listening ports…</p>
						{:else if ports.length === 0}
							<p class="note">
								Nothing is listening yet. Start your dev server and it shows up here.
							</p>
						{:else}
							{#each ports as port (port.port)}
								<div class="port">
									<Radio size={14} strokeWidth={1.75} />
									<span class="gh-mono port-num">:{port.port}</span>
									<span class="port-proc">{port.process ?? 'unknown process'}</span>
									{#if port.public}<span class="port-public">Public</span>{/if}
									<span class="grow"></span>
									<button type="button" class="gh-btn" onclick={() => ws.openPreview(port.port)}>
										<Globe size={13} strokeWidth={1.75} /> Preview
									</button>
								</div>
							{/each}
						{/if}
					</div>
				{/if}
				{#each list as n (`${key}:${n}`)}
					<div class="pane" class:pane--on={tab === `term:${n}`}>
						<PodTerminal endpoint={endpoint(n)} visible={tab === `term:${n}`} />
						{#if mode === 'ro'}
							<span class="ro"><Eye size={12} /> Read only</span>
						{:else if others.length > 0 && tab === `term:${n}`}
							<span class="ro">
								{others[0].name.split(' ')[0]}{others.length > 1
									? ` and ${others.length - 1} more`
									: ''} can see this terminal
							</span>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</section>

<style>
	.dock {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--gh-panel);
	}

	.tabs {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex: none;
		height: var(--gh-tab);
		padding: 0 0.5rem 0 0.375rem;
		border-bottom: 1px solid var(--gh-line);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.dock-toggle .chev {
		display: inline-grid;
		transition: transform var(--dur-fast) ease;
	}

	.chev--closed {
		transform: rotate(-90deg);
	}

	.tab-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: var(--gh-tab);
		padding: 0 0.5rem;
		color: var(--gh-muted);
		white-space: nowrap;
		transition: color var(--dur-fast) ease;
	}

	.tab:hover {
		color: var(--gh-text);
	}

	.tab[aria-selected='true'] {
		color: var(--gh-text);
		font-weight: 500;
	}

	.tab[aria-selected='true']::after {
		content: '';
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: -1px;
		height: 2px;
		border-radius: 1px;
		background: var(--gh-text);
	}

	.tab-x {
		display: inline-grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		margin-left: -0.25rem;
		margin-right: 0.25rem;
		border-radius: var(--radius-xs);
		color: var(--gh-faint);
		opacity: 0;
	}

	.tab-wrap:hover .tab-x,
	.tab-wrap--on .tab-x,
	.tab-x:focus-visible {
		opacity: 1;
	}

	.tab-x:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.count {
		color: var(--gh-faint);
	}

	.run {
		height: 1.5rem;
		padding: 0 0.5rem;
		gap: 0.3125rem;
	}

	.grow {
		flex: 1;
	}

	.body {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.pane {
		position: absolute;
		inset: 0;
		display: none;
		padding: 0.375rem 0 0 0.5rem;
	}

	.pane--on {
		display: flex;
		flex-direction: column;
	}

	.pane--ports {
		padding: 0.25rem 0.5rem;
	}

	.note {
		margin: 0;
		padding: 0.75rem 0.5rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.note code {
		font-size: var(--gh-caption);
		color: var(--gh-muted);
	}

	.ro {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.25rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		background: var(--gh-sidebar);
		border: 1px solid var(--gh-line);
		font-size: var(--gh-caption);
		color: var(--gh-muted);
		pointer-events: none;
	}

	.port {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		padding: 0 0.25rem 0 0.5rem;
		border-bottom: 1px solid var(--gh-line-soft);
		color: var(--gh-muted);
	}

	.port-num {
		color: var(--gh-text);
	}

	.port-proc {
		font-size: var(--gh-caption);
	}

	.port-public {
		font-size: var(--gh-caption);
		color: var(--status-warning);
	}
</style>
