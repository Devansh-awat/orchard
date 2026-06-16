<script lang="ts">
	import { Plus, Loader2, Lock, TriangleAlert, ExternalLink, Webhook } from 'lucide-svelte';
	import { Check, Copy, RefreshCw, Boxes, Trash2, X } from '@jis3r/icons';
	import { slide } from 'svelte/transition';
	import type { WebhookToken } from '$lib/types/deployment';

	let {
		deploymentId,
		webhookTokens,
		webhookTokensLoading,
		creatingWebhookToken,
		deletingWebhookTokenId,
		onCreateToken,
		onDeleteToken
	}: {
		deploymentId: string;
		webhookTokens: WebhookToken[];
		webhookTokensLoading: boolean;
		creatingWebhookToken: boolean;
		deletingWebhookTokenId: string | null;
		onCreateToken: (label: string) => void;
		onDeleteToken: (tokenId: string) => void;
	} = $props();

	let newWebhookLabel = $state('');
	let newlyCreatedToken = $state<string | null>(null);
	let copiedWebhookToken = $state(false);
	let copiedWebhookUrl = $state(false);

	function copyToClipboard(text: string, type: 'token' | 'url') {
		navigator.clipboard.writeText(text);
		if (type === 'token') {
			copiedWebhookToken = true;
			setTimeout(() => (copiedWebhookToken = false), 2000);
		} else {
			copiedWebhookUrl = true;
			setTimeout(() => (copiedWebhookUrl = false), 2000);
		}
	}

	function getWebhookUrl(token: string): string {
		const base = window.location.origin;
		return `${base}/apiv1/webhooks/deploy/${token}`;
	}

	function handleCreate() {
		onCreateToken(newWebhookLabel);
		newWebhookLabel = '';
	}

	const webhookExamples = {
		restart: `curl -X POST YOUR_WEBHOOK_URL`,
		updateTag: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"tag": "v1.2.3"}'`,
		updateImage: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"image": "ghcr.io/org/app", "tag": "sha-abc123"}'`,
		githubActions: `# .github/workflows/deploy.yml
- name: Trigger deploy
  run: |
    curl -s -X POST \\
      \${{ secrets.WEBHOOK_URL }} \\
      -H "Content-Type: application/json" \\
      -d '{"tag": "\${{ github.sha }}"}'`
	};
</script>

