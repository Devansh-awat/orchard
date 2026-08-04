<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';
	import { SectionCard } from '$lib/components/ui';

	let { name }: { name: string } = $props();

	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	const sshCommand = $derived(`orchard sandbox ssh ${name}`);
	const sshConfig = $derived(`Host orchard-sandbox-${name}
  User dev
  ProxyCommand orchard sandbox proxy ${name}
  StrictHostKeyChecking accept-new`);

	async function copy(key: string, text: string) {
		await navigator.clipboard.writeText(text);
		copiedKey = key;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copiedKey = null), 1500);
	}
</script>

<SectionCard title="Connect" description="SSH into your sandbox with the Orchard CLI.">
	<div class="scp-body">
		<div class="scp-block">
			<div class="scp-code-row">
				<code class="scp-code">{sshCommand}</code>
				<button
					type="button"
					class="scp-copy"
					aria-label="Copy SSH command"
					onclick={() => copy('ssh', sshCommand)}
				>
					{#if copiedKey === 'ssh'}<Check size={14} />{:else}<Copy size={14} />{/if}
				</button>
			</div>
			<p class="scp-hint">
				Starts a stopped sandbox on demand. Needs the <a href="/cli" class="scp-link">Orchard CLI</a> signed
				in.
			</p>
		</div>
		<div class="scp-block">
			<p class="scp-label">SSH config</p>
			<div class="scp-code-row scp-code-row--multi">
				<pre class="scp-code scp-code--multi">{sshConfig}</pre>
				<button
					type="button"
					class="scp-copy"
					aria-label="Copy SSH config"
					onclick={() => copy('config', sshConfig)}
				>
					{#if copiedKey === 'config'}<Check size={14} />{:else}<Copy size={14} />{/if}
				</button>
			</div>
			<p class="scp-hint">
				Add this to ~/.ssh/config, then plain ssh, scp, and VS Code Remote-SSH can reach
				orchard-sandbox-{name}. In VS Code, run "Remote-SSH: Connect to Host" and pick it from the
				list.
			</p>
		</div>
	</div>
</SectionCard>

<style>
	.scp-body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.scp-block {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.scp-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.scp-code-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
	}

	.scp-code-row--multi {
		align-items: flex-start;
	}

	.scp-code {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-default);
		overflow-x: auto;
		white-space: nowrap;
	}

	.scp-code--multi {
		white-space: pre;
		margin: 0;
	}

	.scp-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.scp-copy:hover {
		background-color: var(--bg-hover);
		color: var(--text-default);
	}

	.scp-hint {
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.scp-link {
		color: var(--accent);
		text-decoration: none;
	}

	.scp-link:hover {
		text-decoration: underline;
	}
</style>
