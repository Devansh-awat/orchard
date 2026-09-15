<script lang="ts">
	import { Check, Copy, Plus, RotateCw, X } from 'lucide-svelte';
	import { Skeleton } from '$lib/components/ui';
	import {
		buildTerminalTheme,
		monoFontFor,
		applyTerminalTheme,
		watchTerminalTheme
	} from '$lib/utils/terminal-theme';

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

	type TermStatus = 'connecting' | 'open' | 'closed' | 'error';
	type Tab = { id: string; label: string; status: TermStatus; detail: string | null };
	type Handle = {
		el: HTMLDivElement | null;
		term: any;
		fit: any;
		socket: WebSocket | null;
		observer: ResizeObserver | null;
		unwatchTheme: (() => void) | null;
		disposed: boolean;
	};

	let tabs = $state<Tab[]>([]);
	let activeTab = $state('');
	let copied = $state(false);
	let loadFailed = $state(false);

	const handles = new Map<string, Handle>();
	let ghostty: any = null;
	let ghosttyLoad: Promise<any> | null = null;
	let seq = 0;
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	const command = $derived(`orchard sandbox ssh ${name}`);
	const current = $derived(tabs.find((t) => t.id === activeTab) ?? null);
	const statusLabel = $derived(
		current === null
			? ''
			: current.status === 'connecting'
				? 'Connecting'
				: current.status === 'closed' || current.status === 'error'
					? (current.detail ?? 'Shell closed')
					: ''
	);

	function setStatus(id: string, status: TermStatus, detail: string | null) {
		const tab = tabs.find((t) => t.id === id);
		if (!tab) return;
		tab.status = status;
		tab.detail = detail;
	}

	function hideCaret(term: any) {
		const area = term?.textarea as HTMLTextAreaElement | undefined;
		if (!area) return;
		area.style.caretColor = 'transparent';
		area.style.color = 'transparent';
		area.style.background = 'transparent';
	}

	function sendResize(id: string) {
		const handle = handles.get(id);
		if (!handle?.term || !handle.socket || handle.socket.readyState !== WebSocket.OPEN) return;
		handle.socket.send(
			JSON.stringify({ type: 'resize', cols: handle.term.cols, rows: handle.term.rows })
		);
	}

	async function loadGhostty() {
		if (ghostty) return ghostty;
		if (!ghosttyLoad) {
			ghosttyLoad = import('ghostty-web').then(async (mod) => {
				await mod.init();
				return mod;
			});
		}
		ghostty = await ghosttyLoad;
		return ghostty;
	}

	function closeSocket(handle: Handle) {
		const ws = handle.socket;
		handle.socket = null;
		if (!ws) return;
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		try {
			ws.close();
		} catch {
			return;
		}
	}

	function connect(id: string) {
		const handle = handles.get(id);
		if (!handle || handle.disposed || !handle.term) return;
		closeSocket(handle);
		handle.term.reset();
		setStatus(id, 'connecting', null);
		const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(`${scheme}//${location.host}/apiv1/sandboxes/${sandboxId}/terminal`);
		ws.binaryType = 'arraybuffer';
		handle.socket = ws;

		ws.onopen = () => {
			if (handles.get(id)?.socket !== ws) return;
			handle.term?.reset();
			setStatus(id, 'open', null);
			sendResize(id);
			if (id === activeTab) handle.term?.focus();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (handles.get(id)?.socket !== ws || !handle.term) return;
			const text =
				event.data instanceof ArrayBuffer
					? new TextDecoder().decode(event.data)
					: (event.data as string);
			handle.term.write(text);
		};
		ws.onclose = (event: CloseEvent) => {
			if (handles.get(id)?.socket !== ws) return;
			setStatus(id, 'closed', event.code === 4401 ? 'Access revoked' : 'Shell closed');
		};
		ws.onerror = () => {
			if (handles.get(id)?.socket !== ws) return;
			setStatus(id, 'error', 'Connection failed');
		};
	}

	async function bootSession(id: string, el: HTMLDivElement) {
		const handle = handles.get(id);
		if (!handle || handle.disposed) return;
		handle.el = el;
		setStatus(id, 'connecting', null);
		let mod: any;
		try {
			mod = await loadGhostty();
		} catch {
			loadFailed = true;
			setStatus(id, 'error', 'Could not load the terminal');
			return;
		}
		if (handle.disposed || handle.term) return;

		const term = new mod.Terminal({
			fontSize: 12,
			fontFamily: monoFontFor(el),
			cursorBlink: true,
			cursorStyle: 'bar',
			theme: buildTerminalTheme(el)
		});
		const fit = new mod.FitAddon();
		term.loadAddon(fit);
		term.open(el);
		hideCaret(term);
		try {
			fit.fit();
		} catch {
			/* not measurable yet */
		}
		handle.term = term;
		handle.fit = fit;

		term.onData((data: string) => {
			const socket = handles.get(id)?.socket;
			if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
		});
		term.onResize(() => sendResize(id));

		const observer = new ResizeObserver(() => {
			const live = handles.get(id);
			if (!live?.fit) return;
			try {
				live.fit.fit();
			} catch {
				return;
			}
		});
		observer.observe(el);
		handle.observer = observer;
		handle.unwatchTheme = watchTerminalTheme(el, (next) => applyTerminalTheme(term, next));

		connect(id);
	}

	function disposeSession(id: string) {
		const handle = handles.get(id);
		if (!handle) return;
		handle.disposed = true;
		handle.observer?.disconnect();
		handle.observer = null;
		handle.unwatchTheme?.();
		handle.unwatchTheme = null;
		closeSocket(handle);
		try {
			handle.term?.dispose();
		} catch {
			/* already disposed */
		}
		handle.term = null;
		handle.fit = null;
		if (handle.el) handle.el.replaceChildren();
		handle.el = null;
		handles.delete(id);
	}

	function hostAttach(id: string) {
		return (el: Element) => {
			bootSession(id, el as HTMLDivElement);
			return () => disposeSession(id);
		};
	}

	function openSession() {
		seq += 1;
		const id = `sh-${seq}-${Date.now().toString(36)}`;
		handles.set(id, {
			el: null,
			term: null,
			fit: null,
			socket: null,
			observer: null,
			unwatchTheme: null,
			disposed: false
		});
		tabs = [...tabs, { id, label: `Shell ${seq}`, status: 'connecting', detail: null }];
		activeTab = id;
	}

	function closeSession(id: string) {
		const index = tabs.findIndex((t) => t.id === id);
		if (index === -1) return;
		const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTab === id) activeTab = next?.id ?? '';
	}

	function disposeAll() {
		for (const id of [...handles.keys()]) disposeSession(id);
		tabs = [];
		activeTab = '';
		seq = 0;
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
		loadFailed = false;
		disposeAll();
	});

	$effect(() => {
		if (!active || !running || bootstrapped) return;
		bootstrapped = true;
		openSession();
	});

	$effect(() => {
		const id = activeTab;
		if (!active || !id) return;
		const frame = requestAnimationFrame(() => {
			const handle = handles.get(id);
			if (!handle?.fit) return;
			try {
				handle.fit.fit();
			} catch {
				return;
			}
			handle.term?.focus();
		});
		return () => cancelAnimationFrame(frame);
	});

	$effect(() => {
		return () => {
			if (copyTimer) clearTimeout(copyTimer);
			disposeAll();
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
				disabled={loadFailed}
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
					<div class="term-host" {@attach hostAttach(tab.id)}></div>
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
			{#if statusLabel}
				<div class="term-status">
					<span class="term-status-text">{statusLabel}</span>
					{#if current && (current.status === 'closed' || current.status === 'error')}
						<button type="button" class="term-retry" onclick={() => connect(current.id)}>
							<RotateCw class="h-3 w-3" /> Reconnect
						</button>
					{/if}
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

	.term-host {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.term-host :global(textarea) {
		caret-color: transparent;
		color: transparent;
	}

	.term-status {
		position: absolute;
		right: var(--space-2);
		bottom: var(--space-2);
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		height: 1.375rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
	}

	.term-status-text {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.term-retry {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0;
		border: none;
		background: none;
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.term-retry:hover {
		color: var(--text-default);
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
