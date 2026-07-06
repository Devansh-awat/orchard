<script lang="ts">
	import { ArrowLeft, Copy, Check } from 'lucide-svelte';
	import { env } from '$env/dynamic/public';
	import { toasts } from '$lib/stores';

	const MCP_URL = env.PUBLIC_MCP_URL || 'https://mcp.orchard.my';

	let copiedId = $state<string | null>(null);

	function copy(text: string, id: string) {
		navigator.clipboard.writeText(text).then(() => {
			copiedId = id;
			toasts.add({ title: 'Copied to clipboard', color: 'success' });
			setTimeout(() => {
				copiedId = null;
			}, 2000);
		});
	}
</script>

<div class="settings-page">
	<div class="settings-container">
		<div class="settings-header">
			<button onclick={() => window.history.back()} class="settings-back-btn">
				<ArrowLeft class="h-4 w-4" />
				Back
			</button>

			<div class="settings-title-row">
				<div class="settings-avatar">
					<svg class="h-5 w-5" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg"
						><path
							d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/><path
							d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/><path
							d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822"
							stroke="currentColor"
							stroke-width="12"
							stroke-linecap="round"
						/></svg
					>
				</div>
				<div>
					<h1 class="settings-title">MCP Server</h1>
					<p class="settings-subtitle">
						Connect AI assistants to Orchard via Model Context Protocol
					</p>
				</div>
			</div>
		</div>

		<!-- What is MCP -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">What is MCP?</p>
						<p class="settings-section-desc">
							Model Context Protocol lets AI tools manage your infrastructure
						</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="mcp-desc">
					The Orchard MCP server allows AI assistants like Claude to manage your apps, databases,
					environment variables, networking, and more
				</p>
			</div>
		</section>

		<!-- Claude.ai (Remote MCP) -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">Claude.ai</p>
						<p class="settings-section-desc">Add as a remote MCP server in Claude.ai settings</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="settings-hint">
					Go to <strong>Settings &rarr; Connectors</strong>, scroll to the bottom and click
					<strong>Add custom connector</strong>, then enter the URL below. You'll be prompted to
					sign in with your Orchard account to authorize access.
				</p>

				<div class="mcp-field">
					<p class="settings-field-label">Server URL</p>
					<div class="mcp-copy-row">
						<code class="mcp-value">{MCP_URL}</code>
						<button class="btn btn-ghost btn-sm" onclick={() => copy(MCP_URL, 'claude-url')}>
							{#if copiedId === 'claude-url'}
								<Check class="h-3.5 w-3.5" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
				</div>
			</div>
		</section>

		<!-- Claude Code / CLI -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">Claude Code</p>
						<p class="settings-section-desc">
							Add to your project's .mcp.json or Claude Code settings
						</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="settings-hint">
					Claude Code supports remote MCP servers with OAuth. Add the following to <code
						>.mcp.json</code
					> in your project root, or to your global Claude Code settings. You'll be prompted to authorize
					on first use.
				</p>

				<div class="mcp-field">
					<div class="mcp-copy-row" style="justify-content: space-between;">
						<p class="settings-field-label">.mcp.json</p>
						<button
							class="btn btn-ghost btn-sm"
							onclick={() =>
								copy(
									`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`,
									'claude-code'
								)}
						>
							{#if copiedId === 'claude-code'}
								<Check class="h-3.5 w-3.5" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
					<pre class="usage-code">{`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="settings-hint">
					Or add it from the terminal with
					<code>claude mcp add --transport http orchard {MCP_URL}</code>, then run
					<code>/mcp</code> inside Claude Code to authenticate.
				</p>
			</div>
		</section>

		<!-- VS Code -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">VS Code</p>
						<p class="settings-section-desc">Add to your workspace or user MCP configuration</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="settings-hint">
					Open the Command Palette (<kbd>Shift+Cmd+P</kbd>) and run
					<strong>MCP: Add Server</strong>, or create <code>.vscode/mcp.json</code> in your project. VS
					Code will handle OAuth automatically.
				</p>

				<div class="mcp-field">
					<div class="mcp-copy-row" style="justify-content: space-between;">
						<p class="settings-field-label">.vscode/mcp.json</p>
						<button
							class="btn btn-ghost btn-sm"
							onclick={() =>
								copy(
									`{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`,
									'vscode'
								)}
						>
							{#if copiedId === 'vscode'}
								<Check class="h-3.5 w-3.5" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
					<pre class="usage-code">{`{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="settings-hint">
					You can also add it to your user profile by running <strong
						>MCP: Open User Configuration</strong
					> from the Command Palette.
				</p>
			</div>
		</section>

		<!-- Cursor -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">Cursor</p>
						<p class="settings-section-desc">
							Add to your project or global Cursor MCP configuration
						</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="settings-hint">
					Create <code>.cursor/mcp.json</code> in your project root for project-specific access, or
					<code>~/.cursor/mcp.json</code> for global access across all projects.
				</p>

				<div class="mcp-field">
					<div class="mcp-copy-row" style="justify-content: space-between;">
						<p class="settings-field-label">.cursor/mcp.json</p>
						<button
							class="btn btn-ghost btn-sm"
							onclick={() =>
								copy(
									`{
  "mcpServers": {
    "orchard": {
      "url": "${MCP_URL}"
    }
  }
}`,
									'cursor'
								)}
						>
							{#if copiedId === 'cursor'}
								<Check class="h-3.5 w-3.5" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
					<pre class="usage-code">{`{
  "mcpServers": {
    "orchard": {
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="settings-hint">
					Cursor handles OAuth automatically. You'll be redirected to sign in on first use.
				</p>
			</div>
		</section>

		<!-- API Token auth -->
		<section class="settings-section">
			<div class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">Token Authentication</p>
						<p class="settings-section-desc">For tools that don't support OAuth</p>
					</div>
				</div>
			</div>

			<div class="settings-section-content">
				<p class="settings-hint">
					If your MCP client doesn't support OAuth, you can authenticate with an API token instead.
					Create one in <a href="/user/api-tokens">API Tokens</a>, then pass it as a Bearer token in
					the Authorization header.
				</p>

				<div class="mcp-field">
					<div class="mcp-copy-row" style="justify-content: space-between;">
						<p class="settings-field-label">Configuration with token</p>
						<button
							class="btn btn-ghost btn-sm"
							onclick={() =>
								copy(
									`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}`,
									'token-config'
								)}
						>
							{#if copiedId === 'token-config'}
								<Check class="h-3.5 w-3.5" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
					<pre class="usage-code">{`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}`}</pre>
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.settings-page {
		padding: 2.5rem 2.5rem 3rem;
		max-width: 42rem;
		margin: 0 auto;
	}

	.settings-container {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.settings-header {
		margin-bottom: 2rem;
	}

	.settings-back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--surface-muted);
		cursor: pointer;
		margin-bottom: 1rem;
		transition: color 120ms ease;
	}

	.settings-back-btn:hover {
		color: var(--center-channel-color);
	}

	.settings-title-row {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.settings-avatar {
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.settings-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
		letter-spacing: -0.02em;
	}

	.settings-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
	}

	.settings-section {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		overflow: hidden;
		background-color: var(--surface-bg);
		margin-bottom: 0.5rem;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.settings-section-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 1.125rem 1.375rem;
		background: transparent;
		color: var(--center-channel-color);
	}

	.settings-section-trigger-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.settings-section-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		text-align: left;
		letter-spacing: -0.01em;
	}

	.settings-section-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		text-align: left;
	}

	.settings-section-content {
		padding: 0 1.375rem 1.375rem;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		border-top: 1px solid var(--surface-border);
		padding-top: 1.125rem;
	}

	.settings-field-label {
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.settings-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		line-height: 1.55;
	}

	.settings-hint a {
		color: var(--link-color);
		text-decoration: none;
	}

	.settings-hint a:hover {
		text-decoration: underline;
	}

	.settings-hint code {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
	}

	.mcp-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		line-height: 1.6;
	}

	.mcp-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.mcp-copy-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.mcp-value {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		user-select: all;
	}

	.usage-code {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		padding: 0.875rem 1.125rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		overflow-x: auto;
		white-space: pre;
		line-height: 1.6;
		margin: 0;
	}
</style>
