<script lang="ts">
	import { ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import {
		Button,
		EmptyState,
		Input,
		SegmentedControl,
		StatusBadge,
		statusMeta,
		type StatusMeta
	} from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
	import { ocBase, ocMcpServers, ocProbe, type OcMcpServer, type OcMcpState } from './opencode';

	let { sandboxId, running }: { sandboxId: string; running: boolean } = $props();

	type Server = OcMcpServer & { busy: boolean; authUrl: string | null; actionError: string | null };

	let ocMode = $state<boolean | null>(null);
	let servers = $state<Server[]>([]);
	let listLoading = $state(false);
	let addOpen = $state(false);
	let adding = $state(false);
	let addName = $state('');
	let addType = $state('remote');
	let addTarget = $state('');
	let addError = $state<string | null>(null);

	let probed = false;
	$effect(() => {
		if (running && !probed) {
			probed = true;
			init();
		}
	});

	async function init() {
		ocMode = await ocProbe(sandboxId);
		if (ocMode) await refresh();
	}

	async function refresh() {
		listLoading = true;
		try {
			const res = await apiFetch(`${ocBase(sandboxId)}/mcp`);
			if (!res.ok) return;
			const map = (await res.json()) as Record<string, { status: OcMcpState; error?: string }>;
			const prev = new Map(servers.map((s) => [s.name, s]));
			servers = ocMcpServers(map).map((s) => ({
				...s,
				busy: false,
				authUrl: prev.get(s.name)?.authUrl ?? null,
				actionError: null
			}));
		} catch {
			return;
		} finally {
			listLoading = false;
		}
	}

	function metaFor(status: OcMcpState): StatusMeta {
		if (status === 'connected') return statusMeta('success', 'Connected');
		if (status === 'disabled') return statusMeta('neutral', 'Disabled');
		if (status === 'failed') return statusMeta('error', 'Failed');
		if (status === 'needs_auth') return statusMeta('warning', 'Needs auth');
		return statusMeta('warning', 'Needs registration');
	}

	async function act(server: Server, action: 'connect' | 'disconnect') {
		server.busy = true;
		server.actionError = null;
		try {
			const res = await apiFetch(
				`${ocBase(sandboxId)}/mcp/${encodeURIComponent(server.name)}/${action}`,
				{ method: 'POST' }
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				server.actionError =
					(data as { message?: string })?.message ?? `Failed to ${action} ${server.name}`;
				return;
			}
			await refresh();
		} catch {
			server.actionError = `Failed to ${action} ${server.name}`;
		} finally {
			server.busy = false;
		}
	}

	async function authorize(server: Server) {
		server.busy = true;
		server.actionError = null;
		try {
			const res = await apiFetch(
				`${ocBase(sandboxId)}/mcp/${encodeURIComponent(server.name)}/auth`,
				{ method: 'POST' }
			);
			const data = (await res.json().catch(() => ({}))) as {
				authorizationUrl?: string;
				message?: string;
			};
			if (!res.ok || !data.authorizationUrl) {
				server.actionError = data.message ?? 'This server does not support browser auth';
				return;
			}
			server.authUrl = data.authorizationUrl;
		} catch {
			server.actionError = 'Failed to start the auth flow';
		} finally {
			server.busy = false;
		}
	}

	async function addServer(e: SubmitEvent) {
		e.preventDefault();
		const name = addName.trim();
		const target = addTarget.trim();
		if (!name || !target || adding) return;
		adding = true;
		addError = null;
		try {
			const config =
				addType === 'remote'
					? { type: 'remote', url: target }
					: { type: 'local', command: target.split(/\s+/) };
			const res = await apiFetch(`${ocBase(sandboxId)}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, config })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				addError = (data as { message?: string })?.message ?? 'Failed to add the server';
				return;
			}
			addName = '';
			addTarget = '';
			addOpen = false;
			await refresh();
		} catch {
			addError = 'Failed to add the server';
		} finally {
			adding = false;
		}
	}
</script>

<div class="mcp-root">
	{#if !running}
		<EmptyState
			title="Sandbox is stopped"
			description="Start the sandbox to manage MCP servers."
		/>
	{:else if ocMode === null}
		<div class="mcp-loading">
			<Loader2 class="h-3.5 w-3.5 animate-spin" /> Checking the agent
		</div>
	{:else if ocMode === false}
		<EmptyState
			title="MCP needs the opencode engine"
			description="This sandbox runs the claude-code agent, which manages its own MCP servers."
		/>
	{:else}
		<div class="mcp-head">
			<span class="mcp-count">
				{servers.length === 1 ? '1 server' : `${servers.length} servers`}
			</span>
			<button
				type="button"
				class="mcp-icon-btn"
				aria-label="Refresh servers"
				disabled={listLoading}
				onclick={refresh}
			>
				<RefreshCw class="h-3 w-3" />
			</button>
			<Button size="sm" variant="ghost" onclick={() => (addOpen = !addOpen)}>
				<Plus class="h-3.5 w-3.5" /> Add server
			</Button>
		</div>
		{#if addOpen}
			<form class="mcp-add" transition:slide onsubmit={addServer}>
				<Input bind:value={addName} placeholder="Name" aria-label="Server name" />
				<SegmentedControl
					bind:value={addType}
					label="Transport"
					grow
					options={[
						{ value: 'remote', label: 'Remote' },
						{ value: 'local', label: 'Local' }
					]}
				/>
				<Input
					bind:value={addTarget}
					placeholder={addType === 'remote' ? 'https://server.example/mcp' : 'npx my-mcp-server'}
					aria-label={addType === 'remote' ? 'Server URL' : 'Server command'}
				/>
				{#if addError}
					<p class="mcp-error">{addError}</p>
				{/if}
				<Button
					size="sm"
					variant="primary"
					type="submit"
					loading={adding}
					disabled={!addName.trim() || !addTarget.trim()}
				>
					Add server
				</Button>
			</form>
		{/if}
		{#if servers.length === 0}
			<EmptyState
				title="No MCP servers"
				description="Add a server to give the agent extra tools."
			/>
		{:else}
			<ul class="mcp-list">
				{#each servers as server (server.name)}
					<li class="mcp-row">
						<div class="mcp-row-line">
							<span class="mcp-name">{server.name}</span>
							<StatusBadge meta={metaFor(server.status)} />
							<span class="mcp-actions">
								{#if server.busy}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else if server.status === 'connected'}
									<Button size="sm" variant="ghost" onclick={() => act(server, 'disconnect')}>
										Disconnect
									</Button>
								{:else}
									{#if server.status === 'needs_auth' || server.status === 'needs_client_registration'}
										<Button size="sm" variant="ghost" onclick={() => authorize(server)}>
											Authorize
										</Button>
									{/if}
									<Button size="sm" variant="ghost" onclick={() => act(server, 'connect')}>
										Connect
									</Button>
								{/if}
							</span>
						</div>
						{#if server.authUrl}
							<a class="mcp-auth-link" href={server.authUrl} target="_blank" rel="noreferrer">
								Open the authorization page <ExternalLink class="h-3 w-3" />
							</a>
						{/if}
						{#if server.error}
							<p class="mcp-error">{server.error}</p>
						{/if}
						{#if server.actionError}
							<p class="mcp-error">{server.actionError}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.mcp-root {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.mcp-loading {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.mcp-head {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.mcp-count {
		flex: 1;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.mcp-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.mcp-icon-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.mcp-icon-btn:disabled {
		color: var(--text-faint);
		cursor: default;
	}

	.mcp-add {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
	}

	.mcp-list {
		display: flex;
		flex-direction: column;
	}

	.mcp-row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border-default);
	}

	.mcp-row:last-child {
		border-bottom: none;
	}

	.mcp-row-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.mcp-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
	}

	.mcp-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
		flex-shrink: 0;
	}

	.mcp-auth-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-link);
		text-decoration: none;
	}

	.mcp-auth-link:hover {
		text-decoration: underline;
	}

	.mcp-error {
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--status-error);
		overflow-wrap: anywhere;
	}
</style>
