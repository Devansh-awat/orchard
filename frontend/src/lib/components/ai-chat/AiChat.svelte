<script lang="ts">
	import { apiFetch } from '$lib/stores';
	import { springHover, motionPopover, motionBackdrop } from '$lib/utils/motion.svelte';
	import { Bot, X, Send, Loader2, Wrench, ChevronDown } from 'lucide-svelte';
	import { tick } from 'svelte';

	interface Message {
		id: string;
		role: 'user' | 'assistant';
		content: string;
		toolCalls?: Array<{ name: string; success?: boolean; error?: string }>;
		loading?: boolean;
	}

	let open = $state(false);
	let renderPanel = $state(false);
	let input = $state('');
	let messages = $state<Message[]>([]);
	let streaming = $state(false);
	let messagesEl = $state<HTMLElement | null>(null);
	let inputEl = $state<HTMLTextAreaElement | null>(null);
	let showScrollBtn = $state(false);

	function onClosed() {
		renderPanel = false;
	}

	function toggleOpen() {
		if (open) {
			open = false;
		} else {
			renderPanel = true;
			open = true;
			tick().then(() => inputEl?.focus());
		}
	}

	function scrollToBottom() {
		if (messagesEl) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	function handleScroll() {
		if (!messagesEl) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesEl;
		showScrollBtn = scrollHeight - scrollTop - clientHeight > 60;
	}

	async function sendMessage() {
		const text = input.trim();
		if (!text || streaming) return;

		messages.push({ id: crypto.randomUUID(), role: 'user', content: text });
		messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '', loading: true, toolCalls: [] });
		// Grab the reactive proxy from the array — local objects aren't reactive after push
		const assistantMsg = messages[messages.length - 1];
		input = '';
		streaming = true;

		await tick();
		scrollToBottom();
		resizeInput();

		try {
			const chatHistory = messages
				.filter((m) => !m.loading && m.content)
				.map((m) => ({ role: m.role, content: m.content }));

			const res = await apiFetch('/apiv1/ai/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messages: chatHistory }),
			});

			if (!res.ok) {
				assistantMsg.content = 'Something went wrong. Please try again.';
				assistantMsg.loading = false;
				streaming = false;
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				assistantMsg.content = 'No response stream available.';
				assistantMsg.loading = false;
				streaming = false;
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const raw = line.startsWith('data: ') ? line.slice(6) : line;
					if (!raw.trim()) continue;

					try {
						const event = JSON.parse(raw);

						if (event.type === 'text') {
							assistantMsg.content += event.text;
							assistantMsg.loading = false;
							await tick();
							if (!showScrollBtn) scrollToBottom();
						} else if (event.type === 'tool_call') {
							assistantMsg.toolCalls = [...(assistantMsg.toolCalls ?? []), { name: event.name }];
							assistantMsg.loading = true;
						} else if (event.type === 'tool_result') {
							const calls = assistantMsg.toolCalls ?? [];
							const last = calls.findLast((c) => c.name === event.name);
							if (last) {
								last.success = event.success;
								last.error = event.error;
								assistantMsg.toolCalls = [...calls];
							}
						} else if (event.type === 'error') {
							assistantMsg.content += `\n\nError: ${event.error}`;
							assistantMsg.loading = false;
						} else if (event.type === 'done') {
							assistantMsg.loading = false;
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}

			assistantMsg.loading = false;
		} catch (err) {
			assistantMsg.content = `Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}`;
			assistantMsg.loading = false;
		} finally {
			streaming = false;
			await tick();
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function resizeInput() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
	}

	function formatToolName(name: string): string {
		return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function clearChat() {
		messages = [];
	}
</script>

<!-- Floating button -->
<button
	class="fab"
	onclick={toggleOpen}
	aria-label={open ? 'Close AI chat' : 'Open AI chat'}
	{@attach springHover({ lift: -2, stiffness: 480, damping: 26 })}
>
	{#if open}
		<X size={20} />
	{:else}
		<Bot size={20} />
	{/if}
</button>

<!-- Chat panel -->
{#if renderPanel}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" {@attach motionBackdrop(() => !open, onClosed)} onclick={toggleOpen}></div>
	<div class="panel" {@attach motionPopover({ closing: () => !open, onClosed })}>
		<header class="panel-header">
			<div class="panel-title">
				<Bot size={16} />
				<span>Orchard AI</span>
			</div>
			<div class="panel-actions">
				{#if messages.length > 0}
					<button class="clear-btn" onclick={clearChat} aria-label="Clear chat">Clear</button>
				{/if}
				<button class="close-btn" onclick={toggleOpen} aria-label="Close">
					<X size={16} />
				</button>
			</div>
		</header>

		<div class="messages" bind:this={messagesEl} onscroll={handleScroll}>
			{#if messages.length === 0}
				<div class="empty-chat">
					<Bot size={32} />
					<p class="empty-title">How can I help?</p>
					<p class="empty-sub">Ask me about your deployments, databases, or anything on Orchard.</p>
				</div>
			{:else}
				{#each messages as msg (msg.id)}
					<div class="msg msg--{msg.role}">
						{#if msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0}
							<div class="tool-calls">
								{#each msg.toolCalls as tc}
									<span class="tool-pill" class:tool-pill--ok={tc.success === true} class:tool-pill--err={tc.success === false}>
										<Wrench size={10} />
										{formatToolName(tc.name)}
										{#if tc.success === undefined}
											<Loader2 size={10} class="spin" />
										{/if}
									</span>
								{/each}
							</div>
						{/if}
						{#if msg.content}
							<div class="msg-text">{msg.content}</div>
						{/if}
						{#if msg.loading && !msg.content}
							<div class="msg-loading">
								<span class="dot"></span><span class="dot"></span><span class="dot"></span>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		{#if showScrollBtn}
			<button class="scroll-btn" onclick={scrollToBottom}>
				<ChevronDown size={14} />
			</button>
		{/if}

		<form class="input-bar" onsubmit={(e) => { e.preventDefault(); sendMessage(); }}>
			<textarea
				bind:this={inputEl}
				bind:value={input}
				placeholder="Ask about your infrastructure..."
				rows={1}
				onkeydown={handleKeydown}
				oninput={resizeInput}
				disabled={streaming}
			></textarea>
			<button type="submit" class="send-btn" disabled={!input.trim() || streaming} aria-label="Send">
				{#if streaming}
					<Loader2 size={16} class="spin" />
				{:else}
					<Send size={16} />
				{/if}
			</button>
		</form>
	</div>
{/if}

<style>
	.fab {
		position: fixed;
		bottom: 1.5rem;
		right: 1.5rem;
		z-index: 1000;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		border: none;
		background: var(--button-bg);
		color: var(--button-color);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 999;
		background: transparent;
	}

	.panel {
		position: fixed;
		bottom: 5rem;
		right: 1.5rem;
		z-index: 1001;
		width: min(24rem, calc(100vw - 2rem));
		height: min(36rem, calc(100vh - 8rem));
		border-radius: 0.75rem;
		background: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.08);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--surface-border);
		flex-shrink: 0;
	}

	.panel-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.panel-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.clear-btn {
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		font-size: 0.6875rem;
		cursor: pointer;
	}
	.clear-btn:hover {
		color: var(--center-channel-color);
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
	}
	.close-btn:hover {
		color: var(--center-channel-color);
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.empty-chat {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		color: var(--surface-muted);
		gap: 0.25rem;
	}
	.empty-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin-top: 0.5rem;
	}
	.empty-sub {
		font-size: 0.75rem;
		max-width: 16rem;
		line-height: 1.4;
	}

	.msg {
		max-width: 88%;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.msg--user {
		align-self: flex-end;
	}
	.msg--assistant {
		align-self: flex-start;
	}

	.msg-text {
		padding: 0.5rem 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.msg--user .msg-text {
		background: var(--button-bg);
		color: var(--button-color);
		border-bottom-right-radius: 0.25rem;
	}
	.msg--assistant .msg-text {
		background: color-mix(in srgb, var(--surface-border) 40%, transparent);
		color: var(--center-channel-color);
		border-bottom-left-radius: 0.25rem;
	}

	.tool-calls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.tool-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1875rem 0.5rem;
		border-radius: 1rem;
		font-size: 0.625rem;
		font-weight: 500;
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--surface-muted);
	}
	.tool-pill--ok {
		background: color-mix(in srgb, #22c55e 12%, transparent);
		color: #22c55e;
	}
	.tool-pill--err {
		background: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.msg-loading {
		display: flex;
		gap: 0.25rem;
		padding: 0.75rem;
	}
	.dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--surface-muted);
		animation: bounce 1.4s infinite;
	}
	.dot:nth-child(2) { animation-delay: 0.16s; }
	.dot:nth-child(3) { animation-delay: 0.32s; }
	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
		40% { transform: scale(1); opacity: 1; }
	}

	.scroll-btn {
		position: absolute;
		bottom: 4.5rem;
		left: 50%;
		transform: translateX(-50%);
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}
	.scroll-btn:hover {
		color: var(--center-channel-color);
	}

	.input-bar {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		padding: 0.75rem;
		border-top: 1px solid var(--surface-border);
		flex-shrink: 0;
	}

	.input-bar textarea {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		font-family: inherit;
		line-height: 1.4;
		resize: none;
		overflow-y: auto;
		max-height: 7.5rem;
	}
	.input-bar textarea:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}
	.input-bar textarea::placeholder {
		color: var(--surface-muted);
	}
	.input-bar textarea:disabled {
		opacity: 0.6;
	}

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		border: none;
		background: var(--button-bg);
		color: var(--button-color);
		cursor: pointer;
		flex-shrink: 0;
	}
	.send-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
</style>
