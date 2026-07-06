<script lang="ts">
	import '$lib/components/org-dashboard/org-dashboard.css';
	import { apiFetch } from '$lib/stores';
	import { featureFlag } from '$lib/posthog';
	import { springHover, motionStagger } from '$lib/utils/motion.svelte';
	import {
		Bot,
		Send,
		Loader2,
		Check,
		X,
		Sparkles,
		Trash2,
		Rocket,
		Database,
		Folder,
		Globe,
		Server,
		FileText,
		Activity,
		Settings,
		Wrench
	} from 'lucide-svelte';
	import { tick } from 'svelte';
	import { marked, type Tokens } from 'marked';

	const aiEnabled = featureFlag('ai-agent');
	marked.setOptions({ breaks: true, gfm: true });

	function escapeHtml(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function isSafeHref(href: string): boolean {
		try {
			const proto = new URL(href, 'https://relative.invalid').protocol;
			return proto === 'https:' || proto === 'http:' || proto === 'mailto:';
		} catch {
			return false;
		}
	}

	marked.use({
		renderer: {
			html({ text }: Tokens.HTML | Tokens.Tag) {
				return escapeHtml(text);
			},
			link(token: Tokens.Link) {
				if (isSafeHref(token.href)) return false;
				return this.parser.parseInline(token.tokens);
			}
		}
	});

	function renderMarkdown(text: string): string {
		return marked.parse(text) as string;
	}

	interface ToolCall {
		name: string;
		success?: boolean;
		error?: string;
		data?: any;
		startedAt: number;
		elapsed?: number;
	}

	interface Message {
		id: string;
		role: 'user' | 'assistant';
		content: string;
		toolCalls?: ToolCall[];
		loading?: boolean;
	}

	const TOOL_META: Record<string, { label: string; icon: typeof Rocket }> = {
		get_current_user: { label: 'Checking your profile', icon: Settings },
		list_organizations: { label: 'Loading organizations', icon: Folder },
		list_projects: { label: 'Fetching projects', icon: Folder },
		get_project: { label: 'Loading project details', icon: Folder },
		list_deployments: { label: 'Listing apps', icon: Rocket },
		get_deployment: { label: 'Loading app', icon: Rocket },
		list_pods: { label: 'Checking pods', icon: Server },
		get_pod_logs: { label: 'Reading logs', icon: FileText },
		get_build_logs: { label: 'Reading deployment logs', icon: FileText },
		get_deployment_metrics: { label: 'Fetching metrics', icon: Activity },
		analyze_deployment_resources: { label: 'Analyzing resources', icon: Activity },
		list_databases: { label: 'Listing databases', icon: Database },
		get_database: { label: 'Loading database info', icon: Database },
		get_env_vars: { label: 'Reading env vars', icon: Settings },
		list_ingresses: { label: 'Checking domains', icon: Globe },
		restart_deployment: { label: 'Restarting app', icon: Rocket },
		rebuild_deployment: { label: 'Redeploying from source', icon: Rocket },
		scale_deployment: { label: 'Scaling app', icon: Server },
		add_env_vars: { label: 'Updating env vars', icon: Settings },
		create_ingress: { label: 'Creating domain route', icon: Globe },
		create_project: { label: 'Creating project', icon: Folder },
		create_deployment: { label: 'Creating app', icon: Rocket },
		deploy_from_github: { label: 'Deploying from GitHub', icon: Rocket },
		create_database: { label: 'Provisioning database', icon: Database },
		delete_deployment: { label: 'Deleting app', icon: Rocket },
		delete_database: { label: 'Deleting database', icon: Database }
	};

	function getToolMeta(name: string) {
		return TOOL_META[name] ?? { label: name.replace(/_/g, ' '), icon: Wrench };
	}

	// Status helpers matching the overview cards
	function depStatusClass(status?: string): string {
		if (!status) return 'dot--gray';
		const s = status.toLowerCase();
		if (s === 'running' || s === 'ready' || s === 'available') return 'dot--green';
		if (s === 'building' || s === 'pending' || s === 'scaling') return 'dot--amber';
		if (s === 'error' || s === 'failed' || s === 'crashloopbackoff') return 'dot--red';
		return 'dot--gray';
	}
	function depStatusText(status?: string): string {
		if (!status) return 'Unknown';
		return status.charAt(0).toUpperCase() + status.slice(1);
	}

	// Determine what kind of card data a tool returned
	function hasCardData(tc: ToolCall): boolean {
		if (!tc.success || !tc.data) return false;
		if (Array.isArray(tc.data) && tc.data.length > 0 && tc.data[0]?.name) return true;
		if (tc.data && typeof tc.data === 'object' && 'name' in tc.data) return true;
		return false;
	}

	let input = $state('');
	let messages = $state<Message[]>([]);
	let streaming = $state(false);
	let messagesEl = $state<HTMLElement | null>(null);
	let inputEl = $state<HTMLTextAreaElement | null>(null);
	let showScrollBtn = $state(false);

	let now = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	function startTicker() {
		if (!tickInterval)
			tickInterval = setInterval(() => {
				now = Date.now();
			}, 100);
	}
	function stopTicker() {
		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}
	}

	function scrollToBottom() {
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
	}
	function handleScroll() {
		if (!messagesEl) return;
		showScrollBtn = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 80;
	}

	function formatElapsed(ms: number): string {
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function clearChat() {
		messages = [];
	}

	function resizeInput() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
	}

	const suggestions = [
		'What deployments are running?',
		'Show me my projects',
		'Check resource usage',
		'List my databases'
	];

	function useSuggestion(text: string) {
		input = text;
		tick().then(() => {
			inputEl?.focus();
			resizeInput();
		});
	}

	async function sendMessage() {
		const text = input.trim();
		if (!text || streaming) return;

		messages.push({ id: crypto.randomUUID(), role: 'user', content: text });
		messages.push({
			id: crypto.randomUUID(),
			role: 'assistant',
			content: '',
			loading: true,
			toolCalls: []
		});
		const assistantMsg = messages[messages.length - 1];
		input = '';
		streaming = true;
		startTicker();

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
				body: JSON.stringify({ messages: chatHistory })
			});

			if (!res.ok) {
				assistantMsg.content = 'Something went wrong. Please try again.';
				assistantMsg.loading = false;
				streaming = false;
				stopTicker();
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				assistantMsg.content = 'No response stream available.';
				assistantMsg.loading = false;
				streaming = false;
				stopTicker();
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
							assistantMsg.toolCalls = [
								...(assistantMsg.toolCalls ?? []),
								{ name: event.name, startedAt: Date.now() }
							];
							assistantMsg.loading = true;
							await tick();
							if (!showScrollBtn) scrollToBottom();
						} else if (event.type === 'tool_result') {
							const calls = assistantMsg.toolCalls ?? [];
							const last = calls.findLast((c) => c.name === event.name && c.success === undefined);
							if (last) {
								last.success = event.success;
								last.error = event.error;
								last.data = event.data;
								last.elapsed = Date.now() - last.startedAt;
								assistantMsg.toolCalls = [...calls];
							}
							await tick();
							if (!showScrollBtn) scrollToBottom();
						} else if (event.type === 'error') {
							assistantMsg.content += `\n\nError: ${event.error}`;
							assistantMsg.loading = false;
						} else if (event.type === 'done') {
							assistantMsg.loading = false;
						}
					} catch {
						/* skip malformed */
					}
				}
			}

			assistantMsg.loading = false;
		} catch (err) {
			assistantMsg.content = `Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}`;
			assistantMsg.loading = false;
		} finally {
			streaming = false;
			stopTicker();
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
</script>

{#if !$aiEnabled}
	<div class="gate">
		<Bot size={32} />
		<p>AI Chat is not available yet.</p>
	</div>
{:else}
	<div class="chat-page">
		<div class="messages-wrap">
			<div class="messages" bind:this={messagesEl} onscroll={handleScroll}>
				{#if messages.length === 0}
					<div class="ai-empty" {@attach motionStagger({ index: 0, from: { y: 12 } })}>
						<div class="ai-empty-icon"><Sparkles size={28} /></div>
						<h2 class="ai-empty-title">Orchard AI</h2>
						<p class="ai-empty-sub">
							Ask me anything about your infrastructure — deployments, databases, logs, metrics, and
							more.
						</p>
						<div class="suggestions">
							{#each suggestions as s, i (s)}
								<button
									class="suggestion"
									onclick={() => useSuggestion(s)}
									{@attach motionStagger({ index: i + 1, stride: 0.06, from: { y: 8 } })}
									{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}>{s}</button
								>
							{/each}
						</div>
					</div>
				{:else}
					{#each messages as msg (msg.id)}
						<div class="msg msg--{msg.role}">
							{#if msg.role === 'assistant'}
								<div class="msg-avatar"><Bot size={14} /></div>
							{/if}
							<div class="msg-body">
								{#if msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0}
									<div class="tool-calls">
										{#each msg.toolCalls as tc, ti (ti)}
											{@const meta = getToolMeta(tc.name)}
											<div
												class="tool-card"
												class:tool-card--running={tc.success === undefined}
												class:tool-card--ok={tc.success === true}
												class:tool-card--err={tc.success === false}
											>
												<!-- Tool header with spinner/check -->
												<div class="tool-header">
													<div
														class="tool-icon-wrap"
														class:tool-icon-wrap--running={tc.success === undefined}
													>
														{#if tc.success === undefined}
															<div class="tool-spinner"></div>
														{:else if tc.success}
															<div class="tool-done"><Check size={12} /></div>
														{:else}
															<div class="tool-fail"><X size={12} /></div>
														{/if}
													</div>
													<span class="tool-label-text">{meta.label}</span>
													<span class="tool-elapsed">
														{#if tc.success === undefined}
															{formatElapsed(now - tc.startedAt)}
														{:else if tc.elapsed}
															{formatElapsed(tc.elapsed)}
														{/if}
													</span>
												</div>

												<!-- Real card grid for results -->
												{#if tc.success && hasCardData(tc)}
													<div class="tool-cards">
														{#if Array.isArray(tc.data)}
															<div class="od-grid">
																{#each tc.data.slice(0, 9) as item, ci (ci)}
																	<div
																		class="card"
																		{@attach motionStagger({
																			index: ci,
																			stride: 0.04,
																			from: { y: 10 }
																		})}
																		{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
																	>
																		<div class="card-top">
																			<div class="card-av">
																				{#if tc.name.includes('database')}
																					<Database size={13} />
																				{:else if tc.name.includes('project')}
																					<Folder size={13} />
																				{:else if tc.name.includes('pod')}
																					<Server size={13} />
																				{:else}
																					<Rocket size={13} />
																				{/if}
																			</div>
																			<div class="card-text">
																				<span class="card-name"
																					>{item.name ||
																						item.slug ||
																						item.podName ||
																						'Unknown'}</span
																				>
																				{#if item.ingresses?.length}
																					<span class="card-sub">{item.ingresses[0].host}</span>
																				{:else if item.githubRepo}
																					<span class="card-sub"
																						>{item.githubRepo}{item.githubBranch
																							? `/${item.githubBranch}`
																							: ''}</span
																					>
																				{:else if item.image}
																					<span class="card-sub">{item.image}</span>
																				{:else if item.dbName}
																					<span class="card-sub">{item.dbName}</span>
																				{:else if item.description}
																					<span class="card-sub">{item.description}</span>
																				{:else if item.project?.name}
																					<span class="card-sub">{item.project.name}</span>
																				{/if}
																			</div>
																		</div>
																		<div class="card-bot">
																			{#if item.status}
																				<span class="card-status">
																					<span class="dot {depStatusClass(item.status)}"></span>
																					{depStatusText(item.status)}
																				</span>
																			{:else if item._count}
																				<span class="card-status">
																					<Rocket size={10} />
																					{item._count.deployments ?? 0}
																					<Database size={10} style="margin-left:0.375rem" />
																					{item._count.databases ?? 0}
																				</span>
																			{/if}
																		</div>
																	</div>
																{/each}
															</div>
															{#if tc.data.length > 9}
																<p class="tool-overflow">+{tc.data.length - 9} more</p>
															{/if}
														{:else if tc.data && typeof tc.data === 'object' && 'name' in tc.data}
															<!-- Single resource detail -->
															<div class="od-grid">
																<div
																	class="card"
																	{@attach motionStagger({ index: 0, from: { y: 10 } })}
																	{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
																>
																	<div class="card-top">
																		<div class="card-av">
																			{#if tc.name.includes('database')}
																				<Database size={13} />
																			{:else if tc.name.includes('project')}
																				<Folder size={13} />
																			{:else}
																				<Rocket size={13} />
																			{/if}
																		</div>
																		<div class="card-text">
																			<span class="card-name">{tc.data.name}</span>
																			{#if tc.data.ingresses?.length}
																				<span class="card-sub">{tc.data.ingresses[0].host}</span>
																			{:else if tc.data.githubRepo}
																				<span class="card-sub">{tc.data.githubRepo}</span>
																			{:else if tc.data.image}
																				<span class="card-sub">{tc.data.image}</span>
																			{:else if tc.data.dbName}
																				<span class="card-sub">{tc.data.dbName}</span>
																			{/if}
																		</div>
																	</div>
																	<div class="card-bot">
																		{#if tc.data.status}
																			<span class="card-status">
																				<span class="dot {depStatusClass(tc.data.status)}"></span>
																				{depStatusText(tc.data.status)}
																			</span>
																		{/if}
																		{#if tc.data.replicas !== undefined}
																			<span class="card-meta"
																				>{tc.data.replicas} replica{tc.data.replicas !== 1
																					? 's'
																					: ''}</span
																			>
																		{/if}
																	</div>
																</div>
															</div>
															{#if tc.data.deployments?.length || tc.data.databases?.length}
																<div class="od-grid" style="margin-top:0.5rem">
																	{#each (tc.data.deployments ?? []).slice(0, 6) as dep, ci (ci)}
																		<div
																			class="card"
																			{@attach motionStagger({
																				index: ci,
																				stride: 0.04,
																				from: { y: 10 }
																			})}
																			{@attach springHover({
																				lift: -3,
																				stiffness: 360,
																				damping: 22
																			})}
																		>
																			<div class="card-top">
																				<div class="card-av"><Rocket size={13} /></div>
																				<div class="card-text">
																					<span class="card-name">{dep.name}</span>
																					{#if dep.ingresses?.length}
																						<span class="card-sub">{dep.ingresses[0].host}</span>
																					{/if}
																				</div>
																			</div>
																			<div class="card-bot">
																				{#if dep.status}
																					<span class="card-status">
																						<span class="dot {depStatusClass(dep.status)}"></span>
																						{depStatusText(dep.status)}
																					</span>
																				{/if}
																			</div>
																		</div>
																	{/each}
																	{#each (tc.data.databases ?? []).slice(0, 4) as db, ci (ci)}
																		<div
																			class="card"
																			{@attach motionStagger({
																				index: ci + (tc.data.deployments?.length ?? 0),
																				stride: 0.04,
																				from: { y: 10 }
																			})}
																			{@attach springHover({
																				lift: -3,
																				stiffness: 360,
																				damping: 22
																			})}
																		>
																			<div class="card-top">
																				<div class="card-av"><Database size={13} /></div>
																				<div class="card-text">
																					<span class="card-name">{db.name}</span>
																					{#if db.dbName}<span class="card-sub">{db.dbName}</span
																						>{/if}
																				</div>
																			</div>
																			<div class="card-bot">
																				{#if db.status}
																					<span class="card-status">
																						<span class="dot {depStatusClass(db.status)}"></span>
																						{depStatusText(db.status)}
																					</span>
																				{/if}
																			</div>
																		</div>
																	{/each}
																</div>
															{/if}
														{/if}
													</div>
												{/if}

												{#if tc.success === undefined}
													<div class="tool-progress"><div class="tool-progress-bar"></div></div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}

								{#if msg.content}
									{#if msg.role === 'assistant'}
										<!-- eslint-disable-next-line svelte/no-at-html-tags -->
										<div class="msg-text msg-text--md">{@html renderMarkdown(msg.content)}</div>
									{:else}
										<div class="msg-text">{msg.content}</div>
									{/if}
								{/if}

								{#if msg.loading && !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0)}
									<div class="msg-thinking">
										<span class="thinking-dot"></span><span class="thinking-dot"></span><span
											class="thinking-dot"
										></span>
									</div>
								{/if}
							</div>
						</div>
					{/each}
				{/if}
			</div>

			{#if showScrollBtn}
				<button class="scroll-btn" onclick={scrollToBottom}>New messages below</button>
			{/if}
		</div>

		<div class="input-area">
			{#if messages.length > 0}
				<button
					class="clear-btn"
					onclick={clearChat}
					aria-label="Clear chat"
					{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}
					><Trash2 size={14} /></button
				>
			{/if}
			<form
				class="input-bar"
				onsubmit={(e) => {
					e.preventDefault();
					sendMessage();
				}}
			>
				<textarea
					bind:this={inputEl}
					bind:value={input}
					placeholder="Ask about your infrastructure..."
					rows={1}
					onkeydown={handleKeydown}
					oninput={resizeInput}
					disabled={streaming}
				></textarea>
				<button
					type="submit"
					class="send-btn"
					disabled={!input.trim() || streaming}
					aria-label="Send"
					{@attach springHover({ lift: -1, stiffness: 520, damping: 28 })}
				>
					{#if streaming}<Loader2 size={18} class="animate-spin" />{:else}<Send size={18} />{/if}
				</button>
			</form>
		</div>
	</div>
{/if}

<style>
	.gate {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 0.75rem;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.chat-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		max-width: 56rem;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	.messages-wrap {
		flex: 1;
		position: relative;
		overflow: hidden;
		min-height: 0;
	}
	.messages {
		height: 100%;
		overflow-y: auto;
		padding: 2rem 0;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	/* ── Empty state ────────────────────────────────── */
	.ai-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 0.5rem;
		padding: 2rem;
	}
	.ai-empty-icon {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--button-bg) 12%, transparent);
		color: var(--button-bg);
		margin-bottom: 0.5rem;
	}
	.ai-empty-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}
	.ai-empty-sub {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		max-width: 24rem;
		line-height: 1.5;
		margin: 0;
	}
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: center;
		margin-top: 1rem;
	}
	.suggestion {
		padding: 0.4375rem 0.875rem;
		border-radius: 2rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.suggestion:hover {
		border-color: var(--button-bg);
		color: var(--button-bg);
	}

	/* ── Messages ───────────────────────────────────── */
	.msg {
		display: flex;
		gap: 0.625rem;
		max-width: 100%;
	}
	.msg--user {
		justify-content: flex-end;
	}
	.msg--assistant {
		justify-content: flex-start;
	}

	.msg-avatar {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--button-bg) 12%, transparent);
		color: var(--button-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}

	.msg-body {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		max-width: 90%;
		min-width: 0;
	}
	.msg--user .msg-body {
		max-width: 70%;
	}

	.msg-text {
		padding: 0.625rem 0.875rem;
		border-radius: 0.75rem;
		font-size: 0.8125rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.msg--user .msg-text {
		background: var(--button-bg);
		color: var(--button-color);
		border-bottom-right-radius: 0.25rem;
	}
	.msg--assistant .msg-text {
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
		color: var(--center-channel-color);
		border-bottom-left-radius: 0.25rem;
	}

	/* ── Markdown ───────────────────────────────────── */
	.msg-text--md {
		white-space: normal;
	}
	.msg-text--md :global(p) {
		margin: 0 0 0.5em;
	}
	.msg-text--md :global(p:last-child) {
		margin-bottom: 0;
	}
	.msg-text--md :global(strong) {
		font-weight: 600;
	}
	.msg-text--md :global(code) {
		background: color-mix(in srgb, var(--surface-border) 60%, transparent);
		padding: 0.125em 0.3em;
		border-radius: 0.25rem;
		font-size: 0.8em;
		font-family: 'SF Mono', 'Fira Code', monospace;
	}
	.msg-text--md :global(pre) {
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		padding: 0.625rem 0.75rem;
		border-radius: 0.375rem;
		overflow-x: auto;
		margin: 0.5em 0;
		font-size: 0.75rem;
	}
	.msg-text--md :global(pre code) {
		background: none;
		padding: 0;
	}
	.msg-text--md :global(ul),
	.msg-text--md :global(ol) {
		margin: 0.25em 0 0.5em;
		padding-left: 1.25em;
	}
	.msg-text--md :global(li) {
		margin: 0.125em 0;
	}
	.msg-text--md :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.5em 0;
		font-size: 0.75rem;
	}
	.msg-text--md :global(th) {
		text-align: left;
		padding: 0.375rem 0.5rem;
		font-weight: 600;
		border-bottom: 2px solid var(--surface-border);
	}
	.msg-text--md :global(td) {
		padding: 0.3125rem 0.5rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
	.msg-text--md :global(tr:last-child td) {
		border-bottom: none;
	}
	.msg-text--md :global(blockquote) {
		border-left: 3px solid var(--button-bg);
		margin: 0.5em 0;
		padding: 0.25em 0.75em;
		color: var(--surface-muted);
	}
	.msg-text--md :global(a) {
		color: var(--button-bg);
		text-decoration: underline;
	}
	.msg-text--md :global(h1),
	.msg-text--md :global(h2),
	.msg-text--md :global(h3) {
		margin: 0.5em 0 0.25em;
		font-weight: 700;
	}
	.msg-text--md :global(h1) {
		font-size: 1.1em;
	}
	.msg-text--md :global(h2) {
		font-size: 1em;
	}
	.msg-text--md :global(h3) {
		font-size: 0.9em;
	}

	/* ── Tool call cards ────────────────────────────── */
	.tool-calls {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.tool-card {
		border-radius: 0.75rem;
		font-size: 0.75rem;
		background: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
		position: relative;
		overflow: hidden;
		animation: tool-enter 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.tool-card--running {
		border-color: color-mix(in srgb, var(--button-bg) 35%, transparent);
	}
	.tool-card--ok {
		border-color: color-mix(in srgb, #22c55e 25%, transparent);
	}
	.tool-card--err {
		border-color: color-mix(in srgb, var(--error-text-color) 25%, transparent);
	}

	.tool-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
	}

	.tool-icon-wrap {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.tool-icon-wrap--running {
		animation: pulse-glow 2s ease-in-out infinite;
	}

	.tool-spinner {
		width: 0.875rem;
		height: 0.875rem;
		border: 2px solid color-mix(in srgb, var(--button-bg) 25%, transparent);
		border-top-color: var(--button-bg);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	.tool-done {
		color: #22c55e;
		display: flex;
		align-items: center;
		justify-content: center;
		animation: pop-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.tool-fail {
		color: var(--error-text-color);
		display: flex;
		align-items: center;
		justify-content: center;
		animation: pop-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.tool-label-text {
		flex: 1;
		font-weight: 500;
		color: var(--center-channel-color);
	}
	.tool-elapsed {
		color: var(--surface-muted);
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	/* Card grid inside tool results — uses org-dashboard .od-grid, .card, etc. */
	.tool-cards {
		padding: 0 0.625rem 0.75rem;
		animation: data-reveal 0.35s ease-out;
	}
	.tool-cards :global(.od-grid) {
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
	}
	.tool-cards :global(.card) {
		min-height: 5.5rem;
	}

	.tool-overflow {
		margin: 0.5rem 0 0;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		font-style: italic;
		text-align: center;
	}

	.tool-progress {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 2px;
		background: color-mix(in srgb, var(--button-bg) 12%, transparent);
		overflow: hidden;
	}
	.tool-progress-bar {
		height: 100%;
		width: 40%;
		background: var(--button-bg);
		border-radius: 1px;
		animation: progress-slide 1.2s ease-in-out infinite;
	}

	/* ── Thinking dots ──────────────────────────────── */
	.msg-thinking {
		display: flex;
		gap: 0.3rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
		border-bottom-left-radius: 0.25rem;
		width: fit-content;
	}
	.thinking-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--surface-muted);
		animation: bounce 1.4s infinite;
	}
	.thinking-dot:nth-child(2) {
		animation-delay: 0.16s;
	}
	.thinking-dot:nth-child(3) {
		animation-delay: 0.32s;
	}

	.scroll-btn {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.3125rem 0.75rem;
		border-radius: 2rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--surface-muted);
		font-size: 0.6875rem;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}
	.scroll-btn:hover {
		color: var(--center-channel-color);
	}

	/* ── Input ──────────────────────────────────────── */
	.input-area {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		padding: 1rem 0 1.5rem;
		flex-shrink: 0;
	}
	.clear-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
	}
	.clear-btn:hover {
		color: var(--error-text-color);
		border-color: color-mix(in srgb, var(--error-text-color) 40%, transparent);
	}

	.input-bar {
		flex: 1;
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem 0.5rem 0.875rem;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		box-shadow:
			0 1px 4px rgba(0, 0, 0, 0.04),
			0 4px 12px rgba(0, 0, 0, 0.03);
	}
	.input-bar:focus-within {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}
	.input-bar textarea {
		flex: 1;
		padding: 0.375rem 0;
		border: none;
		background: none;
		color: var(--center-channel-color);
		font-size: 0.875rem;
		font-family: inherit;
		line-height: 1.5;
		resize: none;
		overflow-y: auto;
		max-height: 10rem;
	}
	.input-bar textarea:focus {
		outline: none;
	}
	.input-bar textarea::placeholder {
		color: var(--surface-muted);
	}
	.input-bar textarea:disabled {
		opacity: 0.5;
	}

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		border: none;
		background: var(--button-bg);
		color: var(--button-color);
		cursor: pointer;
		flex-shrink: 0;
	}
	.send-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	/* ── Animations ─────────────────────────────────── */
	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes bounce {
		0%,
		80%,
		100% {
			transform: scale(0.6);
			opacity: 0.4;
		}
		40% {
			transform: scale(1);
			opacity: 1;
		}
	}
	@keyframes pop-in {
		0% {
			transform: scale(0);
		}
		100% {
			transform: scale(1);
		}
	}
	@keyframes progress-slide {
		0% {
			transform: translateX(-100%);
		}
		50% {
			transform: translateX(200%);
		}
		100% {
			transform: translateX(200%);
		}
	}
	@keyframes tool-enter {
		0% {
			opacity: 0;
			transform: translateY(8px) scale(0.97);
		}
		100% {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@keyframes data-reveal {
		0% {
			opacity: 0;
			transform: translateY(4px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes pulse-glow {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.6;
		}
	}
</style>
