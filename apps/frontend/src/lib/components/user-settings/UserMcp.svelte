<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { SectionCard, SegmentedControl, Swap } from '$lib/components/ui';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import CommandSnippet from '$lib/components/ui/Snippet.svelte';

	const MCP_URL = env.PUBLIC_MCP_URL || '';

	type Client = 'claude' | 'claude-code' | 'vscode' | 'cursor' | 'token';

	const CLIENTS = [
		{ value: 'claude', label: 'Claude' },
		{ value: 'claude-code', label: 'Claude Code' },
		{ value: 'vscode', label: 'VS Code' },
		{ value: 'cursor', label: 'Cursor' },
		{ value: 'token', label: 'Token' }
	] as const;

	let client = $state<Client>('claude');

	const claudeCodeConfig = `{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

	const vscodeConfig = `{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

	const cursorConfig = `{
  "mcpServers": {
    "orchard": {
      "url": "${MCP_URL}"
    }
  }
}`;

	const tokenConfig = `{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}`;
</script>

<SectionCard
	title="MCP server"
	description="Lets Claude and other AI tools manage your apps, databases, variables and networking."
>
	{#if MCP_URL}
		<CommandSnippet command={MCP_URL} prompt="" label="Copy server URL" />
	{:else}
		<div class="steps">
			<p class="step">
				This instance has no MCP endpoint yet. An instance admin turns it on with
				<code>mcp.ingress.host</code> in the chart values, or on the host:
			</p>
			<CommandSnippet command="sudo orchardctl mcp enable" />
		</div>
	{/if}
</SectionCard>

{#if MCP_URL}
	<SectionCard title="Connect a client">
		{#snippet actions()}
			<SegmentedControl
				label="MCP client"
				options={CLIENTS}
				bind:value={client}
				size="sm"
				shape="capsule"
			/>
		{/snippet}
		<Swap key={client}>
			<div class="steps">
				{#if client === 'claude'}
					<p class="step">
						In Claude, open Settings, Connectors and choose Add custom connector. Paste the server
						URL, then sign in with your Orchard account.
					</p>
				{:else if client === 'claude-code'}
					<p class="step">
						Run this, then <code>/mcp</code> inside Claude Code to sign in. Or add
						<code>.mcp.json</code> to your project.
					</p>
					<CommandSnippet command={`claude mcp add --transport http orchard ${MCP_URL}`} />
					<CodeBlock code={claudeCodeConfig} title=".mcp.json" />
				{:else if client === 'vscode'}
					<p class="step">
						Run MCP: Add Server from the Command Palette <Kbd keys={['⇧', '⌘', 'P']} />, or add
						<code>.vscode/mcp.json</code> to your project. VS Code signs you in.
					</p>
					<CodeBlock code={vscodeConfig} title=".vscode/mcp.json" />
				{:else if client === 'cursor'}
					<p class="step">
						Add <code>.cursor/mcp.json</code> to a project, or <code>~/.cursor/mcp.json</code> for every
						project. Cursor signs you in on first use.
					</p>
					<CodeBlock code={cursorConfig} title=".cursor/mcp.json" />
				{:else}
					<p class="step">
						For clients without OAuth. Create a token in
						<a href="/user/settings?tab=tokens">API tokens</a> and send it as a Bearer token. An agent
						that changes things needs a Deploy or Exec token.
					</p>
					<CodeBlock code={tokenConfig} title="mcp.json" />
				{/if}
			</div>
		</Swap>
	</SectionCard>
{/if}

<style>
	.steps {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.step {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.step code {
		font-family: var(--font-mono);
		font-size: 0.95em;
		color: var(--text-default);
	}
	.step a {
		color: var(--text-link);
	}
	.step a:hover {
		text-decoration: underline;
	}
</style>
