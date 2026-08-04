<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { Loader2, Play, Send, Wrench } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { Button, Input, SectionCard } from '$lib/components/ui';
	import { sandboxCredentialsQueryOptions } from '$lib/queries/sandboxes';
	import type { Sandbox } from '$lib/types/sandbox';

	type ChatEntry =
		| { kind: 'user'; text: string }
		| { kind: 'text'; text: string }
		| { kind: 'tool'; name: string; summary: string }
		| { kind: 'result'; cost: number | null }
		| { kind: 'error'; detail: string };

	let {
		sandbox,
		starting = false,
		onstart
	}: {
		sandbox: Sandbox;
		starting?: boolean;
		onstart: () => void;
	} = $props();

	const credentialsQuery = createQuery(() => sandboxCredentialsQueryOptions());
	const missingClaude = $derived(credentialsQuery.data ? !credentialsQuery.data.claude : false);

	let entries = $state<ChatEntry[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let listEl = $state<HTMLDivElement | undefined>(undefined);

	const canStart = $derived(sandbox.status === 'stopped' || sandbox.status === 'error');

	$effect(() => {
		const tail = entries.at(-1);
		if (!tail) return;
		void ('text' in tail ? tail.text : 'detail' in tail ? tail.detail : tail.kind);
		listEl?.scrollTo({ top: listEl.scrollHeight });
	});

	function appendText(text: string) {
		const tail = entries.at(-1);
		if (tail && tail.kind === 'text') tail.text += text;
		else entries.push({ kind: 'text', text });
	}

	function toolSummary(toolInput: unknown): string {
		if (!toolInput || typeof toolInput !== 'object') return '';
		const record = toolInput as Record<string, unknown>;
		const preferred = ['command', 'file_path', 'pattern', 'query', 'prompt', 'description', 'url'];
		for (const key of preferred) {
			if (typeof record[key] === 'string' && record[key]) return truncate(record[key] as string);
		}
		const firstString = Object.values(record).find((v) => typeof v === 'string' && v);
		return firstString ? truncate(firstString as string) : '';
	}

	function truncate(text: string): string {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
	}

	function handleEvent(event: Record<string, unknown>) {
		if (event.type === 'assistant') {
			const message = event.message as { content?: unknown[] } | undefined;
			for (const block of message?.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string') appendText(b.text);
				else if (b.type === 'tool_use') {
					entries.push({
						kind: 'tool',
						name: typeof b.name === 'string' ? b.name : 'tool',
						summary: toolSummary(b.input)
					});
				}
			}
		} else if (event.type === 'result') {
			entries.push({
				kind: 'result',
				cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
			});
		} else if (event.type === 'error') {
			entries.push({
				kind: 'error',
				detail: typeof event.detail === 'string' ? event.detail : 'The agent hit an error'
			});
		} else if (event.type === 'raw' && typeof event.text === 'string') {
			appendText(event.text);
		}
	}

	function handleFrame(frame: string) {
		const payload = frame
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.join('');
		if (!payload) return;
		try {
			handleEvent(JSON.parse(payload) as Record<string, unknown>);
		} catch {
			appendText(payload);
		}
	}

	async function send(e: SubmitEvent) {
		e.preventDefault();
		const message = input.trim();
		if (!message || streaming) return;
		input = '';
		entries.push({ kind: 'user', text: message });
		streaming = true;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message })
			});
			if (!res.ok || !res.body) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Chat request failed');
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					handleFrame(buffer.slice(0, boundary));
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf('\n\n');
				}
			}
			if (buffer.trim()) handleFrame(buffer);
		} catch (err) {
			entries.push({
				kind: 'error',
				detail: err instanceof Error ? err.message : 'Chat request failed'
			});
		} finally {
			streaming = false;
		}
	}

	function fmtCost(cost: number): string {
		return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
	}
</script>

