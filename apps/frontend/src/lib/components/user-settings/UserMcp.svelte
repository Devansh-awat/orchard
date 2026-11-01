<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		SectionCard,
		SegmentedControl,
		SettingRow,
		SettingsList,
		Swap,
		ToggleRow
	} from '$lib/components/ui';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import CommandSnippet from '$lib/components/ui/Snippet.svelte';

	const MCP_URL = env.PUBLIC_MCP_URL || '';

	type Client = 'claude' | 'claude-code' | 'amp' | 'vscode' | 'cursor' | 'token';

	const CLIENTS = [
		{ value: 'claude', label: 'Claude' },
		{ value: 'claude-code', label: 'Claude Code' },
		{ value: 'amp', label: 'Amp' },
		{ value: 'vscode', label: 'VS Code' },
		{ value: 'cursor', label: 'Cursor' },
		{ value: 'token', label: 'Token' }
	] as const;

	let client = $state<Client>('claude');

	const TOOLSETS = [
		{
			id: 'deployments',
			label: 'Deployments',
			hint: 'Create, build, scale, restart and roll back apps'
		},
		{ id: 'logs', label: 'Logs', hint: 'Runtime and build logs, pods, errors, metrics and exec' },
		{ id: 'env', label: 'Variables', hint: 'Environment variables and environments' },
		{ id: 'databases', label: 'Databases', hint: 'Databases, credentials, backups and settings' },
		{ id: 'domains', label: 'Domains', hint: 'Domains, services, DNS checks and protection' },
		{ id: 'jobs', label: 'Jobs', hint: 'Scheduled and on-demand jobs and their runs' },
		{ id: 'notifications', label: 'Notifications', hint: 'Channels, rules and deliveries' },
		{ id: 'templates', label: 'Templates', hint: 'Templates and what was deployed from them' },
		{ id: 'dangerous', label: 'Deletes', hint: 'Every delete, plus restoring a database backup' }
	] as const;

	const ACCESS = [
		{ value: 'exec', label: 'Everything' },
		{ value: 'deploy', label: 'No shell' },
		{ value: 'read', label: 'Read only' }
	] as const;

	const ACCESS_HINT: Record<string, string> = {
		exec: 'Reads, changes and runs commands inside your apps.',
		deploy: 'Reads and changes things, but cannot run commands inside your apps.',
		read: 'Looks, never changes anything.'
	};

	let toolMode = $state<'all' | 'pick'>('all');
	const picked = new SvelteSet<string>(TOOLSETS.map((t) => t.id));
	let access = $state<'exec' | 'deploy' | 'read'>('exec');

	const serverUrl = $derived.by(() => {
		if (!MCP_URL) return '';
		const url = new URL(MCP_URL);
		if (toolMode === 'pick' && picked.size < TOOLSETS.length) {
			const ids = ['core', ...TOOLSETS.filter((t) => picked.has(t.id)).map((t) => t.id)];
			url.searchParams.set('toolsets', ids.join(','));
		}
		if (access !== 'exec') url.searchParams.set('scope', access);
		return url.toString().replace(/%2C/g, ',');
	});

	function toggle(id: string) {
		if (picked.has(id)) picked.delete(id);
		else picked.add(id);
	}

	const claudeCodeConfig = $derived(`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${serverUrl}"
    }
  }
}`);

	const vscodeConfig = $derived(`{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${serverUrl}"
    }
  }
}`);

	const cursorConfig = $derived(`{
  "mcpServers": {
    "orchard": {
      "url": "${serverUrl}"
    }
  }
}`);

	const tokenConfig = $derived(`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${serverUrl}",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}`);
</script>

<SectionCard
	title="MCP server"
	description="Lets Claude and other AI tools manage your apps, databases, variables and networking."
>
	{#if MCP_URL}
		<div class="build">
			<SettingsList>
				<SettingRow
					label="Tools"
					hint={toolMode === 'all'
						? 'Every toolset, including graft tools'
						: `${picked.size} of ${TOOLSETS.length} toolsets, plus the basics`}
				>
					<SegmentedControl
						label="Tools"
						size="sm"
						shape="capsule"
						options={[
							{ value: 'all', label: 'Everything' },
							{ value: 'pick', label: 'Choose' }
						]}
						bind:value={() => toolMode, (v) => (toolMode = v as 'all' | 'pick')}
					/>
				</SettingRow>
				{#if toolMode === 'pick'}
					{#each TOOLSETS as t (t.id)}
						<ToggleRow
							label={t.label}
							hint={t.hint}
							checked={picked.has(t.id)}
							onchange={() => toggle(t.id)}
						/>
					{/each}
				{/if}
				<SettingRow label="Access" hint={ACCESS_HINT[access]}>
					<SegmentedControl
						label="Access"
						size="sm"
						shape="capsule"
						options={ACCESS}
						bind:value={() => access, (v) => (access = v as 'exec' | 'deploy' | 'read')}
					/>
				</SettingRow>
			</SettingsList>
			<CommandSnippet command={serverUrl} prompt="" label="Copy server URL" />
		</div>
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
					<CommandSnippet command={`claude mcp add --transport http orchard '${serverUrl}'`} />
					<CodeBlock code={claudeCodeConfig} title=".mcp.json" />
				{:else if client === 'amp'}
					<p class="step">Run this, then sign in when Amp asks.</p>
					<CommandSnippet command={`amp mcp add orchard '${serverUrl}'`} />
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
	.build {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
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
