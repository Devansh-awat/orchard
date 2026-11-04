<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Check, Copy, ExternalLink } from 'lucide-svelte';
	import { Button, Input, StatusDot, statusMeta } from '@orchardlabs/graft-ui';
	import { toasts } from '../../../host/stores';
	import { queryClient } from '../../../host/query';
	import type { SandboxCredentials } from '../../../lib/types/sandbox';
	import {
		agentLoginStatus,
		answerAgentLogin,
		cancelAgentLogin,
		saveAgentCredential,
		startAgentLogin,
		type AgentCredentialField,
		type AgentLogin,
		type AgentLoginInfo,
		type AgentLoginMethod
	} from '../api';
	import type { MachineWorkspace } from '../workspace.svelte';
	import { errorText } from './sections';

	let {
		ws,
		info,
		credentials
	}: {
		ws: MachineWorkspace;
		info: AgentLoginInfo;
		credentials: SandboxCredentials | null;
	} = $props();

	const POLL_MS = 1500;

	let login = $state<AgentLogin | null>(null);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let answer = $state('');
	let copied = $state(false);
	let keys = $state<Record<string, string>>({});
	let alive = true;
	let polling: string | null = null;

	const signIns = $derived(info.methods.filter((m) => m.kind === 'signin'));
	const keyMethods = $derived(info.methods.filter((m) => m.kind === 'key'));
	const method = $derived(login ? (signIns.find((m) => m.id === login?.method) ?? null) : null);

	function present(field: AgentCredentialField): boolean {
		if (!credentials) return false;
		if (field === 'claudeToken') return credentials.claude;
		if (field === 'openaiToken') return credentials.openai;
		return !!credentials.aiGateway;
	}

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function settle(next: AgentLogin) {
		login = next;
		if (next.state === 'running') return;
		if (next.state === 'succeeded') {
			toasts.add({
				title: next.saved ? 'Signed in on your account' : 'Signed in on this machine',
				color: 'success'
			});
			if (next.saved) void queryClient.invalidateQueries({ queryKey: ['sandbox-credentials'] });
			await ws.refreshAgents(true);
		}
	}

	async function poll(loginId: string, methodId: string) {
		polling = loginId;
		while (alive && polling === loginId) {
			await sleep(POLL_MS);
			if (!alive || polling !== loginId) return;
			const res = await agentLoginStatus(ws.sandboxId, loginId, methodId);
			if (!alive || polling !== loginId) return;
			if (!res.ok) {
				error = res.message;
				polling = null;
				return;
			}
			await settle(res.data);
			if (res.data.state !== 'running') {
				polling = null;
				return;
			}
		}
	}

	async function start(m: AgentLoginMethod) {
		if (busy) return;
		busy = `start:${m.id}`;
		error = null;
		answer = '';
		copied = false;
		try {
			const next = await startAgentLogin(ws.sandboxId, info.agent, m.id);
			await settle(next);
			if (next.state === 'running') void poll(next.loginId, m.id);
		} catch (e) {
			error = errorText(e) ?? "Couldn't start the sign-in";
		} finally {
			busy = null;
		}
	}

	async function submit() {
		if (!login || !answer.trim() || busy) return;
		busy = 'answer';
		error = null;
		try {
			const next = await answerAgentLogin(ws.sandboxId, login.loginId, login.method, answer.trim());
			answer = '';
			await settle(next);
		} catch (e) {
			error = errorText(e) ?? "Sign-in failed";
		} finally {
			busy = null;
		}
	}

	async function cancel() {
		const current = login;
		polling = null;
		login = null;
		error = null;
		if (current?.state === 'running') {
			await cancelAgentLogin(ws.sandboxId, current.loginId).catch(() => null);
		}
	}

	async function copyCode(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	async function saveKey(field: AgentCredentialField, id: string, value: string | null) {
		if (busy) return;
		busy = `key:${id}`;
		error = null;
		try {
			await saveAgentCredential(field, value);
			keys = { ...keys, [id]: '' };
			await queryClient.invalidateQueries({ queryKey: ['sandbox-credentials'] });
			toasts.add({ title: value ? 'Key saved' : 'Key removed', color: 'success' });
			void ws.refreshAgents(true);
		} catch (e) {
			error = errorText(e) ?? "Couldn't save the key";
		} finally {
			busy = null;
		}
	}

	onDestroy(() => {
		alive = false;
		const current = login;
		if (current?.state === 'running') {
			void cancelAgentLogin(ws.sandboxId, current.loginId).catch(() => null);
		}
	});
</script>

<div class="setup">
	<p class="summary">{info.summary}</p>

	{#if login}
		<div class="flow">
			<div class="flow-head">
				<span class="flow-title">{method?.label ?? 'Signing in'}</span>
				{#if login.state === 'running'}
					<span class="flow-state">
						<StatusDot meta={statusMeta('neutral', 'Waiting')} size={6} />
						Waiting for you
					</span>
				{:else if login.state === 'succeeded'}
					<span class="flow-state">
						<StatusDot meta={statusMeta('success', 'Signed in')} size={6} />
						Signed in
					</span>
				{:else}
					<span class="flow-state">
						<StatusDot meta={statusMeta('error', 'Failed')} size={6} />
						Did not finish
					</span>
				{/if}
			</div>

			{#if login.state === 'running'}
				<ol class="steps">
					<li class="step">
						<span class="step-text">
							{login.url ? 'Open the sign-in page and approve it' : 'Starting the sign-in'}
						</span>
						{#if login.url}
							<div class="step-controls">
								<Button
									variant="primary"
									size="sm"
									href={login.url}
									target="_blank"
									rel="noreferrer"
								>
									<ExternalLink size={14} strokeWidth={1.75} /> Open sign-in page
								</Button>
								{#if login.code}
									<button
										type="button"
										class="code"
										title="Copy code"
										onclick={() => login?.code && copyCode(login.code)}
									>
										<span>{login.code}</span>
										{#if copied}
											<Check size={14} strokeWidth={1.75} />
										{:else}
											<Copy size={14} strokeWidth={1.75} />
										{/if}
									</button>
								{/if}
							</div>
							{#if login.code}
								<span class="step-hint">Enter this code when the page asks for it.</span>
							{/if}
						{/if}
					</li>
					{#if login.step !== 'none'}
						<li class="step">
							<span class="step-text">
								{login.step === 'code'
									? 'Paste the code the page shows you'
									: "Your browser lands on a page that won't load. Copy its address and paste it here"}
							</span>
							<div class="step-controls">
								<Input
									type="password"
									bind:value={answer}
									placeholder={login.step === 'code' ? 'Code' : 'http://localhost:...'}
									autocomplete="off"
									aria-label={login.step === 'code' ? 'Sign-in code' : 'Address from your browser'}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											void submit();
										}
									}}
								/>
								<Button
									variant="secondary"
									size="sm"
									loading={busy === 'answer'}
									disabled={!answer.trim()}
									onclick={() => void submit()}
								>
									Continue
								</Button>
							</div>
						</li>
					{/if}
				</ol>
			{:else if login.state === 'succeeded'}
				<p class="done">
					{login.saved
						? 'Saved to your account. Your other machines pick it up too.'
						: 'This machine is signed in.'}
				</p>
			{/if}

			{#if login.state === 'failed' || login.lines.length > 0}
				<details class="log" open={login.state === 'failed'}>
					<summary>What the agent printed</summary>
					<pre>{login.lines.join('\n')}</pre>
				</details>
			{/if}

			<div class="flow-foot">
				{#if login.state === 'running'}
					<Button variant="ghost" size="sm" onclick={() => void cancel()}>Cancel</Button>
				{:else if login.state === 'failed' && method}
					<Button variant="ghost" size="sm" onclick={() => void cancel()}>Close</Button>
					<Button variant="secondary" size="sm" onclick={() => method && void start(method)}>
						Try again
					</Button>
				{:else}
					<Button variant="secondary" size="sm" onclick={() => void cancel()}>Done</Button>
				{/if}
			</div>
		</div>
	{:else}
		{#if signIns.length > 0}
			<div class="methods">
				{#each signIns as m (m.id)}
					<div class="method">
						<span class="method-text">
							<span class="method-name">{m.label}</span>
							<span class="method-hint">{m.description}</span>
						</span>
						<Button
							variant="secondary"
							size="sm"
							disabled={!ws.isOwner}
							loading={busy === `start:${m.id}`}
							onclick={() => void start(m)}
						>
							Sign in
						</Button>
					</div>
				{/each}
			</div>
			{#if !ws.isOwner}
				<p class="note">Only the machine's owner can sign it in. Keys below are yours and follow you.</p>
			{/if}
		{/if}

		{#each keyMethods as m (m.id)}
			{#if m.kind === 'key'}
				{@const saved = present(m.field)}
				<div class="method method--key">
					<span class="method-text">
						<span class="method-name">
							{m.label}
							{#if saved}<span class="saved">Saved</span>{/if}
						</span>
						<span class="method-hint">{m.description}</span>
					</span>
					<div class="key">
						<Input
							type="password"
							bind:value={() => keys[m.id] ?? '', (v) => (keys = { ...keys, [m.id]: v })}
							placeholder={saved ? 'Replace the saved key' : m.placeholder}
							autocomplete="off"
							aria-label={m.label}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter' && keys[m.id]?.trim()) {
									e.preventDefault();
									void saveKey(m.field, m.id, keys[m.id].trim());
								}
							}}
						/>
						<Button
							variant="secondary"
							size="sm"
							loading={busy === `key:${m.id}`}
							disabled={!keys[m.id]?.trim()}
							onclick={() => void saveKey(m.field, m.id, keys[m.id].trim())}
						>
							Save
						</Button>
						{#if saved}
							<Button
								variant="ghost"
								size="sm"
								disabled={!!busy}
								onclick={() => void saveKey(m.field, m.id, null)}
							>
								Remove
							</Button>
						{/if}
					</div>
				</div>
			{/if}
		{/each}
	{/if}

	{#if error}<p class="error">{error}</p>{/if}
</div>

<style>
	.setup {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-left: 3rem;
		min-width: 0;
	}

	.summary,
	.note,
	.done {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.error {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-danger, var(--hue-red));
	}

	.methods {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-sm);
		background: var(--fill-soft);
	}

	.method {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		min-width: 0;
	}

	.methods .method:not(:first-child) {
		border-top: 1px solid var(--gh-line-soft);
	}

	.method--key {
		flex-direction: column;
		align-items: stretch;
		gap: 0.5rem;
		padding: 0;
	}

	.method-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		flex: 1;
		min-width: 0;
	}

	.method-name {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.method-hint {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.saved {
		font-size: var(--text-caption);
		line-height: 1rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	.key {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 28rem;
	}

	.key :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.flow {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--fill-soft);
	}

	.flow-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.flow-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.flow-state {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.steps {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 0;
		padding-left: 1.25rem;
	}

	.step {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-default);
	}

	.step::marker {
		color: var(--text-faint);
	}

	.step-hint {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.step-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 28rem;
	}

	.step-controls :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.code {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		padding: 0 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		letter-spacing: 0.08em;
		color: var(--text-default);
		cursor: pointer;
	}

	.code :global(svg) {
		color: var(--text-faint);
	}

	.log summary {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
		cursor: pointer;
	}

	.log pre {
		margin: 0.375rem 0 0;
		max-height: 10rem;
		overflow: auto;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.flow-foot {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
