<script lang="ts">
	import { onDestroy } from 'svelte';
	import { RefreshCw } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { ansiToHtmlLines } from '$lib/utils/format';

	let {
		runId,
		stepOrder,
		running = false
	}: {
		runId: string;
		stepOrder: number;
		running?: boolean;
	} = $props();

	let logs = $state('');
	let loading = $state(false);
	let loaded = $state(false);
	let truncated = $state(false);
	let outputEl = $state<HTMLPreElement | null>(null);
	let scrolledUp = false;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const logLines = $derived.by(() => {
		if (!logs) return [];
		const seen = new Map<string, number>();
		return ansiToHtmlLines(logs).map((html) => {
			const n = seen.get(html) ?? 0;
			seen.set(html, n + 1);
			return { key: n ? `${html}#${n}` : html, html };
		});
	});

	async function fetchLogs() {
		if (loading) return;
		loading = true;
		try {
			const res = await apiFetch(`/apiv1/job-runs/${runId}/steps/${stepOrder}/logs`);
			if (res.ok) {
				const data = await res.json();
				logs = data.logs ?? '';
				truncated = Boolean(data.truncated);
				loaded = true;
				if (!scrolledUp) scrollToBottom();
			}
		} finally {
			loading = false;
		}
	}

	function scrollToBottom() {
		requestAnimationFrame(() => {
			if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
		});
	}

	function onScroll() {
		if (!outputEl) return;
		scrolledUp = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight > 60;
	}

	let wasRunning = false;
	$effect(() => {
		if (!loaded && !loading) fetchLogs().catch(() => {});
		if (running && !pollTimer) {
			pollTimer = setInterval(() => {
				fetchLogs().catch(() => {});
			}, 2000);
		} else if (!running && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
			if (wasRunning) fetchLogs().catch(() => {});
		}
		wasRunning = running;
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
</script>

<div class="job-logs-shell">
	<div class="job-logs">
		<div class="job-logs-toolbar">
			<span class="job-logs-label">
				{#if running}<span class="job-logs-live-dot"></span>{/if}
				stdout
			</span>
			{#if truncated}
				<span class="job-logs-truncated">older output truncated</span>
			{/if}
			<button
				type="button"
				class="job-logs-refresh"
				aria-label="Refresh logs"
				onclick={() => {
					fetchLogs().catch(() => {});
				}}
				disabled={loading}
			>
				<RefreshCw size={13} class={loading ? 'animate-spin' : ''} />
			</button>
		</div>
		<pre
			bind:this={outputEl}
			class="job-logs-output"
			onscroll={onScroll}>{#if logLines.length === 0}<span class="job-logs-empty"
					>{loaded ? 'No output' : 'Loading…'}</span
				>{:else}{#each logLines as { key, html } (key)}<div>{@html html}</div>{/each}{/if}</pre>
	</div>
</div>