<div class="space-y-5">
	<!-- Intro + Create -->
	<div class="card rounded-2xl overflow-hidden">
		<div class="p-5">
			<div class="flex items-start gap-3 mb-4">
				<div class="wh-icon-wrap">
					<Webhook class="h-5 w-5" />
				</div>
				<div>
					<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
						Deploy with webhooks
					</p>
				</div>
			</div>

			<!-- Create token -->
			<div class="wh-create-row">
				<input
					type="text"
					class="input text-sm flex-1"
					placeholder="Label this token (e.g. github-actions, ci-prod)"
					bind:value={newWebhookLabel}
				/>
				<button
					class="btn btn-primary btn-sm"
					onclick={handleCreate}
					disabled={creatingWebhookToken}
				>
					{#if creatingWebhookToken}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus
							class="h-3.5 w-3.5"
						/>{/if}
					<span>Create token</span>
				</button>
			</div>
		</div>

		<!-- Newly created token banner -->
		{#if newlyCreatedToken}
			<div class="wh-new-token-banner" transition:slide={{ duration: 150 }}>
				<div class="wh-new-token-header">
					<div class="wh-new-token-alert">
						<TriangleAlert size={16} class="h-4 w-4" />
						<span class="text-sm font-semibold">Save your token now</span>
					</div>
					<p class="text-xs mt-0.5" style="opacity: 0.85;">
						This is the only time the token value will be shown. Copy it somewhere safe.
					</p>
				</div>
				<div class="wh-new-token-fields">
					<div>
						<p class="wh-new-token-label">Token</p>
						<div class="wh-new-token-value-row">
							<code class="wh-new-token-code">{newlyCreatedToken}</code>
							<button
								class="btn btn-ghost btn-sm wh-copy-btn"
								onclick={() => copyToClipboard(newlyCreatedToken!, 'token')}
							>
								{#if copiedWebhookToken}<Check size={14} class="h-3.5 w-3.5" /><span>Copied</span
									>{:else}<Copy size={14} class="h-3.5 w-3.5" /><span>Copy</span>{/if}
							</button>
						</div>
					</div>
					<div>
						<p class="wh-new-token-label">Webhook URL</p>
						<div class="wh-new-token-value-row">
							<code class="wh-new-token-code">{getWebhookUrl(newlyCreatedToken)}</code>
							<button
								class="btn btn-ghost btn-sm wh-copy-btn"
								onclick={() => copyToClipboard(getWebhookUrl(newlyCreatedToken!), 'url')}
							>
								{#if copiedWebhookUrl}<Check size={14} class="h-3.5 w-3.5" /><span>Copied</span
									>{:else}<Copy size={14} class="h-3.5 w-3.5" /><span>Copy</span>{/if}
							</button>
						</div>
					</div>
				</div>
				<button
					class="btn btn-ghost btn-sm wh-dismiss-btn"
					onclick={() => (newlyCreatedToken = null)}
				>
					<X size={14} />
					<span>Dismiss</span>
				</button>
			</div>
		{/if}

		<!-- Token list -->
		<div class="adv-divider"></div>
		<div class="p-5">
			{#if webhookTokensLoading}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted);" />
				</div>
			{:else if webhookTokens.length === 0 && !newlyCreatedToken}
				<div class="wh-empty-state">
					<div class="wh-empty-icon">
						<Lock class="h-5 w-5" />
					</div>
					<p class="text-sm font-medium" style="color: var(--center-channel-color);">
						No tokens yet
					</p>
					<p class="text-xs" style="color: var(--surface-muted);">
						Create a token above to get started with webhook deploys.
					</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each webhookTokens as token}
						<div class="wh-token-card" transition:slide={{ duration: 120 }}>
							<div class="wh-token-icon">
								<Lock class="h-3.5 w-3.5" />
							</div>
							<div class="wh-token-info">
								<p class="wh-token-name">{token.label || 'Unnamed token'}</p>
								<p class="wh-token-meta">
									Created {new Date(token.createdAt).toLocaleDateString('en-US', {
										month: 'short',
										day: 'numeric',
										year: 'numeric'
									})}
									{#if token.lastUsedAt}
										<span class="wh-token-sep">&middot;</span> Last used {new Date(
											token.lastUsedAt
										).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
									{:else}
										<span class="wh-token-sep">&middot;</span>
										<span class="wh-token-unused">Never used</span>
									{/if}
								</p>
							</div>
							<button
								class="btn btn-ghost btn-sm wh-delete-btn"
								onclick={() => onDeleteToken(token.id)}
								disabled={deletingWebhookTokenId === token.id}
								title="Delete token"
							>
								{#if deletingWebhookTokenId === token.id}<Loader2
										class="h-3.5 w-3.5 animate-spin"
									/>{:else}<Trash2 size={14} class="h-3.5 w-3.5" />{/if}
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Quick reference -->
	<div class="card rounded-2xl overflow-hidden">
		<div class="p-5 pb-0">
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
				Quick reference
			</p>
			<p class="text-xs mt-0.5 mb-4" style="color: var(--surface-muted);">
				Replace <code class="wh-inline-code">YOUR_WEBHOOK_URL</code> with the URL from your token above.
			</p>
		</div>

		<div class="wh-examples">
			<details class="wh-example-item" open>
				<summary class="wh-example-summary">
					<div class="wh-example-summary-left">
						<span style="color: var(--surface-muted);"
							><RefreshCw size={14} class="h-3.5 w-3.5" /></span
						>
						<span class="wh-example-title">Restart deployment</span>
					</div>
					<span class="wh-example-method">POST</span>
				</summary>
				<pre class="wh-code-block"><code>{webhookExamples.restart}</code></pre>
			</details>

			<details class="wh-example-item">
				<summary class="wh-example-summary">
					<div class="wh-example-summary-left">
						<span style="color: var(--surface-muted);"
							><RefreshCw size={14} class="h-3.5 w-3.5" /></span
						>
						<span class="wh-example-title">Update to a specific tag</span>
					</div>
					<span class="wh-example-method">POST + JSON</span>
				</summary>
				<pre class="wh-code-block"><code>{webhookExamples.updateTag}</code></pre>
			</details>

			<details class="wh-example-item">
				<summary class="wh-example-summary">
					<div class="wh-example-summary-left">
						<span style="color: var(--surface-muted);"><Boxes size={14} class="h-3.5 w-3.5" /></span
						>
						<span class="wh-example-title">Update image and tag</span>
					</div>
					<span class="wh-example-method">POST + JSON</span>
				</summary>
				<pre class="wh-code-block"><code>{webhookExamples.updateImage}</code></pre>
			</details>
		</div>

		<!-- GitHub Actions highlight -->
		<div class="wh-gh-actions-section">
			<div class="wh-gh-actions-header">
				<ExternalLink class="h-3.5 w-3.5" />
				<span class="text-xs font-semibold">GitHub Actions</span>
			</div>
			<p class="text-xs mb-3" style="color: var(--surface-muted);">
				Add this step to your workflow. Store the webhook URL as a repository secret named <code
					class="wh-inline-code">WEBHOOK_URL</code
				>.
			</p>
			<pre class="wh-code-block"><code>{webhookExamples.githubActions}</code></pre>
		</div>
	</div>
</div>