<SectionCard title="Cloud Code" description="Talk to the coding agent running inside this sandbox.">
	{#if sandbox.status !== 'running'}
		<div class="chat-gate">
			<p class="chat-gate-text">Start the sandbox to chat.</p>
			{#if canStart}
				<Button variant="primary" loading={starting} onclick={onstart}>
					<Play class="h-4 w-4" /> Start sandbox
				</Button>
			{:else}
				<p class="chat-gate-sub">Waiting for the sandbox to be ready.</p>
			{/if}
		</div>
	{:else}
		{#if missingClaude}
			<div class="chat-note">
				<span>Claude credentials are attached to your user account.</span>
				<Button size="sm" variant="secondary" onclick={() => goto('/user/settings?tab=sandbox')}>
					Open user settings
				</Button>
			</div>
		{/if}
		<div class="chat-log" bind:this={listEl}>
			{#if entries.length === 0}
				<p class="chat-empty">
					Ask the agent to explore the repo, run tests, or make a change. It works directly in the
					sandbox filesystem.
				</p>
			{/if}
			{#each entries as entry, i (i)}
				{#if entry.kind === 'user'}
					<div class="chat-msg chat-msg--user">{entry.text}</div>
				{:else if entry.kind === 'text'}
					<div class="chat-msg chat-msg--assistant">{entry.text}</div>
				{:else if entry.kind === 'tool'}
					<div class="chat-tool">
						<Wrench size={12} />
						<span class="chat-tool-name">{entry.name}</span>
						{#if entry.summary}<span class="chat-tool-sum">{entry.summary}</span>{/if}
					</div>
				{:else if entry.kind === 'result'}
					<div class="chat-turn-end">
						Turn complete{#if entry.cost !== null}
							· {fmtCost(entry.cost)}{/if}
					</div>
				{:else}
					<div class="chat-msg chat-msg--error">{entry.detail}</div>
				{/if}
			{/each}
			{#if streaming}
				<div class="chat-streaming">
					<Loader2 class="h-3.5 w-3.5 animate-spin" /> Working
				</div>
			{/if}
		</div>
		<form class="chat-input" onsubmit={send}>
			<Input
				bind:value={input}
				placeholder="Message Cloud Code"
				disabled={streaming}
				autocomplete="off"
				aria-label="Chat message"
			/>
			<Button type="submit" variant="primary" disabled={streaming || !input.trim()}>
				<Send class="h-3.5 w-3.5" /> Send
			</Button>
		</form>
		<p class="chat-hint">
			The transcript clears on refresh, but the agent's own session persists inside the sandbox.
		</p>
	{/if}
</SectionCard>

<style>
	.chat-gate {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 2.5rem 1rem;
	}

	.chat-gate-text {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}

	.chat-gate-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.chat-note {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.625rem 0.875rem;
		margin-bottom: 0.75rem;
		border: 1px solid var(--status-info-border);
		border-radius: var(--radius-sm);
		background: var(--status-info-bg);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-default);
	}

	.chat-log {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 28rem;
		min-height: 10rem;
		overflow-y: auto;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
	}

	.chat-empty {
		margin: auto;
		max-width: 24rem;
		text-align: center;
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.chat-msg {
		max-width: 85%;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-md);
		font-size: var(--text-footnote);
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.chat-msg--user {
		align-self: flex-end;
		background: var(--accent-subtle);
		color: var(--text-default);
	}

	.chat-msg--assistant {
		align-self: flex-start;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		color: var(--text-default);
	}

	.chat-msg--error {
		align-self: flex-start;
		background: var(--status-error-bg);
		border: 1px solid var(--status-error-border);
		color: var(--text-default);
	}

	.chat-tool {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		align-self: flex-start;
		max-width: 100%;
		padding: 0.1875rem 0.5rem;
		border-radius: var(--radius-pill);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}

	.chat-tool-name {
		font-weight: 600;
		color: var(--text-default);
	}

	.chat-tool-sum {
		font-family: var(--font-mono, monospace);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-turn-end {
		align-self: center;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		padding: 0.125rem 0;
	}

	.chat-streaming {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		align-self: flex-start;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.chat-input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.chat-input :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.chat-hint {
		margin-top: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
</style>
