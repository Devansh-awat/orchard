<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { ArrowDown, Loader2, Play, Send } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { Button } from '$lib/components/ui';
	import { fade, slide } from '$lib/utils/transitions';
	import { sandboxCredentialsQueryOptions } from '$lib/queries/sandboxes';
	import type { Sandbox, SandboxRepo } from '$lib/types/sandbox';

	type ToolEntry = {
		kind: 'tool';
		id: string | null;
		name: string;
		input: unknown;
		summary: string;
		title: string | null;
		diff: { add: number; del: number } | null;
		failed: boolean;
		expanded: boolean;
	};

	type ChatEntry =
		| { kind: 'user'; text: string }
		| { kind: 'thinking'; text: string }
		| { kind: 'text'; text: string }
		| ToolEntry
		| { kind: 'result'; cost: number | null; duration: number | null }
		| { kind: 'error'; detail: string };

	let {
		sandbox,
		repos = [],
		selectedRepo = $bindable(null),
		starting = false,
		onstart,
		onturndone
	}: {
		sandbox: Sandbox;
		repos?: SandboxRepo[];
		selectedRepo?: string | null;
		starting?: boolean;
		onstart: () => void;
		onturndone?: () => void;
	} = $props();

	const credentialsQuery = createQuery(() => sandboxCredentialsQueryOptions());
	const missingClaude = $derived(credentialsQuery.data ? !credentialsQuery.data.claude : false);

	let entries = $state<ChatEntry[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let atBottom = $state(true);
	let listEl = $state<HTMLDivElement | undefined>(undefined);
	let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);

	const canStart = $derived(sandbox.status === 'stopped' || sandbox.status === 'error');

	$effect(() => {
		const tail = entries.at(-1);
		if (!tail) return;
		void ('text' in tail ? tail.text : 'detail' in tail ? tail.detail : tail.kind);
		void streaming;
		if (atBottom) listEl?.scrollTo({ top: listEl.scrollHeight });
	});

	function onScroll() {
		if (!listEl) return;
		atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
	}

	function jumpToLatest() {
		atBottom = true;
		listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
	}

	function appendText(text: string) {
		const tail = entries.at(-1);
		if (tail && tail.kind === 'text') tail.text += text;
		else entries.push({ kind: 'text', text });
	}

	function appendThinking(text: string) {
		const tail = entries.at(-1);
		if (tail && tail.kind === 'thinking') tail.text += text;
		else entries.push({ kind: 'thinking', text });
	}

	const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);

	function toolGlyph(name: string): string {
		if (name === 'Bash') return '$';
		if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit')
			return '±';
		if (name === 'Read') return '≡';
		if (name === 'Grep' || name === 'Glob' || name.includes('Search')) return '⌕';
		return '⏺';
	}

	function truncate(text: string, max = 80): string {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}

	function countLines(text: string): number {
		return text.length === 0 ? 0 : text.split('\n').length;
	}

	function makeToolEntry(id: string | null, name: string, toolInput: unknown): ToolEntry {
		const record =
			toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
		let summary = '';
		let title: string | null = null;
		if (name === 'Bash' && typeof record.command === 'string') {
			summary = truncate(record.command);
		} else if (FILE_TOOLS.has(name) && typeof record.file_path === 'string') {
			summary = record.file_path.split('/').pop() ?? record.file_path;
			title = record.file_path;
		} else if (Object.keys(record).length > 0) {
			try {
				summary = truncate(JSON.stringify(record), 60);
			} catch {
				summary = '';
			}
		}
		let diff: { add: number; del: number } | null = null;
		if (
			name === 'Edit' &&
			typeof record.old_string === 'string' &&
			typeof record.new_string === 'string'
		) {
			diff = { add: countLines(record.new_string), del: countLines(record.old_string) };
		} else if (name === 'Write' && typeof record.content === 'string') {
			diff = { add: countLines(record.content), del: 0 };
		}
		return {
			kind: 'tool',
			id,
			name,
			input: toolInput,
			summary,
			title,
			diff,
			failed: false,
			expanded: false
		};
	}

	function markToolResults(blocks: unknown[]) {
		for (const block of blocks) {
			const b = block as Record<string, unknown>;
			if (b.type !== 'tool_result' || b.is_error !== true) continue;
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i];
				if (entry.kind === 'tool' && entry.id === b.tool_use_id) {
					entry.failed = true;
					break;
				}
			}
		}
	}

	function handleEvent(event: Record<string, unknown>) {
		if (event.type === 'assistant') {
			const message = event.message as { content?: unknown[] } | undefined;
			for (const block of message?.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string') appendText(b.text);
				else if (b.type === 'thinking' && typeof b.thinking === 'string')
					appendThinking(b.thinking);
				else if (b.type === 'tool_use') {
					entries.push(
						makeToolEntry(
							typeof b.id === 'string' ? b.id : null,
							typeof b.name === 'string' ? b.name : 'tool',
							b.input
						)
					);
				}
			}
		} else if (event.type === 'user') {
			const message = event.message as { content?: unknown[] } | undefined;
			if (Array.isArray(message?.content)) markToolResults(message.content);
		} else if (event.type === 'result') {
			entries.push({
				kind: 'result',
				cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
				duration: typeof event.duration_ms === 'number' ? event.duration_ms : null
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

	async function submitMessage() {
		const message = input.trim();
		if (!message || streaming) return;
		input = '';
		if (inputEl) inputEl.style.height = 'auto';
		entries.push({ kind: 'user', text: message });
		atBottom = true;
		streaming = true;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(selectedRepo ? { message, repo: selectedRepo } : { message })
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
			onturndone?.();
		}
	}

	function onComposerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitMessage();
		}
	}

	function autosize() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = `${Math.min(inputEl.scrollHeight, 150)}px`;
	}

	function pretty(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	function firstLine(text: string): string {
		return truncate(text.split('\n')[0] ?? '', 100);
	}

	function fmtCost(cost: number): string {
		return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
	}

	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${s.toFixed(1)}s`;
		return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
	}
</script>

<div class="chat-root">
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
			<div class="chat-cred">
				<span>No Claude credentials on your account.</span>
				<a href="/user/settings?tab=sandbox">Open user settings</a>
			</div>
		{/if}
		<div class="chat-scroll-wrap">
			<div class="chat-log" bind:this={listEl} onscroll={onScroll}>
				<div class="chat-col">
					{#if entries.length === 0}
						<p class="chat-empty-title">Ask the agent to build something.</p>
						<p class="chat-empty-sub">
							The transcript clears on refresh; the agent session persists in the sandbox.
						</p>
					{/if}
					{#each entries as entry, i (i)}
						{#if entry.kind === 'user'}
							<div class="tr-user">
								<span class="tr-user-dot" aria-hidden="true"></span>
								<div class="tr-user-text">{entry.text}</div>
							</div>
						{:else if entry.kind === 'thinking'}
							<div class="tr-thinking" title={entry.text}>{firstLine(entry.text)}</div>
						{:else if entry.kind === 'text'}
							<div class="tr-text">{entry.text}</div>
						{:else if entry.kind === 'tool'}
							<div class="tr-tool" class:tr-tool--failed={entry.failed}>
								<button
									type="button"
									class="tr-tool-row"
									aria-expanded={entry.expanded}
									onclick={() => (entry.expanded = !entry.expanded)}
								>
									<span class="tr-tool-glyph" aria-hidden="true">{toolGlyph(entry.name)}</span>
									<span class="tr-tool-name">{entry.name}</span>
									{#if entry.summary}
										<span class="tr-tool-arg" title={entry.title ?? undefined}>{entry.summary}</span>
									{/if}
									{#if entry.diff}
										<span class="tr-diffstat">
											{#if entry.diff.add > 0}<span class="tr-diff-add">+{entry.diff.add}</span>{/if}
											{#if entry.diff.del > 0}<span class="tr-diff-del">-{entry.diff.del}</span>{/if}
										</span>
									{/if}
									{#if entry.failed}<span class="tr-tool-failed">failed</span>{/if}
								</button>
								{#if entry.expanded}
									<pre class="tr-tool-detail" transition:slide>{pretty(entry.input)}</pre>
								{/if}
							</div>
						{:else if entry.kind === 'result'}
							<div class="tr-turn">
								<span class="tr-turn-rule" aria-hidden="true"></span>
								<span class="tr-turn-label">
									turn complete{#if entry.duration !== null}
										· {fmtDuration(entry.duration)}{/if}{#if entry.cost !== null}
										· {fmtCost(entry.cost)}{/if}
								</span>
								<span class="tr-turn-rule" aria-hidden="true"></span>
							</div>
						{:else}
							<div class="tr-error">{entry.detail}</div>
						{/if}
					{/each}
					{#if streaming}
						<div class="tr-working">
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Working
						</div>
					{/if}
				</div>
			</div>
			{#if !atBottom}
				<button type="button" class="tr-jump" transition:fade onclick={jumpToLatest}>
					<ArrowDown class="h-3 w-3" /> Jump to latest
				</button>
			{/if}
		</div>
		<form
			class="chat-composer"
			onsubmit={(e) => {
				e.preventDefault();
				submitMessage();
			}}
		>
			<div class="chat-composer-col">
				<textarea
					bind:this={inputEl}
					bind:value={input}
					class="chat-composer-input"
					rows="1"
					placeholder="Ask the agent to build something"
					aria-label="Message the agent"
					oninput={autosize}
					onkeydown={onComposerKey}
				></textarea>
				<div class="chat-composer-foot">
					{#if streaming}
						<span class="chat-composer-working">
							<Loader2 class="h-3 w-3 animate-spin" /> Working
						</span>
					{:else}
						<span class="chat-composer-hint">Enter sends · Shift+Enter for a newline</span>
					{/if}
					<div class="chat-composer-tools">
						{#if repos.length > 0}
							<select
								class="chat-repo-select"
								bind:value={selectedRepo}
								aria-label="Working repository"
							>
								{#each repos as repo (repo.name)}
									<option value={repo.name}>{repo.name}</option>
								{/each}
							</select>
						{:else}
							<span class="chat-repo-select chat-repo-select--static">home</span>
						{/if}
						<button
							type="submit"
							class="chat-send"
							disabled={streaming || !input.trim()}
							aria-label="Send message"
						>
							<Send class="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			</div>
		</form>
	{/if}
</div>

<style>
	.chat-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.chat-gate {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
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

	.chat-cred {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		padding: 0.375rem 1rem;
		border-bottom: 1px solid var(--border-default);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.chat-cred a {
		color: var(--text-link);
		text-decoration: none;
	}

	.chat-cred a:hover {
		text-decoration: underline;
	}

	.chat-scroll-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.chat-log {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.75rem 1rem 1rem;
	}

	.chat-col {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.375rem;
		max-width: 52rem;
		margin: 0 auto;
	}

	.chat-empty-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
	}

	.chat-empty-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.tr-user {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.625rem;
	}

	.tr-user-dot {
		width: 0.5rem;
		height: 0.5rem;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
		transform: translateY(-1px);
	}

	.tr-user-text {
		font-size: var(--text-footnote);
		line-height: 1.55;
		font-weight: 600;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-thinking {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-style: italic;
		color: var(--text-faint);
		padding-left: 1rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tr-text {
		max-width: 70ch;
		font-size: var(--text-footnote);
		line-height: 1.6;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-tool {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.tr-tool-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		width: 100%;
		padding: 0.1875rem 0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		text-align: left;
		cursor: pointer;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		transition: background-color var(--dur-fast);
	}

	.tr-tool-row:hover {
		background: var(--bg-hover);
	}

	.tr-tool-glyph {
		flex-shrink: 0;
		width: 1rem;
		text-align: center;
		font-family: var(--font-mono, monospace);
		color: var(--text-faint);
	}

	.tr-tool--failed .tr-tool-glyph {
		color: var(--status-error);
	}

	.tr-tool-name {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--text-default);
	}

	.tr-tool--failed .tr-tool-name {
		color: var(--status-error);
	}

	.tr-tool-arg {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: var(--radius-xs);
		padding: 0 0.375rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tr-diffstat {
		display: inline-flex;
		gap: 0.375rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}

	.tr-diff-add {
		color: var(--status-success);
	}

	.tr-diff-del {
		color: var(--status-error);
	}

	.tr-tool-failed {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--status-error);
		background: var(--status-error-bg);
		border: 1px solid var(--status-error-border);
		border-radius: var(--radius-pill);
		padding: 0 0.375rem;
	}

	.tr-tool-detail {
		margin: 0.25rem 0 0.25rem 1.375rem;
		padding: 0.5rem 0.625rem;
		max-height: 16rem;
		overflow: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		white-space: pre;
	}

	.tr-turn {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0.375rem 0;
	}

	.tr-turn-rule {
		flex: 1;
		height: 1px;
		background: var(--border-default);
	}

	.tr-turn-label {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.tr-error {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--status-error-border);
		border-radius: var(--radius-sm);
		background: var(--status-error-bg);
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-working {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.tr-jump {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-overlay);
		box-shadow: var(--elev-1);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		cursor: pointer;
	}

	.chat-composer {
		flex-shrink: 0;
		border-top: 1px solid var(--border-default);
		padding: 0.5rem 1rem 0.625rem;
	}

	.chat-composer-col {
		max-width: 52rem;
		margin: 0 auto;
	}

	.chat-composer-input {
		width: 100%;
		border: none;
		background: none;
		resize: none;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: 1.55;
		padding: 0;
	}

	.chat-composer-input:focus-visible {
		outline: none;
	}

	.chat-composer-input::placeholder {
		color: var(--text-faint);
	}

	.chat-composer-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.375rem;
	}

	.chat-composer-hint {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.chat-composer-working {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}

	.chat-composer-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.chat-repo-select {
		border: none;
		background: none;
		padding: 0.125rem 0.25rem;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		cursor: pointer;
		border-radius: var(--radius-xs);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.chat-repo-select:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.chat-repo-select--static {
		cursor: default;
	}

	.chat-repo-select--static:hover {
		color: var(--text-muted);
		background: none;
	}

	.chat-send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition: opacity var(--dur-fast);
	}

	.chat-send:disabled {
		background: var(--bg-sunken);
		color: var(--text-faint);
		cursor: default;
	}
</style>
