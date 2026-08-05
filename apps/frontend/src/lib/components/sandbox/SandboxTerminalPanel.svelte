<script lang="ts">
	import { Check, Copy, RotateCw } from 'lucide-svelte';

	let {
		sandboxId,
		name,
		running,
		active
	}: {
		sandboxId: string;
		name: string;
		running: boolean;
		active: boolean;
	} = $props();

	type Rgba = [number, number, number, number];

	let hostEl = $state<HTMLDivElement | undefined>(undefined);
	let status = $state<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle');
	let detail = $state<string | null>(null);
	let copied = $state(false);

	let term: any = null;
	let fit: any = null;
	let ghostty: any = null;
	let socket: WebSocket | null = null;
	let observer: ResizeObserver | null = null;
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let live = false;

	const command = $derived(`orchard sandbox ssh ${name}`);
	const statusLabel = $derived(
		status === 'connecting'
			? 'Connecting…'
			: status === 'closed' || status === 'error'
				? (detail ?? 'Shell closed')
				: ''
	);

	function readRgba(probe: HTMLElement, token: string): Rgba {
		probe.style.color = '';
		probe.style.color = `var(${token})`;
		const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
		if (!parts || parts.length < 3) return [0, 0, 0, 1];
		return [
			Number(parts[0]),
			Number(parts[1]),
			Number(parts[2]),
			parts[3] === undefined ? 1 : Number(parts[3])
		];
	}

	function channel(value: number): string {
		return Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, '0');
	}

	function flatten(color: Rgba, backdrop: Rgba): string {
		const alpha = color[3];
		const mix = (i: number) => color[i] * alpha + backdrop[i] * (1 - alpha);
		return `#${channel(mix(0))}${channel(mix(1))}${channel(mix(2))}`;
	}

	function buildTheme(probe: HTMLElement) {
		const backdrop = readRgba(probe, '--bg-app');
		const pick = (token: string) => flatten(readRgba(probe, token), backdrop);
		return {
			background: pick('--bg-app'),
			foreground: pick('--text-default'),
			cursor: pick('--accent'),
			cursorAccent: pick('--bg-app'),
			selectionBackground: pick('--accent-subtle'),
			black: pick('--bg-sunken'),
			red: pick('--status-error'),
			green: pick('--status-success'),
			yellow: pick('--status-warning'),
			blue: pick('--hue-blue'),
			magenta: pick('--hue-violet'),
			cyan: pick('--hue-emerald'),
			white: pick('--text-muted'),
			brightBlack: pick('--text-faint'),
			brightRed: pick('--hue-red'),
			brightGreen: pick('--hue-green'),
			brightYellow: pick('--hue-amber'),
			brightBlue: pick('--hue-blue'),
			brightMagenta: pick('--hue-pink'),
			brightCyan: pick('--hue-emerald'),
			brightWhite: pick('--text-default')
		};
	}

	function sendResize() {
		if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
	}

	function openTerminal() {
		if (!hostEl || term) return;
		const probe = document.createElement('span');
		probe.style.display = 'none';
		hostEl.appendChild(probe);
		const theme = buildTheme(probe);
		probe.remove();

		const mono = getComputedStyle(hostEl).getPropertyValue('--font-mono').trim();
		term = new ghostty.Terminal({
			fontSize: 12,
			fontFamily: mono || 'monospace',
			cursorBlink: true,
			cursorStyle: 'bar',
			theme
		});
		fit = new ghostty.FitAddon();
		term.loadAddon(fit);
		term.open(hostEl);
		fit.fit();

		term.onData((data: string) => {
			if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
		});
		term.onResize(() => sendResize());

		observer = new ResizeObserver(() => {
			if (!live || !fit) return;
			try {
				fit.fit();
			} catch {
				return;
			}
		});
		observer.observe(hostEl);
		term.focus();
	}

	function connect() {
		const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
		status = 'connecting';
		detail = null;
		const ws = new WebSocket(`${scheme}//${location.host}/apiv1/sandboxes/${sandboxId}/terminal`);
		socket = ws;
		ws.binaryType = 'arraybuffer';

		ws.onopen = () => {
			if (socket !== ws) return;
			status = 'open';
			sendResize();
			term?.focus();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (socket !== ws || !term) return;
			const text =
				event.data instanceof ArrayBuffer
					? new TextDecoder().decode(event.data)
					: (event.data as string);
			term.write(text);
		};
		ws.onclose = (event: CloseEvent) => {
			if (socket !== ws) return;
			status = 'closed';
			detail = event.code === 4401 ? 'Access revoked' : 'Shell closed';
		};
		ws.onerror = () => {
			if (socket !== ws) return;
			status = 'error';
			detail = 'Connection failed';
		};
	}

	async function start() {
		status = 'connecting';
		detail = null;
		try {
			if (!ghostty) {
				const mod = await import('ghostty-web');
				await mod.init();
				ghostty = mod;
			}
		} catch {
			status = 'error';
			detail = 'Could not load the terminal';
			return;
		}
		if (!live || !hostEl) return;
		openTerminal();
		connect();
	}

	function stop() {
		observer?.disconnect();
		observer = null;
		const ws = socket;
		socket = null;
		if (ws) {
			ws.onopen = null;
			ws.onmessage = null;
			ws.onclose = null;
			ws.onerror = null;
			try {
				ws.close();
			} catch {
				/* already closing */
			}
		}
		try {
			term?.dispose();
		} catch {
			/* already disposed */
		}
		term = null;
		fit = null;
		if (hostEl) hostEl.replaceChildren();
		status = 'idle';
		detail = null;
	}

	function reconnect() {
		stop();
		live = active && running && !!hostEl;
		if (live) start();
	}

	async function copyCommand() {
		await navigator.clipboard.writeText(command);
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1500);
	}

	$effect(() => {
		const want = active && running && !!hostEl;
		if (want === live) return;
		live = want;
		if (want) start();
		else stop();
	});

	$effect(() => {
		return () => {
			live = false;
			if (copyTimer) clearTimeout(copyTimer);
			stop();
		};
	});
</script>

<div class="term-root">
	{#if !running}
		<p class="term-note">Start the sandbox to open a shell.</p>
	{:else}
		<div class="term-surface">
			<div class="term-host" bind:this={hostEl}></div>
			{#if statusLabel}
				<div class="term-status">
					<span class="term-status-text">{statusLabel}</span>
					{#if status === 'closed' || status === 'error'}
						<button type="button" class="term-retry" onclick={reconnect}>
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

	.term-note {
		padding: 1.25rem 0.75rem;
		text-align: center;
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.term-surface {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 0.375rem 0.25rem 0.25rem 0.5rem;
	}

	.term-host {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.term-status {
		position: absolute;
		right: 0.625rem;
		bottom: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.1875rem 0.4375rem;
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
		gap: 0.25rem;
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
		gap: 0.375rem;
		flex-shrink: 0;
		padding: 0.3125rem 0.375rem 0.375rem 0.625rem;
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
