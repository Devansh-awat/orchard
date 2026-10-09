<script lang="ts">
	import { tick } from 'svelte';
	import type { Placement } from '@floating-ui/dom';
	import { ChevronLeft, LogOut, Plug, Plus, RefreshCw } from 'lucide-svelte';
	import {
		Button,
		Input,
		PopoverPanel,
		SegmentedControl,
		Skeleton,
		StatusDot,
		statusMeta,
		type StatusMeta
	} from '$lib/components/ui';
	import {
		ocMcpAdd,
		ocMcpAuthFinish,
		ocMcpAuthRemove,
		ocMcpAuthStart,
		ocMcpList,
		ocMcpToggle,
		ocMcpTypes,
		ocOauthCode,
		type OcMcpConfig,
		type OcMcpServer,
		type OcMcpState,
		type OcMcpType
	} from '../opencode';
	import type { ChatSessionStore } from './session-store.svelte';

	let {
		store,
		placement = 'top-end',
		label = null
	}: { store: ChatSessionStore; placement?: Placement; label?: string | null } = $props();

	const HOST_ONLY = 'Only the host can change MCP servers';
	const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
	const POLL_MS = 3000;
	const POLL_LIMIT_MS = 120_000;

	type SignIn = { name: string; url: string; code: string; error: string | null; busy: boolean };

	let open = $state(false);
	let view = $state<'list' | 'add'>('list');
	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	let servers = $state<OcMcpServer[]>([]);
	let types = $state<Record<string, OcMcpType>>({});
	let loaded = $state(false);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let rowError = $state<{ name: string; message: string } | null>(null);
	let signIn = $state<SignIn | null>(null);

	let addName = $state('');
	let addType = $state<string>('remote');
	let addUrl = $state('');
	let addHeaders = $state('');
	let addCommand = $state('');
	let addError = $state<string | null>(null);
	let adding = $state(false);

	const host = $derived(store.isHost());
	const sandboxId = $derived(store.sandboxId);

	let opened = false;
	$effect(() => {
		if (!open) {
			opened = false;
			return;
		}
		if (opened) return;
		opened = true;
		if (host) void refresh();
	});

	$effect(() => {
		const pending = signIn?.name;
		if (!open || !pending) return;
		const started = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - started > POLL_LIMIT_MS) {
				clearInterval(timer);
				return;
			}
			void refresh(true);
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	async function refresh(quiet = false) {
		if (!host) return;
		if (!quiet) loading = true;
		try {
			const directory = store.agentDirectory();
			const [list, configTypes] = await Promise.all([
				ocMcpList(sandboxId, directory),
				ocMcpTypes(sandboxId, directory)
			]);
			servers = list.servers;
			types = { ...types, ...configTypes };
			loadError = list.forbidden ? HOST_ONLY : null;
			if (signIn && list.servers.find((s) => s.name === signIn?.name)?.status === 'connected') {
				signIn = null;
			}
		} catch (err) {
			if (!quiet) loadError = err instanceof Error ? err.message : 'Could not load MCP servers';
		} finally {
			loaded = true;
			loading = false;
		}
	}

	function metaFor(status: OcMcpState): StatusMeta {
		if (status === 'connected') return statusMeta('success', 'Connected');
		if (status === 'disabled') return statusMeta('neutral', 'Disabled');
		if (status === 'failed') return statusMeta('error', 'Failed');
		if (status === 'needs_auth') return statusMeta('warning', 'Needs sign in');
		return statusMeta('warning', 'Needs registration');
	}

	async function run(name: string, work: () => Promise<void>) {
		busy = name;
		rowError = null;
		try {
			await work();
			await refresh(true);
		} catch (err) {
			rowError = { name, message: err instanceof Error ? err.message : 'Something went wrong' };
		} finally {
			busy = null;
			void keepFocus();
		}
	}

	async function keepFocus() {
		await tick();
		if (rootEl && !rootEl.contains(document.activeElement)) rootEl.focus();
	}

	function toggle(server: OcMcpServer) {
		const action = server.status === 'connected' ? 'disconnect' : 'connect';
		void run(server.name, () =>
			ocMcpToggle(sandboxId, store.agentDirectory(), server.name, action)
		);
	}

	function startSignIn(server: OcMcpServer) {
		const win = window.open('', '_blank');
		void run(server.name, async () => {
			try {
				const url = await ocMcpAuthStart(sandboxId, store.agentDirectory(), server.name);
				if (win) {
					win.opener = null;
					win.location.href = url;
				} else {
					window.open(url, '_blank', 'noopener');
				}
				signIn = { name: server.name, url, code: '', error: null, busy: false };
			} catch (err) {
				win?.close();
				throw err;
			}
		});
	}

	async function finishSignIn() {
		const pending = signIn;
		if (!pending) return;
		const code = ocOauthCode(pending.code);
		if (!code) {
			pending.error = 'Paste the full address you landed on after signing in';
			return;
		}
		pending.busy = true;
		pending.error = null;
		try {
			await ocMcpAuthFinish(sandboxId, store.agentDirectory(), pending.name, code);
			signIn = null;
			await refresh(true);
		} catch (err) {
			pending.error = err instanceof Error ? err.message : 'Could not finish signing in';
		} finally {
			pending.busy = false;
		}
	}

	function signOut(server: OcMcpServer) {
		void run(server.name, () => ocMcpAuthRemove(sandboxId, store.agentDirectory(), server.name));
	}

	async function go(next: 'list' | 'add') {
		view = next;
		addError = null;
		await tick();
		const target = rootEl?.querySelector<HTMLElement>('[data-autofocus]');
		(target ?? rootEl)?.focus();
	}

	function parseHeaders(text: string): Record<string, string> | string {
		const headers: Record<string, string> = {};
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const at = trimmed.indexOf(':');
			if (at < 1) return `"${trimmed}" is not a "Name: value" header`;
			headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
		}
		return headers;
	}

	async function submitAdd(e: SubmitEvent) {
		e.preventDefault();
		if (adding) return;
		const name = addName.trim();
		if (!NAME_RE.test(name)) {
			addError = 'Use letters, numbers, dashes or underscores for the name';
			return;
		}
		let config: OcMcpConfig;
		if (addType === 'remote') {
			const url = addUrl.trim();
			if (!/^https?:\/\/\S+$/i.test(url)) {
				addError = 'Enter an http or https address';
				return;
			}
			const headers = parseHeaders(addHeaders);
			if (typeof headers === 'string') {
				addError = headers;
				return;
			}
			config = {
				type: 'remote',
				url,
				...(Object.keys(headers).length > 0 ? { headers } : {})
			};
		} else {
			const command = addCommand.trim().split(/\s+/).filter(Boolean);
			if (command.length === 0) {
				addError = 'Enter the command that starts the server';
				return;
			}
			config = { type: 'local', command };
		}
		adding = true;
		addError = null;
		try {
			await ocMcpAdd(sandboxId, store.agentDirectory(), name, config);
			const added: OcMcpType = config.type;
			types = { ...types, [name]: added };
			addName = '';
			addUrl = '';
			addHeaders = '';
			addCommand = '';
			await go('list');
			await refresh(true);
		} catch (err) {
			addError = err instanceof Error ? err.message : 'Could not add the server';
		} finally {
			adding = false;
		}
	}
