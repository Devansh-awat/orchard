<script lang="ts">
	import {
		Copy,
		Check,
		Plug,
		Sparkles,
		Terminal,
		CodeXml,
		MousePointer2,
		KeyRound
	} from 'lucide-svelte';
	import { env } from '$env/dynamic/public';
	import { toasts } from '$lib/stores';
	import SettingsSection from './SettingsSection.svelte';
	import IconButton from './IconButton.svelte';

	const MCP_URL = env.PUBLIC_MCP_URL || '';

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

<div class="settings-body">
	<SettingsSection
		index={0}
		title="What is MCP?"
		description="Model Context Protocol lets AI tools manage your infrastructure"
	>
		{#snippet icon(_hovered)}<Plug class="h-[18px] w-[18px]" />{/snippet}
		<div class="mcp-body">
			<p class="mcp-desc">
				The Orchard MCP server allows AI assistants like Claude to manage your apps, databases,
				environment variables, networking, and more
			</p>
			{#if !MCP_URL}
				<p class="mcp-hint">
					This instance has not published an MCP endpoint yet, so there is nothing to connect to. An
					instance admin turns it on with <code>sudo orchardctl mcp enable</code> on the host, or by
					setting <code>mcp.ingress.host</code> in the chart values.
				</p>
			{/if}
		</div>
	</SettingsSection>

	{#if MCP_URL}
		<SettingsSection
			index={1}
			title="Claude.ai"
			description="Add as a remote MCP server in Claude.ai settings"
		>
			{#snippet icon(_hovered)}<Sparkles class="h-[18px] w-[18px]" />{/snippet}
			<div class="mcp-body">
				<p class="mcp-hint">
					Go to <strong>Settings &rarr; Connectors</strong>, scroll to the bottom and click
					<strong>Add custom connector</strong>, then enter the URL below. You'll be prompted to
					sign in with your Orchard account to authorize access.
				</p>

				<div class="mcp-field">
					<p class="mcp-label">Server URL</p>
					<div class="mcp-copy-row">
						<code class="mcp-value">{MCP_URL}</code>
						<IconButton title="Copy server URL" onclick={() => copy(MCP_URL, 'claude-url')}>
							{#snippet children(_hovered)}
								{#if copiedId === 'claude-url'}
									<Check class="h-3.5 w-3.5" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							{/snippet}
						</IconButton>
					</div>
				</div>
			</div>
		</SettingsSection>

		<SettingsSection
			index={2}
			title="Claude Code"
			description="Add to your project's .mcp.json or Claude Code settings"
		>
			{#snippet icon(_hovered)}<Terminal class="h-[18px] w-[18px]" />{/snippet}
			<div class="mcp-body">
				<p class="mcp-hint">
					Claude Code supports remote MCP servers with OAuth. Add the following to <code
						>.mcp.json</code
					> in your project root, or to your global Claude Code settings. You'll be prompted to authorize
					on first use.
				</p>

				<div class="mcp-field">
					<div class="mcp-block-head">
						<p class="mcp-label">.mcp.json</p>
						<IconButton
							title="Copy configuration"
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
							{#snippet children(_hovered)}
								{#if copiedId === 'claude-code'}
									<Check class="h-3.5 w-3.5" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							{/snippet}
						</IconButton>
					</div>
					<pre class="mcp-code">{`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="mcp-hint">
					Or add it from the terminal with
					<code>claude mcp add --transport http orchard {MCP_URL}</code>, then run
					<code>/mcp</code> inside Claude Code to authenticate.
				</p>
			</div>
		</SettingsSection>

		<SettingsSection
			index={3}
			title="VS Code"
			description="Add to your workspace or user MCP configuration"
		>
			{#snippet icon(_hovered)}<CodeXml class="h-[18px] w-[18px]" />{/snippet}
			<div class="mcp-body">
				<p class="mcp-hint">
					Open the Command Palette (<kbd>Shift+Cmd+P</kbd>) and run
					<strong>MCP: Add Server</strong>, or create <code>.vscode/mcp.json</code> in your project. VS
					Code will handle OAuth automatically.
				</p>

				<div class="mcp-field">
					<div class="mcp-block-head">
						<p class="mcp-label">.vscode/mcp.json</p>
						<IconButton
							title="Copy configuration"
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
							{#snippet children(_hovered)}
								{#if copiedId === 'vscode'}
									<Check class="h-3.5 w-3.5" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							{/snippet}
						</IconButton>
					</div>
					<pre class="mcp-code">{`{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="mcp-hint">
					You can also add it to your user profile by running <strong
						>MCP: Open User Configuration</strong
					> from the Command Palette.
				</p>
			</div>
		</SettingsSection>

		<SettingsSection
			index={4}
			title="Cursor"
			description="Add to your project or global Cursor MCP configuration"
		>
			{#snippet icon(_hovered)}<MousePointer2 class="h-[18px] w-[18px]" />{/snippet}
			<div class="mcp-body">
				<p class="mcp-hint">
					Create <code>.cursor/mcp.json</code> in your project root for project-specific access, or
					<code>~/.cursor/mcp.json</code> for global access across all projects.
				</p>

				<div class="mcp-field">
					<div class="mcp-block-head">
						<p class="mcp-label">.cursor/mcp.json</p>
						<IconButton
							title="Copy configuration"
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
							{#snippet children(_hovered)}
								{#if copiedId === 'cursor'}
									<Check class="h-3.5 w-3.5" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							{/snippet}
						</IconButton>
					</div>
					<pre class="mcp-code">{`{
  "mcpServers": {
    "orchard": {
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
				</div>

				<p class="mcp-hint">
					Cursor handles OAuth automatically. You'll be redirected to sign in on first use.
				</p>
			</div>
		</SettingsSection>

		<SettingsSection
			index={5}
			title="Token Authentication"
			description="For tools that don't support OAuth"
		>
			{#snippet icon(_hovered)}<KeyRound class="h-[18px] w-[18px]" />{/snippet}
			<div class="mcp-body">
				<p class="mcp-hint">
					If your MCP client doesn't support OAuth, you can authenticate with an API token instead.
					Create one in <a href="/user/api-tokens">API Tokens</a>, then pass it as a Bearer token in
					the Authorization header.
				</p>
				<p class="mcp-hint">
					Tokens created on that page can only read. For an agent that deploys or changes things,
					create one with the CLI: <code>orchard auth token create --name agent --scope deploy</code
					>
					(or <code>--scope exec</code> to allow running commands in pods).
				</p>

				<div class="mcp-field">
					<div class="mcp-block-head">
						<p class="mcp-label">Configuration with token</p>
						<IconButton
							title="Copy configuration"
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
							{#snippet children(_hovered)}
								{#if copiedId === 'token-config'}
									<Check class="h-3.5 w-3.5" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							{/snippet}
						</IconButton>
					</div>
					<pre class="mcp-code">{`{
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
		</SettingsSection>
	{/if}
</div>

<style>
	.settings-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.mcp-body {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.mcp-desc {
		font-size: var(--text-callout);
		color: var(--text-muted);
		line-height: 1.6;
		margin: 0;
	}

	.mcp-hint {
		font-size: var(--text-callout);
		color: var(--text-muted);
		line-height: 1.55;
		margin: 0;
	}

	.mcp-hint a {
		color: var(--text-link);
		text-decoration: none;
	}

	.mcp-hint a:hover {
		text-decoration: underline;
	}

	.mcp-hint code,
	.mcp-hint kbd {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: var(--font-mono);
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-xs);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		color: var(--text-default);
	}

	.mcp-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.mcp-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
		margin: 0;
	}

	.mcp-copy-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.mcp-copy-row :global(.ib-root) {
		flex-shrink: 0;
	}

	.mcp-block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-width: 0;
	}

	.mcp-value {
		flex: 1;
		min-width: 0;
		font-size: var(--text-callout);
		font-family: var(--font-mono);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		color: var(--text-default);
		line-height: 1.5;
		overflow-wrap: anywhere;
		user-select: all;
	}

	.mcp-code {
		font-size: var(--text-callout);
		font-family: var(--font-mono);
		padding: 0.875rem 1.125rem;
		border-radius: var(--radius-sm);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		color: var(--text-default);
		overflow-x: auto;
		white-space: pre;
		line-height: 1.6;
		margin: 0;
	}
</style>
