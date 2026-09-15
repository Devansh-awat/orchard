<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		applyTerminalTheme,
		buildTerminalTheme,
		ensureTerminalFont,
		monoFontFor,
		watchTerminalTheme
	} from '$lib/utils/terminal-theme';
	import { PredictiveEcho } from '$lib/utils/terminal-predict';
	import { attachMouseReporting } from '$lib/utils/terminal-mouse';
	import { terminalDisplay, setTerminalDisplay } from '$lib/stores/terminal-display.svelte';

	interface Props {
		podName: string;
		namespace: string;
		container: string;
		visible?: boolean;
		sessionHandle?: string;
		onTitle?: (title: string) => void;
		onBell?: () => void;
		onSession?: (handle: string) => void;
	}

	let {
		podName,
		namespace,
		container,
		visible = true,
		sessionHandle,
		onTitle,
		onBell,
		onSession
	}: Props = $props();

	let terminalRef = $state<HTMLDivElement | null>(null);
	let terminal: any = null;
	let fitAddon: any = null;
	let ghosttyModule: any = null;
	let ws: WebSocket | null = null;
	let predictor: PredictiveEcho | null = null;
	let connected = $state(false);
	let error = $state<string | null>(null);
	let mounted = $state(false);
	let termGen = $state(0);

	let resizeObserver: ResizeObserver | null = null;
	let stopThemeWatch: (() => void) | null = null;
	let stopMouse: (() => void) | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let retries = 0;
	let disposed = false;
	let appliedFontSize = 0;
	let lastChunkHadOsc = false;
	let currentHandle: string | null = sessionHandle ?? null;
	let wasReconnect = false;

	const encoder = new TextEncoder();
	const decoder = new TextDecoder('utf-8');
	const PERMANENT_CLOSE_CODES = new Set([1000, 1005, 4401, 4403, 4404, 4409, 4429, 4500]);
	const MAX_RETRIES = 40;
	const DEFAULT_FONT_SIZE = 12;

	function status(text: string) {
		const line = `\r\n\x1b[2K\x1b[90m--- ${text} ---\x1b[0m\r\n`;
		if (predictor) predictor.writeLocal(line);
		else terminal?.write(line);
	}

	function focusTerminal() {
		if (!terminal) return;
		if (terminal.textarea) terminal.textarea.focus();
		else terminal.focus();
	}

	function sendRaw(seq: string) {
		terminal?.input(seq, true);
	}

	async function init() {
		if (!terminalRef) return;

		try {
			ghosttyModule = await import('ghostty-web');
			await Promise.all([
				ghosttyModule.init(),
				ensureTerminalFont(terminalRef, terminalDisplay.fontSize)
			]);
			connectWebSocket();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load terminal';
			console.error('[PodTerminal] init error:', e);
		}
	}

	function pasteFromClipboard() {
		const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
		if (!read) return;
		void read()
			.then((text) => {
				if (text && terminal) terminal.paste(text);
			})
			.catch(() => {});
	}

	function handleKey(event: KeyboardEvent): boolean {
		if (event.type !== 'keydown') return false;
		predictor?.noteKeyDown(event);
		const plain = !event.ctrlKey && !event.altKey && !event.metaKey;

		if (plain && event.shiftKey && event.key === 'Tab') {
			sendRaw('\x1b[Z');
			return true;
		}

		if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey) {
			if (event.code === 'KeyC') {
				if (!terminal.hasSelection()) return false;
				void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
				return true;
			}
			if (event.code === 'KeyV') {
				pasteFromClipboard();
				return true;
			}
		}

		if (event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyK') {
			event.stopPropagation();
			terminal.clear();
			return true;
		}

		const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
		if (mod) {
			if (event.code === 'Equal' || event.code === 'NumpadAdd') {
				event.stopPropagation();
				setTerminalDisplay('fontSize', terminalDisplay.fontSize + 1);
				return true;
			}
			if (!event.shiftKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
				event.stopPropagation();
				setTerminalDisplay('fontSize', terminalDisplay.fontSize - 1);
				return true;
			}
			if (!event.shiftKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
				event.stopPropagation();
				setTerminalDisplay('fontSize', DEFAULT_FONT_SIZE);
				return true;
			}
		}

		return false;
	}

	interface AttachedFrame {
		type: 'attached';
		handle: string;
		resumed: boolean;
		reason: 'new' | 'resumed' | 'expired' | 'moved' | 'denied';
		replayedBytes: number;
		truncated: boolean;
	}

	function handleControl(raw: string) {
		let frame: Partial<AttachedFrame> | null = null;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!frame || frame.type !== 'attached' || typeof frame.handle !== 'string') return;
		currentHandle = frame.handle;
		onSession?.(frame.handle);
		predictor?.flush('disconnect');
		const reconnecting = wasReconnect;
		wasReconnect = false;
		if (frame.resumed) {
			if (reconnecting) status('reconnected, session resumed');
			if (terminal && ws && ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows, force: true })
				);
			}
			return;
		}
		if (!reconnecting) return;
		terminal?.write('\x1b[H\x1b[2J\x1b[3J');
		if (frame.reason === 'expired') status('previous session expired, started a new shell');
		else if (frame.reason === 'moved') {
			status('reconnected on a different server, started a new shell');
		} else if (frame.reason === 'denied') {
			status('could not resume that session, started a new shell');
		} else status('reconnected, started a new shell');
	}

	function onFocusIn() {
		if (terminal?.getMode?.(1004)) sendRaw('\x1b[I');
	}

	function onFocusOut() {
		if (terminal?.getMode?.(1004)) sendRaw('\x1b[O');
	}

	function openTerminal() {
		if (!ghosttyModule || !terminalRef || terminal) return;

		terminal = new ghosttyModule.Terminal({
			fontSize: terminalDisplay.fontSize,
			fontFamily: monoFontFor(terminalRef),
			cursorBlink: terminalDisplay.cursorBlink,
			cursorStyle: terminalDisplay.cursorStyle,
			scrollback: 10_000,
			smoothScrollDuration: 0,
			theme: buildTerminalTheme(terminalRef, { background: '--console-bg' })
		});
		appliedFontSize = terminalDisplay.fontSize;

		stopThemeWatch = watchTerminalTheme(terminalRef, (next) => applyTerminalTheme(terminal, next), {
			background: '--console-bg'
		});

		fitAddon = new ghosttyModule.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalRef);
		fitAddon.fit();
		predictor = new PredictiveEcho(terminal, { enabled: () => terminalDisplay.predictiveEcho });
		stopMouse = attachMouseReporting(terminal, terminalRef);
		terminalRef.addEventListener('focusin', onFocusIn);
		terminalRef.addEventListener('focusout', onFocusOut);

		resizeObserver = new ResizeObserver(() => {
			if (visible) fitWhenSized();
		});
		resizeObserver.observe(terminalRef);

		terminal.onData((data: string) => {
			predictor?.onUserData(data);
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
		});

		terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
			predictor?.flush('resize');
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'resize', cols, rows }));
			}
		});

		terminal.onTitleChange((title: string) => {
			onTitle?.(title);
		});

		terminal.onBell(() => {
			if (lastChunkHadOsc) return;
			if (terminalDisplay.bell !== 'visual') return;
			onBell?.();
		});

		terminal.attachCustomKeyEventHandler(handleKey);

		termGen += 1;
		focusTerminal();
	}

	function connectWebSocket() {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const session = currentHandle ? `&session=${encodeURIComponent(currentHandle)}` : '';
		const wsUrl = `${proto}//${location.host}/apiv1/pods/${encodeURIComponent(podName)}/exec?namespace=${encodeURIComponent(namespace)}&container=${encodeURIComponent(container)}${session}`;

		const socket = new WebSocket(wsUrl);
		socket.binaryType = 'arraybuffer';
		ws = socket;

		socket.onopen = () => {
			if (ws !== socket) return;
			connected = true;
			error = null;
			retries = 0;
			openTerminal();
		};

		socket.onmessage = (event) => {
			if (ws !== socket || !terminal) return;
			if (typeof event.data === 'string') {
				handleControl(event.data);
				return;
			}
			if (!(event.data instanceof ArrayBuffer)) return;
			const text = decoder.decode(event.data, { stream: true });
			lastChunkHadOsc = text.includes('\x1b]');
			if (predictor) predictor.applyRemote(text);
			else terminal.write(text);
		};

		socket.onclose = (event: CloseEvent) => {
			if (ws !== socket) return;
			connected = false;
			predictor?.flush('disconnect');
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
			wasReconnect = true;
			scheduleReconnect();
		};

		socket.onerror = () => {
			if (ws !== socket) return;
			connected = false;
			predictor?.flush('disconnect');
			error = 'Connection failed';
		};
	}

	function detachSocket() {
		const socket = ws;
		ws = null;
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		socket.onerror = null;
		try {
			socket.close();
		} catch {
			return;
		}
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
		detachSocket();
		predictor?.flush('disconnect');
		wasReconnect = terminal !== null;
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
		void termGen;
		if (!terminal) return;
		terminal.options.cursorStyle = terminalDisplay.cursorStyle;
		terminal.options.cursorBlink = visible && terminalDisplay.cursorBlink;
		if (visible) {
			requestAnimationFrame(() => {
				fitWhenSized();
				focusTerminal();
			});
		} else {
			terminal.blur();
		}
	});

	$effect(() => {
		void termGen;
		const size = terminalDisplay.fontSize;
		const host = terminalRef;
		if (!terminal || !host || size === appliedFontSize) return;
		appliedFontSize = size;
		void ensureTerminalFont(host, size).then(() => {
			if (!terminal || disposed) return;
			terminal.options.fontSize = size;
			fitWhenSized();
		});
	});

	function onVisibilityChange() {
		if (document.visibilityState !== 'visible' || disposed) return;
		if (ws && ws.readyState === WebSocket.OPEN) return;
		if (error && !reconnectTimer) return;
		retries = 0;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		detachSocket();
		wasReconnect = terminal !== null;
		connectWebSocket();
	}

	onMount(() => {
		mounted = true;
		document.addEventListener('visibilitychange', onVisibilityChange);
		init();
	});

	onDestroy(() => {
		disposed = true;
		document.removeEventListener('visibilitychange', onVisibilityChange);
		if (reconnectTimer) clearTimeout(reconnectTimer);
		stopThemeWatch?.();
		stopMouse?.();
		resizeObserver?.disconnect();
		terminalRef?.removeEventListener('focusin', onFocusIn);
		terminalRef?.removeEventListener('focusout', onFocusOut);
		detachSocket();
		predictor?.dispose();
		predictor = null;
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