</script>

<PopoverPanel bind:open {placement} class="mcp-panel">
	{#snippet trigger(props, isOpen)}
		<button
			type="button"
			class="mcp-trigger"
			class:mcp-trigger--open={isOpen}
			class:mcp-trigger--label={!!label}
			aria-label={label ? undefined : 'MCP servers'}
			title="MCP servers"
			{...props}
		>
			<Plug size={label ? 14 : 16} strokeWidth={1.75} />
			{#if label}<span>{label}</span>{/if}
		</button>
	{/snippet}
	{#snippet children()}
		<div
			class="mcp"
			bind:this={rootEl}
			tabindex="-1"
			role="presentation"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				if (e.key === 'Escape' && view === 'add') {
					e.preventDefault();
					e.stopPropagation();
					void go('list');
				}
			}}
		>
			{#if view === 'list'}
				<div class="mcp-head">
					<h3>MCP servers</h3>
					<span class="mcp-spacer"></span>
					{#if host}
						<button
							type="button"
							class="mcp-icon"
							aria-label="Refresh"
							title="Refresh"
							disabled={loading}
							onclick={() => refresh()}
						>
							<RefreshCw size={14} strokeWidth={1.75} />
						</button>
					{/if}
				</div>
				{#if !host}
					<p class="mcp-note">{HOST_ONLY}</p>
				{:else if !loaded}
					<div class="mcp-skel" aria-hidden="true">
						<Skeleton height="0.75rem" width="60%" />
						<Skeleton height="0.75rem" width="80%" />
					</div>
				{:else if loadError}
					<p class="mcp-note">{loadError}</p>
				{:else if servers.length === 0}
					<p class="mcp-note">No MCP servers yet</p>
				{:else}
					<ul class="mcp-list">
						{#each servers as server (server.name)}
							{@const meta = metaFor(server.status)}
							{@const type = types[server.name]}
							{@const working = busy === server.name}
							<li class="mcp-item">
								<div class="mcp-row">
									<div class="mcp-main">
										<div class="mcp-title">
											<span class="mcp-name">{server.name}</span>
											{#if type}<span class="mcp-type">{type === 'local' ? 'Local' : 'Remote'}</span
												>{/if}
										</div>
										<div class="mcp-status" class:mcp-status--failed={server.status === 'failed'}>
											<StatusDot {meta} size={6} />
											<span>{meta.label}</span>
										</div>
									</div>
									<div class="mcp-actions">
										{#if server.status === 'needs_auth'}
											<button
												type="button"
												class="mcp-btn"
												disabled={working}
												onclick={() => startSignIn(server)}
											>
												Sign in
											</button>
										{/if}
										{#if server.status !== 'needs_client_registration'}
											<button
												type="button"
												class="mcp-btn"
												disabled={working}
												onclick={() => toggle(server)}
											>
												{server.status === 'connected'
													? 'Disconnect'
													: server.status === 'failed'
														? 'Retry'
														: 'Connect'}
											</button>
										{/if}
										{#if type !== 'local'}
											<button
												type="button"
												class="mcp-icon"
												aria-label="Forget the sign in for {server.name}"
												title="Forget sign in"
												disabled={working}
												onclick={() => signOut(server)}
											>
												<LogOut size={14} strokeWidth={1.75} />
											</button>
										{/if}
									</div>
								</div>
								{#if server.error && server.status !== 'connected'}
									<p class="mcp-error" title={server.error}>{server.error}</p>
								{/if}
								{#if rowError?.name === server.name}
									<p class="mcp-error" role="alert">{rowError.message}</p>
								{/if}
								{#if signIn?.name === server.name}
									<form
										class="mcp-signin"
										onsubmit={(e) => {
											e.preventDefault();
											void finishSignIn();
										}}
									>
										<span class="mcp-hint">
											Signed in? Paste the address the page sent you to.
											<a href={signIn.url} target="_blank" rel="noopener noreferrer">Open again</a>
										</span>
										<div class="mcp-signin-row">
											<Input
												bind:value={signIn.code}
												placeholder="http://127.0.0.1:19876/mcp/oauth/callback?code=..."
												aria-label="Address after signing in"
											/>
											<Button size="sm" type="submit" loading={signIn.busy}>Finish</Button>
										</div>
										{#if signIn.error}<p class="mcp-error" role="alert">{signIn.error}</p>{/if}
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				<div class="mcp-foot">
					<button
						type="button"
						class="mcp-btn"
						disabled={!host}
						title={host ? 'Add an MCP server' : HOST_ONLY}
						onclick={() => go('add')}
					>
						<Plus size={14} strokeWidth={1.75} /> Add server
					</button>
				</div>
			{:else}
				<form class="mcp-add" onsubmit={submitAdd}>
					<button type="button" class="mcp-back" onclick={() => go('list')}>
						<ChevronLeft size={16} strokeWidth={1.75} />
						<span>Add server</span>
					</button>
					<Input bind:value={addName} placeholder="Name" aria-label="Name" data-autofocus />
					<SegmentedControl
						label="Server type"
						grow
						options={[
							{ value: 'remote', label: 'Remote URL' },
							{ value: 'local', label: 'Local command' }
						]}
						bind:value={addType}
					/>
					{#if addType === 'remote'}
						<Input bind:value={addUrl} placeholder="https://mcp.example.com/mcp" aria-label="URL" />
						<textarea
							class="mcp-textarea"
							bind:value={addHeaders}
							rows="2"
							placeholder="Headers, optional. One per line, Name: value"
							aria-label="Headers"></textarea>
					{:else}
						<Input
							bind:value={addCommand}
							placeholder="npx -y @modelcontextprotocol/server-everything"
							aria-label="Command"
						/>
					{/if}
					{#if addError}<p class="mcp-error" role="alert">{addError}</p>{/if}
					<div class="mcp-add-foot">
						<span class="mcp-hint">Lasts until the agent restarts</span>
						<span class="mcp-spacer"></span>
						<Button size="sm" variant="ghost" onclick={() => go('list')}>Cancel</Button>
						<Button size="sm" variant="primary" type="submit" loading={adding}>Add</Button>
					</div>
				</form>
			{/if}
		</div>
	{/snippet}
</PopoverPanel>

<style>
	:global(.ui-popover.mcp-panel) {
		width: 22rem;
		padding: var(--space-3);
	}

	.mcp-trigger {
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
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.mcp-trigger--label {
		gap: var(--space-1);
		width: auto;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		white-space: nowrap;
	}

	.mcp-trigger:hover,
	.mcp-trigger--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.mcp {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 400;
		color: var(--text-default);
		outline: none;
	}

	.mcp-head,
	.mcp-row,
	.mcp-title,
	.mcp-actions,
	.mcp-status,
	.mcp-signin-row,
	.mcp-add-foot {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.mcp-head {
		height: 1.75rem;
	}

	.mcp h3 {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 600;
	}

	.mcp-spacer {
		flex: 1;
	}

	.mcp-note,
	.mcp-hint {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mcp-hint a {
		color: var(--text-link);
	}

	.mcp-skel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.mcp-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		max-height: 18rem;
		overflow-y: auto;
		list-style: none;
	}

	.mcp-item {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2) 0;
	}

	.mcp-item + .mcp-item {
		border-top: 1px solid var(--border-default);
	}

	.mcp-row {
		gap: var(--space-2);
	}

	.mcp-main {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.mcp-title {
		gap: var(--space-2);
	}

	.mcp-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mcp-type {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mcp-status {
		gap: var(--space-1);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mcp-status--failed span {
		font-weight: 600;
		color: var(--text-default);
	}

	.mcp-actions {
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.mcp-btn,
	.mcp-back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		cursor: pointer;
		white-space: nowrap;
		transition: background-color var(--dur-fast);
	}

	.mcp-btn:hover:not(:disabled),
	.mcp-back:hover {
		background: var(--bg-hover);
	}

	.mcp-btn:disabled,
	.mcp-icon:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.mcp-back {
		align-self: flex-start;
		padding-left: var(--space-1);
		font-weight: 600;
	}

	.mcp-icon {
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
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.mcp-icon:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.mcp-error {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mcp-signin,
	.mcp-add {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.mcp-signin-row {
		gap: var(--space-2);
	}

	.mcp-signin-row :global(input) {
		flex: 1;
		min-width: 0;
	}

	.mcp-foot {
		display: flex;
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-default);
	}

	.mcp-foot .mcp-btn {
		margin-left: calc(-1 * var(--space-2));
	}

	.mcp-textarea {
		width: 100%;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-surface);
		resize: vertical;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-default);
	}

	.mcp-textarea:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
	}

	.mcp-textarea::placeholder {
		color: var(--text-faint);
	}

	.mcp-add-foot {
		gap: var(--space-2);
	}
</style>
