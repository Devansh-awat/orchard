<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		ChevronDown,
		Eye,
		Globe,
		Play,
		Plus,
		Radio,
		Sparkles,
		Square,
		Wand2,
		X
	} from 'lucide-svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { greenhousePrefs } from './prefs.svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { loadTerminalTabs, saveTerminalTabs, terminalTabsKey } from '$lib/terminal/tabs-store';
	import * as api from './api';
	import { modKey } from './format';
	import {
		VIEWER_ONLY,
		chatTabId,
		isLegacy,
		scopeOf,
		type MachineWorkspace
	} from './workspace.svelte';
	import {
		DOCK_TERMINALS_KIND,
		decodeDockTerminals,
		dockPaneId,
		encodeDockTerminals,
		type DockTerminals
	} from './dock-terminals';
	import type { DockTab, GhPort, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession | null } = $props();

	const TERMINAL_FONT =
		"'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace";

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
	const watching = new SvelteMap<string, string[]>();
	let watchOpen = $state(false);
	const active = new SvelteMap<string, DockTab>();
	let scripts = $state.raw<Scripts | null>(null);
	let ports = $state.raw<GhPort[] | null>(null);
	let previewPorts = $state.raw<number[]>([]);
	let runBusy = $state(false);
	let writing = $state(false);
	const persisted = new Map<string, DockTerminals>();

	const CONFIG_PATH = '.orchard/greenhouse.json';
	const CONFIG_TEMPLATE = '{\n  "setup": "",\n  "run": "",\n  "ports": []\n}\n';

	const key = $derived(session?.id ?? '_machine');
	const list = $derived(
		terminals.get(key) ?? persistedFor(ws.sandboxId).terminals.get(key) ?? ['1']
	);
	const notExposed = $derived(
		previewPorts.length > 0
			? `Not reachable from outside the machine. Previews work on ports ${previewPorts.join(', ')}.`
			: 'Previews are not available on this machine.'
	);
	const scripted = $derived(!!session && !isLegacy(session));
	const tab = $derived<DockTab>(active.get(key) ?? (scripted ? 'setup' : 'term:1'));
	const mode = $derived<'rw' | 'ro'>(ws.canEdit ? 'rw' : 'ro');
	const others = $derived(ws.live.others);
	const watched = $derived(
		(watching.get(key) ?? [])
			.map((id) => others.find((u) => u.id === id) ?? null)
			.filter((u): u is NonNullable<typeof u> => !!u)
	);
	const unwatched = $derived(others.filter((u) => !(watching.get(key) ?? []).includes(u.id)));
	const publicMeta = statusMeta('warning', 'Public');
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

	function endpoint(n: string, m: 'rw' | 'ro' = mode, user: string | null = null) {
		return ws.env.terminalEndpoint(ws.sandboxId, session?.id ?? '', n, m, user);
	}

	function persistedFor(sandboxId: string): DockTerminals {
		let state = persisted.get(sandboxId);
		if (!state) {
			state = decodeDockTerminals(
				loadTerminalTabs(terminalTabsKey(DOCK_TERMINALS_KIND, sandboxId))
			);
			persisted.set(sandboxId, state);
		}
		return state;
	}

	function persist(scope: string) {
		const state = persistedFor(ws.sandboxId);
		state.terminals.set(scope, terminals.get(scope) ?? state.terminals.get(scope) ?? ['1']);
		saveTerminalTabs(
			terminalTabsKey(DOCK_TERMINALS_KIND, ws.sandboxId),
			encodeDockTerminals(state, scope)
		);
	}

	function handleFor(scope: string, pane: string): string | undefined {
		return persistedFor(ws.sandboxId).handles.get(dockPaneId(scope, pane));
	}

	function rememberHandle(scope: string, pane: string, handle: string) {
		const handles = persistedFor(ws.sandboxId).handles;
		if (handles.get(dockPaneId(scope, pane)) === handle) return;
		handles.set(dockPaneId(scope, pane), handle);
		persist(scope);
	}

	function rememberScriptHandle(pane: 'setup' | 'run', handle: string) {
		if (session) rememberHandle(session.id, pane, handle);
	}

	function firstName(name: string) {
		return name.split(' ')[0] || name;
	}

	function watch(userId: string) {
		watchOpen = false;
		const current = watching.get(key) ?? [];
		if (!current.includes(userId)) watching.set(key, [...current, userId]);
		select(`watch:${userId}`);
	}

	function unwatch(userId: string) {
		const current = watching.get(key) ?? [];
		watching.set(
			key,
			current.filter((id) => id !== userId)
		);
		if (tab === `watch:${userId}`) active.set(key, `term:${list[0] ?? '1'}`);
	}

	async function loadScripts() {
		if (!session || !scripted || !ws.running) return;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${ws.sandboxId}/sessions/${session.id}/scripts`);
			if (res.ok) scripts = (await res.json()) as Scripts;
		} catch {
			return;
		}
	}

	async function loadPorts() {
		if (!session || !scripted || !ws.running) return;
		const res = await api.listPorts(ws.sandboxId, session.id);
		ports = res.ok ? res.data.ports : [];
		previewPorts = res.ok ? (res.data.previewPorts ?? []) : [];
	}

	function portHint(): string {
		if (previewPorts.length === 0) return '';
		return ` Previews can only reach ports ${previewPorts.join(', ')}, so have the dev server listen on one of them and bind it to 0.0.0.0.`;
	}

	function askAgent(kind: 'setup' | 'run') {
		if (!session || !ws.canEdit) return;
		const prompt =
			kind === 'setup'
				? `Create or update ${CONFIG_PATH} in the repository root with a "setup" command that installs this project's dependencies (detect the package manager and language), a "run" command that starts its dev server if it has one, and "ports" listing the port that server listens on. Keep every command non-interactive.${portHint()} Show me the file when you are done.`
				: `Add a "run" command to ${CONFIG_PATH} in the repository root that starts this project's dev server in the foreground, keep any "setup" already there, and list the port it listens on in "ports". Keep the command non-interactive.${portHint()} Show me the file when you are done.`;
		ws.pendingPrompts.set(session.id, prompt);
		ws.host.openTab(ws.activeChatId ? chatTabId(ws.activeChatId) : null);
	}

	async function writeYourself() {
		if (!session || !ws.canEdit || writing) return;
		writing = true;
		try {
			const scope = scopeOf(session);
			const exists = await api.readFile(ws.sandboxId, scope, CONFIG_PATH).then(
				() => true,
				() => false
			);
			const empty = !scripts?.setup && !scripts?.run && !scripts?.ports.length;
			if (!exists && empty) await api.writeFile(ws.sandboxId, scope, CONFIG_PATH, CONFIG_TEMPLATE);
			ws.openFile(CONFIG_PATH);
		} catch (e) {
			toasts.add({
				title: `Could not create ${CONFIG_PATH}`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			writing = false;
		}
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
		const current = list;
		const used = new Set(current.map(Number));
		let n = 1;
		while (used.has(n)) n++;
		const next = String(n);
		terminals.set(key, [...current, next]);
		persist(key);
		select(`term:${next}`);
	}

	function closeTerminal(n: string) {
		const current = list;
		const index = current.indexOf(n);
		const next = current.filter((t) => t !== n);
		terminals.set(key, next);
		persistedFor(ws.sandboxId).handles.delete(dockPaneId(key, `term:${n}`));
		persist(key);
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

{#snippet missing(kind: 'setup' | 'run')}
	<div class="empty">
		<span class="empty-glyph" aria-hidden="true"><Sparkles size={20} strokeWidth={1.75} /></span>
		<p class="empty-title">{kind === 'setup' ? 'No setup script' : 'No run script'}</p>
		<p class="empty-line">
			Let the agent write <span class="gh-mono empty-path">{CONFIG_PATH}</span> for this repo.
		</p>
		<div class="empty-actions">
			<button
				type="button"
				class="gh-btn"
				disabled={!ws.canEdit}
				title={ws.canEdit ? undefined : VIEWER_ONLY}
				onclick={() => askAgent(kind)}
			>
				<Wand2 size={14} strokeWidth={1.75} />
				Ask the agent
			</button>
			<button
				type="button"
				class="gh-btn gh-btn--ghost"
				disabled={!ws.canEdit || writing}
				title={ws.canEdit ? `Open ${CONFIG_PATH}` : VIEWER_ONLY}
				onclick={writeYourself}
			>
				Write it yourself
			</button>
		</div>
	</div>
{/snippet}

<section class="dock" aria-label="Terminal dock" data-align="dock">
	<div class="gh-tabs tabs" data-align="tabstrip">
		<div class="scroll" role="tablist" aria-label="Dock">
			{#if scripted}
				<button
					type="button"
					role="tab"
					class="gh-tab"
					aria-selected={tab === 'setup'}
					onclick={() => select('setup')}
				>
					<span class="gh-tl" data-label="Setup" data-align="right-edge">Setup</span>
					{#if setupMeta}<span class="state" title="Setup {setupMeta.label.toLowerCase()}"
							><StatusDot meta={setupMeta} size={6} /></span
						>{/if}
				</button>
				<button
					type="button"
					role="tab"
					class="gh-tab"
					aria-selected={tab === 'run'}
					onclick={() => select('run')}
				>
					<span class="gh-tl" data-label="Run">Run</span>
					{#if scripts?.running}<span class="state" title="Run script running"
							><StatusDot meta={runMeta} size={6} /></span
						>{/if}
				</button>
			{/if}
			{#each list as n, i (n)}
				{@const label = `Terminal${list.length > 1 ? ` ${n}` : ''}`}
				<div class="tab-wrap" class:tab-wrap--on={tab === `term:${n}`}>
					<button
						type="button"
						role="tab"
						class="gh-tab"
						class:gh-tab--closable={list.length > 1}
						aria-selected={tab === `term:${n}`}
						onclick={() => select(`term:${n}`)}
					>
						<span
							class="gh-tl"
							data-label={label}
							data-align={!scripted && i === 0 ? 'right-edge' : undefined}>{label}</span
						>
					</button>
					{#if list.length > 1}
						<button
							type="button"
							class="tab-x"
							data-inline-close
							aria-label="Close terminal {n}"
							title="Close terminal {n}"
							onclick={() => closeTerminal(n)}
						>
							<X size={12} strokeWidth={2} />
						</button>
					{/if}
				</div>
			{/each}
			{#each watched as user (user.id)}
				{@const label = `${firstName(user.name)}’s terminal`}
				<div class="tab-wrap" class:tab-wrap--on={tab === `watch:${user.id}`}>
					<button
						type="button"
						role="tab"
						class="gh-tab gh-tab--closable"
						aria-selected={tab === `watch:${user.id}`}
						title="Watching {user.name}’s terminal, read only"
						onclick={() => select(`watch:${user.id}`)}
					>
						<Eye size={14} strokeWidth={1.75} />
						<span class="gh-tl" data-label={label}>{label}</span>
					</button>
					<button
						type="button"
						class="tab-x"
						data-inline-close
						aria-label="Stop watching {user.name}"
						title="Stop watching {user.name}"
						onclick={() => unwatch(user.id)}
					>
						<X size={12} strokeWidth={2} />
					</button>
				</div>
			{/each}
			<button
				type="button"
				class="gh-ibtn add"
				aria-label="New terminal"
				title="New terminal"
				disabled={!ws.running || !ws.canEdit}
				onclick={addTerminal}
			>
				<Plus size={16} strokeWidth={1.75} />
			</button>
			{#if unwatched.length > 0 && ws.running}
				<Menu bind:open={watchOpen} placement="bottom-start">
					{#snippet trigger(props, isOpen)}
						<button
							{...props}
							type="button"
							class="gh-ibtn"
							aria-label="Watch someone’s terminal"
							title="Watch someone’s terminal, read only"
							aria-expanded={isOpen}
						>
							<Eye size={16} strokeWidth={1.75} />
						</button>
					{/snippet}
					<div class="gh-menu-head">Watch a terminal, read only</div>
					{#each unwatched as user (user.id)}
						<MenuItem onclick={() => watch(user.id)}>
							<Eye size={14} />
							{user.name}
						</MenuItem>
					{/each}
				</Menu>
			{/if}
			{#if scripted}
				<button
					type="button"
					role="tab"
					class="gh-tab"
					aria-selected={tab === 'ports'}
					onclick={() => select('ports')}
				>
					<span class="gh-tl" data-label="Ports">Ports</span>
					{#if ports && ports.length > 0}<span class="gh-num count">{ports.length}</span>{/if}
				</button>
			{/if}
		</div>
		<span class="grow"></span>
		{#if scripted}
			{#if scripts?.running}
				<button
					type="button"
					class="gh-ibtn run"
					aria-label="Stop the run script"
					title="Stop the run script"
					disabled={!ws.canEdit || runBusy}
					onclick={() => run('stop')}
				>
					<Square size={16} strokeWidth={1.75} />
				</button>
			{:else}
				<button
					type="button"
					class="gh-ibtn run"
					aria-label="Start the run script"
					disabled={!ws.canEdit || runBusy || !ws.running || (scripts !== null && !scripts.run)}
					title={!ws.canEdit
						? VIEWER_ONLY
						: scripts && !scripts.run
							? 'Add a "run" script to .orchard/greenhouse.json'
							: `Start the run script${scripts?.run ? `: ${scripts.run}` : ''}`}
					onclick={() => run('start')}
				>
					<Play size={16} strokeWidth={1.75} />
				</button>
			{/if}
		{/if}
		<button
			type="button"
			class="gh-ibtn toggle"
			aria-label={app.layout.dockOpen ? 'Collapse dock' : 'Expand dock'}
			title="{app.layout.dockOpen ? 'Collapse' : 'Expand'} dock ({mod}J)"
			aria-expanded={app.layout.dockOpen}
			onclick={() => app.layout.toggle('dock')}
		>
			<span class="chev" {@attach springRotate(() => !app.layout.dockOpen, { rest: 0, on: 180 })}
				><ChevronDown size={16} strokeWidth={1.75} /></span
			>
		</button>
	</div>

	{#if app.layout.dockOpen}
		<div class="body">
			{#if !ws.running}
				<p class="note">Start the machine to open a terminal.</p>
			{:else}
				{#if scripted && session}
					{#key `${session.id}:setup`}
						<div class="pane" class:pane--on={tab === 'setup'}>
							{#if scripts === null}
								<p class="note">Checking for a setup script…</p>
							{:else if !scripts.setup && scripts.setupState === 'none'}
								{@render missing('setup')}
							{:else}
								<PodTerminal
									fontSize={greenhousePrefs.codeSize}
									fontFamily={greenhousePrefs.terminalStack(TERMINAL_FONT)}
									onZoom={(s) => greenhousePrefs.stepCode(s)}
									endpoint={endpoint('setup', 'ro')}
									visible={tab === 'setup'}
									sessionHandle={handleFor(session.id, 'setup')}
									onSession={(h) => rememberScriptHandle('setup', h)}
								/>
							{/if}
						</div>
					{/key}
					{#key `${session.id}:run`}
						<div class="pane" class:pane--on={tab === 'run'}>
							{#if scripts?.running || tab === 'run'}
								{#if scripts === null}
									<p class="note">Checking the run script…</p>
								{:else if !scripts.running && !scripts.run}
									{@render missing('run')}
								{:else if !scripts.running}
									<p class="note">The run script is stopped. Press Run to start it.</p>
								{:else}
									<PodTerminal
										fontSize={greenhousePrefs.codeSize}
										fontFamily={greenhousePrefs.terminalStack(TERMINAL_FONT)}
										onZoom={(s) => greenhousePrefs.stepCode(s)}
										endpoint={endpoint('run', 'ro')}
										visible={tab === 'run'}
										sessionHandle={handleFor(session.id, 'run')}
										onSession={(h) => rememberScriptHandle('run', h)}
									/>
								{/if}
							{/if}
						</div>
					{/key}
					<div class="pane pane--ports gh-scroll" class:pane--on={tab === 'ports'}>
						{#if ports === null}
							<p class="note">Looking for listening ports…</p>
						{:else if ports.length === 0}
							<p class="note">
								No app is listening yet. Start your dev server and its port shows up here.
							</p>
						{:else}
							{#each ports as port (port.port)}
								<div class="port" data-align="right-edge">
									<Radio size={16} strokeWidth={1.75} />
									<span class="gh-mono port-num">:{port.port}</span>
									<span class="port-proc"
										>{port.listening
											? (port.process ?? 'unknown process')
											: 'Not listening yet'}</span
									>
									{#if port.public}<span class="port-public"
											><StatusDot meta={publicMeta} size={6} /> Public</span
										>{/if}
									<span class="grow"></span>
									{#if port.exposable}
										<button
											type="button"
											class="gh-btn"
											title={port.loopbackOnly
												? 'Bound to 127.0.0.1, so the preview may not reach it. Bind to 0.0.0.0.'
												: undefined}
											onclick={() => ws.openPreview(port.port)}
										>
											<Globe size={14} strokeWidth={1.75} /> Preview
										</button>
									{:else}
										<span class="port-off" title={notExposed}>Not exposed</span>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
				{#each list as n (`${key}:${n}`)}
					{@const scope = key}
					<div class="pane" class:pane--on={tab === `term:${n}`}>
						<PodTerminal
							fontSize={greenhousePrefs.codeSize}
							fontFamily={greenhousePrefs.terminalStack(TERMINAL_FONT)}
							onZoom={(s) => greenhousePrefs.stepCode(s)}
							endpoint={endpoint(n)}
							visible={tab === `term:${n}`}
							sessionHandle={handleFor(scope, `term:${n}`)}
							onSession={(h) => rememberHandle(scope, `term:${n}`, h)}
						/>
						{#if mode === 'ro'}
							<span class="ro"><Eye size={14} strokeWidth={1.75} /> Read only</span>
						{:else if others.length > 0 && tab === `term:${n}`}
							<span class="ro">
								{firstName(others[0].name)}{others.length > 1
									? ` and ${others.length - 1} more`
									: ''} can watch this terminal
							</span>
						{/if}
					</div>
				{/each}
				{#each watched as user (`${key}:watch:${user.id}`)}
					{@const scope = key}
					<div class="pane" class:pane--on={tab === `watch:${user.id}`}>
						<PodTerminal
							fontSize={greenhousePrefs.codeSize}
							fontFamily={greenhousePrefs.terminalStack(TERMINAL_FONT)}
							onZoom={(s) => greenhousePrefs.stepCode(s)}
							endpoint={endpoint('1', 'ro', user.id)}
							visible={tab === `watch:${user.id}`}
							sessionHandle={handleFor(scope, `watch:${user.id}`)}
							onSession={(h) => rememberHandle(scope, `watch:${user.id}`, h)}
						/>
						<span class="ro"
							><Eye size={14} strokeWidth={1.75} /> Watching {firstName(user.name)}, read only</span
						>
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

	.scroll {
		display: flex;
		align-items: stretch;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.scroll > .gh-ibtn,
	.tabs > .gh-ibtn {
		align-self: center;
	}

	.tabs > .gh-ibtn:last-child {
		margin-left: 0.5rem;
	}

	.add {
		margin: 0 0.25rem;
	}

	.add + .gh-ibtn {
		margin-left: 0.25rem;
	}

	.chev {
		display: inline-grid;
	}

	.toggle[aria-expanded='true']:not(:hover) {
		background: transparent;
		color: var(--gh-muted);
	}

	.state {
		display: inline-grid;
		place-items: center;
	}

	.tab-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.gh-tab--closable {
		padding-right: 1.75rem;
	}

	.gh-tab--closable[aria-selected='true']::after {
		right: 1.75rem;
	}

	.tab-x {
		position: absolute;
		right: 0.125rem;
		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--gh-r-control);
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
		flex: none;
		margin-left: 0.5rem;
	}

	.grow {
		flex: 1 0 0.5rem;
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
	}

	.pane--on {
		display: flex;
		flex-direction: column;
	}

	.pane--ports {
		padding: 0 var(--gh-edge);
	}

	.note {
		margin: 0;
		padding: var(--gh-edge);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.pane--ports .note {
		padding-inline: 0;
	}

	.ro {
		position: absolute;
		top: 0.5rem;
		right: var(--gh-edge);
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		border-radius: var(--gh-r-control);
		background: var(--gh-sidebar);
		border: 1px solid var(--gh-line);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
		pointer-events: none;
	}

	.port {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.5rem;
		border-bottom: 1px solid var(--gh-line-soft);
		color: var(--gh-muted);
	}

	.port-num {
		color: var(--gh-text);
	}

	.port-proc,
	.port-public {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.port-public {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--gh-muted);
	}

	.port-off {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		cursor: help;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: safe center;
		flex: 1;
		min-height: 0;
		padding: 1rem var(--gh-edge);
		overflow: auto;
		text-align: center;
	}

	.empty-glyph {
		display: inline-grid;
		place-items: center;
		margin-bottom: 0.5rem;
		color: var(--gh-faint);
	}

	.empty-title {
		margin: 0;
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		font-weight: 600;
		color: var(--gh-text);
	}

	.empty-line {
		max-width: 20rem;
		margin: 0.25rem 0 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.empty-path {
		font-size: var(--gh-caption);
		overflow-wrap: anywhere;
	}

	.empty-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
