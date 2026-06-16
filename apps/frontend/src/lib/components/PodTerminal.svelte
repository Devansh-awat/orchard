<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

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

	async function init() {
		if (!terminalRef) return;

		try {
			ghosttyModule = await import('ghostty-web');
			await ghosttyModule.init();
			connectWebSocket();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load terminal';
			console.error('[PodTerminal] init error:', e);
		}
	}

	function openTerminal() {
		if (!ghosttyModule || !terminalRef || terminal) return;

		terminal = new ghosttyModule.Terminal({
			fontSize: 11,
			fontFamily:
				'"SF Mono", "Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
			cursorBlink: true,
			cursorStyle: 'bar',
			theme: {
				background: '#0d1117',
				foreground: '#c9d1d9',
				cursor: '#58a6ff',
				cursorAccent: '#0d1117',
				selectionBackground: 'rgba(56, 139, 253, 0.3)',
				black: '#586069',
				red: '#f97583',
				green: '#85e89d',
				yellow: '#ffea7f',
				blue: '#79b8ff',
				magenta: '#b392f0',
				cyan: '#73e3ff',
				white: '#d1d5da',
				brightBlack: '#6a737d',
				brightRed: '#fdaeb7',
				brightGreen: '#bef5cb',
				brightYellow: '#fff5b1',
				brightBlue: '#c8e1ff',
				brightMagenta: '#d2b3ff',
				brightCyan: '#a5f3fc',
				brightWhite: '#fafbfc'
			}
		});

		fitAddon = new ghosttyModule.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalRef);
		fitAddon.fit();

		resizeObserver = new ResizeObserver(() => {
			if (fitAddon && visible) fitAddon.fit();
		});
		resizeObserver.observe(terminalRef);

		terminal.onData((data: string) => {
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
		});

		terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'resize', cols, rows }));
			}
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
			// Now that we're connected, render the terminal
			openTerminal();
		};

		ws.onmessage = (event) => {
			if (!terminal) return;
			const data =
				event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : event.data;
			terminal.write(data);
		};

		ws.onclose = () => {
			connected = false;
			if (terminal) {
				terminal.write('\r\n\x1b[90m--- disconnected ---\x1b[0m\r\n');
			}
		};

		ws.onerror = () => {
			connected = false;
			error = 'Connection failed';
		};
	}

	function reconnect() {
		error = null;
		ws?.close();
		ws = null;
		if (terminal) {
			terminal.write('\x1b[2J\x1b[H');
		}
		connectWebSocket();
	}

	$effect(() => {
		if (visible && fitAddon) {
			requestAnimationFrame(() => fitAddon?.fit());
		}
	});

	onMount(() => {
		mounted = true;
		init();
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		ws?.close();
		terminal?.dispose();
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
		background: #0d1117;
	}

	.pod-terminal--hidden {
		display: none;
	}

	.pod-terminal-canvas {
		flex: 1;
		min-height: 0;
		padding: 0.75rem;
	}

	.pod-terminal-canvas :global(.terminal),
	.pod-terminal-canvas :global(canvas) {
		height: 100% !important;
		width: 100% !important;
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
		font-size: 0.625rem;
		font-family: var(--font-mono);
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
	}

	.pod-terminal-error {
		background: rgba(248, 81, 73, 0.12);
		color: #f85149;
		border: 1px solid rgba(248, 81, 73, 0.2);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.pod-terminal-error button {
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: rgba(248, 81, 73, 0.2);
		color: #f85149;
		font-size: 0.625rem;
		border: none;
		cursor: pointer;
	}
	.pod-terminal-error button:hover {
		background: rgba(248, 81, 73, 0.3);
	}

	.pod-terminal-connecting {
		background: rgba(201, 209, 217, 0.06);
		color: rgba(201, 209, 217, 0.4);
		pointer-events: none;
	}
</style>
