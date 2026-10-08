<script lang="ts">
	import { ExternalLink, Globe, RotateCw } from 'lucide-svelte';
	import type { CenterTab } from './types';
	import type { MachineWorkspace } from './workspace.svelte';

	let { ws, tab }: { ws: MachineWorkspace; tab: Extract<CenterTab, { kind: 'preview' }> } =
		$props();

	let frame = $state<HTMLIFrameElement | null>(null);
	let nonce = $state(0);
	let loading = $state(true);

	const display = $derived.by(() => {
		if (!tab.url) return `localhost:${tab.port}`;
		try {
			const url = new URL(tab.url);
			return `${url.host}${url.pathname === '/__orchard_preview' ? '/' : url.pathname}`;
		} catch {
			return tab.url;
		}
	});

	async function reload() {
		loading = true;
		await ws.refreshPreview(tab.port);
		nonce += 1;
	}

	function external() {
		if (tab.url) window.open(tab.url, '_blank', 'noopener');
	}
</script>

<div class="preview">
	<div class="bar">
		<button
			type="button"
			class="gh-ibtn"
			aria-label="Reload preview"
			title="Reload"
			onclick={reload}
		>
			<RotateCw size={14} strokeWidth={1.75} />
		</button>
		<div class="url">
			<Globe size={13} strokeWidth={1.75} />
			<span class="gh-mono">{display}</span>
			<span class="port gh-num">:{tab.port}</span>
		</div>
		<button
			type="button"
			class="gh-ibtn"
			aria-label="Open in a new tab"
			title="Open in a new tab"
			disabled={!tab.url}
			onclick={external}
		>
			<ExternalLink size={14} strokeWidth={1.75} />
		</button>
	</div>
	<div class="stage">
		{#if tab.url}
			{#key `${tab.url}:${nonce}`}
				<iframe
					bind:this={frame}
					src={tab.url}
					title="Preview of port {tab.port}"
					sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
					onload={() => (loading = false)}
				></iframe>
			{/key}
			{#if loading}<div class="veil">Loading preview…</div>{/if}
		{:else}
			<div class="veil">
				<p>No preview address for port {tab.port} yet.</p>
				<button type="button" class="gh-btn" onclick={reload}>Try again</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.preview {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		height: 2.25rem;
		padding: 0 0.375rem;
		border-bottom: 1px solid var(--gh-line);
	}

	.url {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
		height: 1.5rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-pill);
		background: var(--gh-hover);
		color: var(--gh-muted);
		font-size: var(--gh-caption);
	}

	.url span:first-of-type {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-text);
		font-size: var(--gh-caption);
	}

	.port {
		margin-left: auto;
		color: var(--gh-faint);
	}

	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		background: var(--bg-raised);
	}

	iframe {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--bg-raised);
	}

	.veil {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		color: var(--gh-muted);
		background: var(--gh-editor);
	}

	.veil p {
		margin: 0;
	}
</style>
