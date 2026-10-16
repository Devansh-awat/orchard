<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		createTerminal,
		createFitScheduler,
		attachKeyHandler,
		attachLinkOpener,
		wtermPredictTarget,
		type TerminalHandle,
		type FitScheduler
	} from '../lib/terminal/index';
	import type { DisposablePredictTarget } from '../lib/terminal/predict-target';
	import { PredictiveEcho } from '../lib/utils/terminal-predict';
	import { activeTarget, mayTakeFocus } from '../lib/utils/focus-routing';
	import { terminalDisplay, setTerminalDisplay } from '../lib/stores/terminal-display.svelte';

	interface Props {
		podName?: string;
		namespace?: string;
		container?: string;
		endpoint?: string;
		visible?: boolean;
		resizeFrozen?: boolean;
		sessionHandle?: string;
		fontSize?: number;
		fontFamily?: string;
		onZoom?: (step: 1 | -1 | 0) => void;
		onTitle?: (title: string) => void;
		onBell?: () => void;
		onSession?: (handle: string) => void;
		onReady?: (handle: TerminalHandle, predictor: PredictiveEcho) => void;
	}

	let connectWhenShown = false;
	let {
		podName = '',
		namespace = '',
		container = '',
		endpoint,
		visible = true,
		resizeFrozen = false,
		sessionHandle,
		fontSize = undefined,
		fontFamily = undefined,
		onZoom = undefined,
		onTitle,
		onBell,
		onSession,
		onReady
	}: Props = $props();

	let terminalRef = $state<HTMLDivElement | null>(null);
	const textSize = $derived(fontSize ?? terminalDisplay.fontSize);
	let handle: TerminalHandle | null = null;
	let fitScheduler: FitScheduler | null = null;
	let target: DisposablePredictTarget | null = null;
	let predictor: PredictiveEcho | null = null;
	let detachInput: (() => void) | null = null;
	let ws: WebSocket | null = null;
	let decoder = new TextDecoder('utf-8');
	let connected = $state(false);
	let error = $state<string | null>(null);
	let mounted = $state(false);
	let ready = $state(false);
	let note = $state<string | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | null = null;

	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let retries = 0;
	let disposed = false;
	let appliedFontSize = 0;
	let appliedFontFamily: string | undefined = undefined;
	let currentHandle: string | null = null;
	let wasReconnect = false;
	let shownBefore: boolean | null = null;

	const encoder = new TextEncoder();
	const isMac =
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
	const PERMANENT_CLOSE_CODES = new Set([1000, 1005, 4400, 4401, 4403, 4404, 4409, 4429, 4500]);
	const MAX_RETRIES = 40;
	const DEFAULT_FONT_SIZE = 12;
	const NOTE_MS = 4000;

	function status(text: string, sticky = false) {
		note = text;
		if (noteTimer) clearTimeout(noteTimer);
		noteTimer = sticky
			? null
			: setTimeout(() => {
					noteTimer = null;
					note = null;
				}, NOTE_MS);
	}

	function clearNote() {
		if (noteTimer) clearTimeout(noteTimer);
		noteTimer = null;
		note = null;
	}

	function send(bytes: Uint8Array) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
	}

	function sendJson(frame: Record<string, unknown>) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	}

	function userData(data: string) {
		predictor?.onUserData(data);
		send(encoder.encode(data));
	}

	function sendResize(force = false) {
		if (!handle) return;
		sendJson({
			type: 'resize',
			cols: handle.cols,
			rows: handle.rows,
			...(force ? { force } : {})
		});
	}

	function fitNow() {
		fitScheduler?.fitNow();
	}

	async function init() {
		const host = terminalRef;
		if (!host) return;
		try {
			const created = await createTerminal({
				host,
				backgroundToken: '--console-bg',
				fontSize: textSize,
				cursorStyle: terminalDisplay.cursorStyle,
				cursorBlink: terminalDisplay.cursorBlink,
				onData: userData,
				onBinary: send,
				onResize: (cols, rows) => {
					predictor?.flush('resize');
					sendJson({ type: 'resize', cols, rows });
				},
				onTitle: (title) => onTitle?.(title),
				onBell: () => {
					if (terminalDisplay.bell === 'visual') onBell?.();
				}
			});
			if (disposed) {
				created.dispose();
				return;
			}
			handle = created;
			appliedFontSize = textSize;
			appliedFontFamily = fontFamily;
			created.setPaused(!visible);
			if (!visible) created.blur();

			target = wtermPredictTarget(created);
			predictor = new PredictiveEcho(target, { enabled: () => terminalDisplay.predictiveEcho });

			fitScheduler = createFitScheduler({
				host,
				term: created,
				propose: () => created.propose(),
				enabled: () => visible && !resizeFrozen && !disposed
			});
			fitScheduler.fitNow();

			const stopKeys = attachKeyHandler(host, {
				optionIsMeta: () => isMac && created.core.kittyKeyboardFlags() === 0,
				onInput: userData,
				onKeyDown: (event) => predictor?.noteKeyDown(event),
				onClear: () => {
					predictor?.flush('guard');
					userData('\x0c');
				},
				onZoom: (step) => {
					if (onZoom) onZoom(step);
					else if (step === 0) setTerminalDisplay('fontSize', DEFAULT_FONT_SIZE);
					else setTerminalDisplay('fontSize', terminalDisplay.fontSize + step);
				}
			});
			const stopLinks = attachLinkOpener(host);
			detachInput = () => {
				stopKeys();
				stopLinks();
			};

			ready = true;
			onReady?.(created, predictor);
			currentHandle = sessionHandle ?? null;
			if (visible) connectWebSocket();
			else connectWhenShown = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load terminal';
			console.error('[PodTerminal] init error:', e);
		}
	}

	interface AttachedFrame {
		type: 'attached';
		proto?: number;
		handle: string;
		resumed: boolean;
		reason: 'new' | 'resumed' | 'expired' | 'moved' | 'denied';
		reusedId?: boolean;
		cols?: number;
		rows?: number;
		snapshot?: string;
		replayedBytes?: number;
		truncated: boolean;
	}

	interface StatusFrame {
		type: 'status';
		kind: string;
		message: string;
	}

	const STICKY_STATUS = new Set(['limit', 'revoked', 'failed', 'exited']);

	function parseControl(raw: string): Record<string, unknown> | null {
		if (!raw.startsWith('{')) return null;
		try {
			const frame = JSON.parse(raw);
			if (frame && typeof frame === 'object' && typeof frame.type === 'string') return frame;
		} catch {
			return null;
		}
		return null;
	}

	function handleControl(frame: Record<string, unknown>) {
		if (frame.type === 'status') {
			const st = frame as unknown as Partial<StatusFrame>;
			if (typeof st.message === 'string') status(st.message, STICKY_STATUS.has(st.kind ?? ''));
			return;
		}
		if (frame.type !== 'attached') return;
		const attached = frame as unknown as Partial<AttachedFrame>;
		if (typeof attached.handle !== 'string') return;
		currentHandle = attached.handle;
		onSession?.(attached.handle);
		predictor?.flush('disconnect');
		const reconnecting = wasReconnect;
		wasReconnect = false;
		const v2 = attached.proto === 2;
		if (attached.resumed) {
			if (v2 && typeof attached.snapshot === 'string') applySnapshot(attached.snapshot);
			if (reconnecting) status('reconnected, session resumed');
			if (attached.truncated) status('some scrollback was lost while disconnected');
			if (v2) {
				if (handle && (attached.cols !== handle.cols || attached.rows !== handle.rows)) {
					sendResize();
				}
			} else {
				sendResize(true);
			}
			return;
		}
		if (!reconnecting) return;
		handle?.reset();
		decoder = new TextDecoder('utf-8');
		const reattaching = attached.reusedId === true;
		if (attached.reason === 'expired') {
			status(
				reattaching
					? 'reconnected, reattaching your shell'
					: 'previous session expired, started a new shell'
			);
		} else if (attached.reason === 'moved') {
			status(
				reattaching
					? 'reconnected on a different server, reattaching your shell'
					: 'reconnected on a different server, started a new shell'
			);
		} else if (attached.reason === 'denied') {
			status('could not resume that session, started a new shell');
		} else status('reconnected, started a new shell');
	}

	function applySnapshot(snapshot: string) {
		if (!handle) return;
		predictor?.flush('disconnect');
		handle.reset();
		decoder = new TextDecoder('utf-8');
		handle.write(`\x1b[?2026h${snapshot}\x1b[?2026l`);
	}

	function socketUrl(): string {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const size = handle ? `&proto=2&cols=${handle.cols}&rows=${handle.rows}` : '&proto=2';
		const session = currentHandle ? `&session=${encodeURIComponent(currentHandle)}` : '';
		const extra = `${size}${session}`;
		if (endpoint) {
			const base = /^wss?:\/\//.test(endpoint) ? endpoint : `${proto}//${location.host}${endpoint}`;
			return base.includes('?') ? `${base}${extra}` : `${base}?${extra.slice(1)}`;
		}
		return `${proto}//${location.host}/apiv1/pods/${encodeURIComponent(podName)}/exec?namespace=${encodeURIComponent(namespace)}&container=${encodeURIComponent(container)}${extra}`;
	}

	function claimFocus(force: boolean) {
		const h = handle;
		const root = terminalRef;
		if (!h || !root) return;
		if (!force && !mayTakeFocus(activeTarget(), (el) => el instanceof Node && root.contains(el))) {
			return;
		}
		h.focus();
	}

	function connectWebSocket() {
		const socket = new WebSocket(socketUrl());
		socket.binaryType = 'arraybuffer';
		ws = socket;
		decoder = new TextDecoder('utf-8');

		socket.onopen = () => {
			if (ws !== socket) return;
			connected = true;
			error = null;
			retries = 0;
			sendResize();
			if (visible) claimFocus(false);
		};

		socket.onmessage = (event) => {
			if (ws !== socket || !handle) return;
			if (typeof event.data === 'string') {
				const frame = parseControl(event.data);
				if (frame) handleControl(frame);
				else if (predictor) predictor.applyRemote(event.data);
				else handle.write(event.data);
				return;
			}
			if (!(event.data instanceof ArrayBuffer)) return;
			const text = decoder.decode(event.data, { stream: true });
			if (predictor) predictor.applyRemote(text);
			else handle.write(text);
		};

		socket.onclose = (event: CloseEvent) => {
			if (ws !== socket) return;
			connected = false;
			predictor?.flush('disconnect');
			if (disposed) return;
			if (PERMANENT_CLOSE_CODES.has(event.code)) {
				clearNote();
				error = event.reason || 'Session ended';
				return;
			}
			if (retries >= MAX_RETRIES) {
				clearNote();
				error = 'Lost connection to the pod';
				return;
			}
			if (retries === 0) status('disconnected, reconnecting', true);
			wasReconnect = true;
			scheduleReconnect();
		};

		socket.onerror = () => {
			if (ws !== socket) return;
			connected = false;
			predictor?.flush('disconnect');
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
		wasReconnect = handle !== null;
		connectWebSocket();
	}

	$effect(() => {
		void ready;
		const show = visible;
		const h = handle;
		if (!h) return;
		h.setPaused(!show);
		const appeared = shownBefore === false && show;
		shownBefore = show;
		if (show) {
			requestAnimationFrame(() => {
				if (disposed) return;
				fitNow();
				claimFocus(appeared);
				if (connectWhenShown) {
					connectWhenShown = false;
					connectWebSocket();
				}
			});
		} else {
			h.blur();
		}
	});

	$effect(() => {
		void ready;
		const style = terminalDisplay.cursorStyle;
		const blink = terminalDisplay.cursorBlink;
		handle?.setCursor(style, blink);
	});

	$effect(() => {
		void ready;
		const frozen = resizeFrozen;
		if (!handle || frozen) return;
		requestAnimationFrame(() => {
			if (!disposed) fitNow();
		});
	});

	$effect(() => {
		void ready;
		const size = textSize;
		const family = fontFamily;
		const h = handle;
		if (!h || (size === appliedFontSize && family === appliedFontFamily)) return;
		appliedFontSize = size;
		appliedFontFamily = family;
		predictor?.flush('guard');
		void h.setFontSize(size).then(() => {
			if (!disposed) fitNow();
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
		wasReconnect = handle !== null;
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
		if (noteTimer) clearTimeout(noteTimer);
		fitScheduler?.dispose();
		fitScheduler = null;
		detachInput?.();
		detachInput = null;
		detachSocket();
		predictor?.dispose();
		predictor = null;
		target?.dispose();
		target = null;
		handle?.dispose();
		handle = null;
	});
</script>

<div
	class="pod-terminal"
	class:pod-terminal--hidden={!visible}
	style:--pod-terminal-font={fontFamily}
>
	{#if error}
		<div class="pod-terminal-status pod-terminal-error">
			<span>{error}</span>
			<button onclick={reconnect}>Reconnect</button>
		</div>
	{:else if note}
		<div class="pod-terminal-status pod-terminal-note">{note}</div>
	{/if}
	<div
		class="pod-terminal-canvas"
		style:--font-mono-terminal={fontFamily ? 'var(--pod-terminal-font)' : undefined}
		bind:this={terminalRef}
	></div>
	{#if !connected && !error && mounted && !note}
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
		border-radius: 0;
		box-shadow: none;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--console-faint) transparent;
	}

	.pod-terminal-canvas :global(::selection) {
		background: var(--accent-subtle);
	}

	.pod-terminal-canvas :global(.term-predict-overlay) {
		position: absolute;
		z-index: 3;
		height: var(--term-row-height);
		line-height: var(--term-row-height);
		white-space: pre;
		overflow: hidden;
		pointer-events: none;
		color: var(--term-fg);
		background: var(--term-bg);
	}

	.pod-terminal-canvas :global(.term-predict-cursor) {
		position: absolute;
		top: 0;
		width: 2px;
		height: 100%;
		background: var(--term-cursor);
	}

	.pod-terminal-canvas
		:global(.term-grid[data-cursor-shape='block'] ~ .term-predict-overlay .term-predict-cursor) {
		width: var(--term-cell-width);
		opacity: 0.6;
	}

	.pod-terminal-canvas
		:global(
			.term-grid[data-cursor-shape='underline'] ~ .term-predict-overlay .term-predict-cursor
		) {
		top: auto;
		bottom: 0;
		width: var(--term-cell-width);
		height: 2px;
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

	.pod-terminal-note,
	.pod-terminal-connecting {
		background: var(--console-quiet);
		color: var(--console-faint);
		pointer-events: none;
	}
</style>
