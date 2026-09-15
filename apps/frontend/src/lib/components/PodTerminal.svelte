<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		applyTerminalTheme,
		buildTerminalTheme,
		ensureTerminalFont,
		monoFontFor,
		watchTerminalTheme
	} from '$lib/utils/terminal-theme';

	interface Props {
		podName: string;
		namespace: string;
		container: string;
		visible?: boolean;
	}

	let { podName, namespace, container, visible = true }: Props = $props();

	let terminalRef = $state<HTMLDivElement | null>(null);
	let terminal: any = null;
	let fitAddon: any = null;
	let ghosttyModule: any = null;
	let ws: WebSocket | null = null;
	let connected = $state(false);
	let error = $state<string | null>(null);
	let mounted = $state(false);

	let resizeObserver: ResizeObserver | null = null;
	let stopThemeWatch: (() => void) | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let retries = 0;
	let disposed = false;

	const encoder = new TextEncoder();
	const PERMANENT_CLOSE_CODES = new Set([1000, 1005, 4401, 4403, 4404, 4500]);
	const MAX_RETRIES = 6;

	function status(text: string) {
		terminal?.write(`\r\n\x1b[2K\x1b[90m--- ${text} ---\x1b[0m\r\n`);
	}

	async function init() {
		if (!terminalRef) return;

		try {
			ghosttyModule = await import('ghostty-web');
			await Promise.all([ghosttyModule.init(), ensureTerminalFont(terminalRef, 12)]);
			connectWebSocket();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load terminal';
			console.error('[PodTerminal] init error:', e);
		}
	}

	function openTerminal() {
		if (!ghosttyModule || !terminalRef || terminal) return;

		terminal = new ghosttyModule.Terminal({
			fontSize: 12,
			fontFamily: monoFontFor(terminalRef),
			cursorBlink: true,
			cursorStyle: 'bar',
			scrollback: 10_000,
			smoothScrollDuration: 0,
			theme: buildTerminalTheme(terminalRef, { background: '--console-bg' })
		});

		stopThemeWatch = watchTerminalTheme(terminalRef, (next) => applyTerminalTheme(terminal, next), {
			background: '--console-bg'
		});

		fitAddon = new ghosttyModule.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalRef);
		fitAddon.fit();

		resizeObserver = new ResizeObserver(() => {
			if (visible) fitWhenSized();
		});
		resizeObserver.observe(terminalRef);

		terminal.onData((data: string) => {
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
		});

		terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'resize', cols, rows }));
			}
		});

		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.type !== 'keydown') return false;
			if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyC') return false;
			if (!terminal.hasSelection()) return false;
			void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
			return true;
		});

		terminal.focus();
	}

	function connectWebSocket() {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${proto}//${location.host}/apiv1/pods/${encodeURIComponent(podName)}/exec?namespace=${encodeURIComponent(namespace)}&container=${encodeURIComponent(container)}`;

		ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';

		ws.onopen = () => {
			connected = true;
			error = null;
			if (retries > 0 && terminal) {
				status('reconnected');
			}
			retries = 0;
			// Now that we're connected, render the terminal
			openTerminal();
		};

		ws.onmessage = (event) => {
			if (!terminal) return;
			terminal.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
		};

		ws.onclose = (event: CloseEvent) => {
			connected = false;
			if (disposed) return;
			if (PERMANENT_CLOSE_CODES.has(event.code)) {
				error = event.reason || 'Session ended';
				return;
			}
			if (retries >= MAX_RETRIES) {
				error = 'Lost connection to the pod';
				return;
			}
			if (terminal && retries === 0) status('disconnected, reconnecting');
			scheduleReconnect();
		};

		ws.onerror = () => {
			connected = false;
			error = 'Connection failed';
		};
	}

	function scheduleReconnect() {
		if (disposed || reconnectTimer) return;
		const delay = Math.min(500 * 2 ** retries, 10_000);
		retries += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (!disposed) connectWebSocket();
		}, delay);
	}

	function reconnect() {
		error = null;
		retries = 0;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		ws?.close();
		ws = null;
		if (terminal) {
			terminal.write('\x1b[2J\x1b[H');
		}
		connectWebSocket();
	}

	function fitWhenSized(attempt = 0) {
		if (!fitAddon || !terminalRef) return;
		if (terminalRef.clientWidth > 0 && terminalRef.clientHeight > 0) {
			fitAddon.fit();
			return;
		}
		if (attempt < 10) requestAnimationFrame(() => fitWhenSized(attempt + 1));
	}

	$effect(() => {
		if (visible && fitAddon) {
			requestAnimationFrame(() => fitWhenSized());
		}
	});

	onMount(() => {
		mounted = true;
		init();
	});

	onDestroy(() => {
		disposed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		stopThemeWatch?.();
		resizeObserver?.disconnect();
		ws?.close();
		terminal?.dispose();
		terminal?.wasmTerm?.free?.();
		terminal = null;
	});
</script>

<div class="pod-terminal" class:pod-terminal--hidden={!visible}>
	{#if error}
		<div class="pod-terminal-status pod-terminal-error">
			<span>{error}</span>
			<button onclick={reconnect}>Reconnect</button>
		</div>
	{/if}
	<div class="pod-terminal-canvas" bind:this={terminalRef}></div>
	{#if !connected && !error && mounted}
		<div class="pod-terminal-status pod-terminal-connecting">Connecting...</div>
	{/if}
</div>

<style>
	.pod-terminal {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--console-bg);
	}

	.pod-terminal--hidden {
		display: none;
	}

	.pod-terminal-canvas {
		flex: 1;
		min-height: 0;
		padding: 0.75rem;
	}

	/* Hide the textarea's native blinking text caret */
	.pod-terminal-canvas :global(textarea) {
		caret-color: transparent !important;
		color: transparent !important;
		opacity: 0 !important;
		position: fixed !important;
		left: -9999px !important;
		top: -9999px !important;
		width: 0 !important;
		height: 0 !important;
	}

	.pod-terminal-status {
		position: absolute;
		bottom: 0.5rem;
		right: 0.75rem;
		z-index: 10;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-family: var(--font-mono);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-xs);
	}

	.pod-terminal-error {
		background: color-mix(in srgb, var(--status-error) 14%, transparent);
		color: var(--status-error);
		border: 1px solid color-mix(in srgb, var(--status-error) 26%, transparent);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.pod-terminal-error button {
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--status-error) 22%, transparent);
		color: var(--status-error);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		border: none;
		cursor: pointer;
	}
	.pod-terminal-error button:hover {
		background: color-mix(in srgb, var(--status-error) 32%, transparent);
	}

	.pod-terminal-connecting {
		background: var(--console-quiet);
		color: var(--console-faint);
		pointer-events: none;
	}
</style>
