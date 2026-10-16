<script lang="ts">
	import { tick } from 'svelte';
	import {
		ArrowUp,
		Bot,
		Check,
		Circle,
		CircleCheck,
		CircleDot,
		CircleX,
		ListChecks,
		ListPlus,
		MessageCircle,
		Paperclip,
		Plus,
		ShieldCheck,
		Square,
		X
	} from 'lucide-svelte';
	import { Avatar, Menu, MenuItem } from '@orchardlabs/graft-ui';
	import { askNotificationPermission } from '../../greenhouse/agent-alerts';
	import { modKey } from '../../greenhouse/format';
	import { greenhousePrefs } from '../../greenhouse/prefs.svelte';
	import { fly, slide } from '../../../lib/utils/transitions';
	import { OC_ATTACH_MAX_COUNT } from '../opencode';
	import { alternateChord, followUpFor, sendChord, sendIntent } from './composer-keys';
	import type { ChatSessionStore, RemoteDraft } from './session-store.svelte';
	import { runChatCommand } from './chat-commands';
	import {
		commandLine,
		findCommand,
		parseSlash,
		rankCommands,
		rankOptions,
		runsImmediately,
		sectionsOf,
		type SlashCommand,
		type SlashMatch,
		type SlashNotice,
		type SlashOption
	} from './slash-commands';
	import ContextRing from './ContextRing.svelte';
	import McpServers from './McpServers.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import FileParts from './parts/FileParts.svelte';
	import { truncate } from './format';

	let {
		store,
		remoteDrafts = [],
		onComment = undefined,
		commands = [],
		onCommand = undefined,
		options = undefined
	}: {
		store: ChatSessionStore;
		remoteDrafts?: RemoteDraft[];
		onComment?: (text: string) => void | Promise<void>;
		commands?: SlashCommand[];
		onCommand?: (
			command: SlashCommand,
			args: string,
			alias: string | null
		) => SlashNotice | null | void | Promise<SlashNotice | null | void>;
		options?: (command: SlashCommand) => SlashOption[];
	} = $props();

	const uid = $props.id();
	const COMMENT = /^\/chat(?:\s([\s\S]*))?$/;
	const ARGS = /^\/(\S+)\s([\s\S]*)$/;
	const NOTICE_MS = 6000;
	const CHAT_COMMAND: SlashCommand = {
		name: 'chat',
		group: 'chat',
		description: 'Message the people in this session without asking the agent',
		hint: '<message>',
		args: 'required',
		source: 'local'
	};
	const TODO_ICONS = {
		completed: CircleCheck,
		in_progress: CircleDot,
		cancelled: CircleX
	} as const;

	let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
	let fileInputEl = $state<HTMLInputElement | undefined>(undefined);
	let dropActive = $state(false);
	let editingId = $state<string | null>(null);
	let editText = $state('');
	let pick = $state(0);
	let dismissed = $state<string | null>(null);
	let notice = $state<SlashNotice | null>(null);
	let modelOpen = $state(false);
	let contextOpen = $state(false);
	let mcpOpen = $state(false);
	let noticeTimer: ReturnType<typeof setTimeout> | null = null;

	const thread = $derived(store.active);
	const queue = $derived(thread?.queue ?? []);
	const typing = $derived(remoteDrafts.filter((d) => d.text.trim().length > 0));
	const available = $derived.by<SlashCommand[]>(() => {
		const rest = commands.filter((c) => c.name !== 'chat');
		if (!onComment) return rest;
		return [commands.find((c) => c.name === 'chat') ?? CHAT_COMMAND, ...rest];
	});
	const token = $derived(/^\/(\S*)$/.exec(store.draft)?.[1] ?? null);
	const matches = $derived<SlashMatch[]>(
		token === null || token === dismissed ? [] : rankCommands(available, token)
	);
	const sections = $derived(sectionsOf(matches));
	const typed = $derived.by(() => {
		if (token !== null) return null;
		const parts = ARGS.exec(store.draft);
		if (!parts) return null;
		const found = findCommand(available, parts[1]);
		return found ? { ...found, label: parts[1], args: parts[2] } : null;
	});
	const choices = $derived.by<SlashOption[]>(() => {
		if (!typed || typed.command.name === 'chat' || !options) return [];
		if (dismissed === store.draft) return [];
		return rankOptions(options(typed.command), typed.args);
	});
	const hint = $derived(
		typed &&
			typed.command.name !== 'chat' &&
			!typed.args.trim() &&
			choices.length === 0 &&
			typed.command.hint
			? commandLine(typed.command, typed.label)
			: null
	);
	const listed = $derived(matches.length > 0 ? matches.length : choices.length);
	const active = $derived(listed === 0 ? 0 : Math.min(pick, listed - 1));
	const commenting = $derived(!!onComment && token === null && COMMENT.test(store.draft));
	const commentBody = $derived(commenting ? (COMMENT.exec(store.draft)?.[1] ?? '').trim() : '');
	const hasInput = $derived(
		commenting
			? commentBody.length > 0
			: store.draft.trim().length > 0 || store.attachments.length > 0
	);
	const prefs = $derived(greenhousePrefs.values);
	const mod = modKey();
	const chord = $derived(sendChord(prefs.sendWith, mod));
	const altChord = $derived(alternateChord(prefs.sendWith, mod));
	const steering = $derived(store.busy && prefs.followUp === 'steer');
	const placeholder = $derived.by(() => {
		if (commenting) return 'Write a comment';
		if (!store.busy) return 'Ask to make changes, @mention files, run /commands';
		return steering
			? `Steer the agent, ${altChord} to queue instead`
			: `Queue a follow up, ${altChord} to steer`;
	});
	const sendLabel = $derived(
		commenting
			? 'Send comment'
			: !store.busy
				? 'Send prompt'
				: steering
					? 'Steer now'
					: 'Queue prompt'
	);
	const sendTitle = $derived(
		`${commenting ? 'Comment' : !store.busy ? 'Send' : steering ? 'Steer' : 'Queue'} (${chord})`
	);

	function autosize() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = `${Math.min(inputEl.scrollHeight, 260)}px`;
	}

	function hasChoices(command: SlashCommand): boolean {
		return command.name !== 'chat' && (options?.(command).length ?? 0) > 0;
	}

	function complete(match: SlashMatch) {
		store.draft = `/${match.label} `;
		pick = 0;
		dismissed = null;
		inputEl?.focus();
		requestAnimationFrame(autosize);
	}

	function choose(match: SlashMatch, run: boolean) {
		if (run && runsImmediately(match.command, hasChoices(match.command))) {
			void execute(match.command, '', match.label === match.command.name ? null : match.label);
			return;
		}
		complete(match);
	}

	function chooseOption(option: SlashOption) {
		const current = typed;
		if (!current) return;
		void execute(current.command, option.value, current.alias);
	}

	function showNotice(next: SlashNotice | null) {
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = null;
		notice = next;
		if (next && !next.todos) noticeTimer = setTimeout(() => (notice = null), NOTICE_MS);
	}

	async function execute(command: SlashCommand, args: string, alias: string | null) {
		store.draft = '';
		pick = 0;
		dismissed = null;
		showNotice(null);
		requestAnimationFrame(autosize);
		if (command.name === 'chat') {
			if (args) await onComment?.(args);
			else store.draft = '/chat ';
			return;
		}
		if (!args && !runsImmediately(command, hasChoices(command))) {
			store.draft = `/${alias ?? command.name} `;
			inputEl?.focus();
			return;
		}
		const ui = {
			help: () => {
				store.draft = '/';
				inputEl?.focus();
			},
			model: () => (modelOpen = true),
			context: () => (contextOpen = true),
			mcp: () => (mcpOpen = true)
		};
		let outcome = await runChatCommand({
			store,
			command,
			args,
			options: options?.(command) ?? [],
			ui
		});
		if (outcome === undefined) outcome = (await onCommand?.(command, args, alias)) ?? null;
		showNotice(outcome);
	}

	function scrollActive() {
		void tick().then(() =>
			document.getElementById(`${uid}-slash-${active}`)?.scrollIntoView({ block: 'nearest' })
		);
	}

	async function submit(alternate = false) {
		if (matches.length > 0) {
			choose(matches[active], true);
			return;
		}
		if (choices.length > 0) {
			chooseOption(choices[active]);
			return;
		}
		const slash = !commenting && store.attachments.length === 0 ? parseSlash(store.draft) : null;
		const found = slash ? findCommand(available, slash.name) : null;
		if (slash && found && found.command.name !== 'chat') {
			await execute(found.command, slash.args, found.alias);
			return;
		}
		if (commenting) {
			if (!commentBody) return;
			const body = commentBody;
			store.draft = '';
			requestAnimationFrame(autosize);
			await onComment?.(body);
			return;
		}
		if (!hasInput) return;
		if (prefs.notifyAgent) askNotificationPermission();
		const pending = store.send(followUpFor(alternate ? 'alternate' : 'send', prefs.followUp));
		requestAnimationFrame(autosize);
		await pending;
	}

	function toggleAuto() {
		greenhousePrefs.set('autoAcceptPermissions', !prefs.autoAcceptPermissions);
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'Tab' && e.shiftKey && listed === 0 && !e.altKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			toggleAuto();
			return;
		}
		if (listed > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				pick = (active + step + listed) % listed;
				scrollActive();
				return;
			}
			const send = sendIntent(e, prefs.sendWith) !== null;
			if (e.key === 'Tab' || send || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
				e.preventDefault();
				if (matches.length > 0) choose(matches[active], send);
				else chooseOption(choices[active]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				dismissed = matches.length > 0 ? token : store.draft;
				return;
			}
		}
		const intent = sendIntent(e, prefs.sendWith);
		if (intent) {
			e.preventDefault();
			void submit(intent === 'alternate');
		} else if (e.key === 'Escape' && store.busy) {
			e.preventDefault();
			void store.abort();
		}
	}

	function dragHasFiles(e: DragEvent): boolean {
		const types = e.dataTransfer?.types;
		return !!types && Array.from(types).includes('Files');
	}

	function onDragOver(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dropActive = true;
	}

	function onDragLeave(e: DragEvent) {
		const root = e.currentTarget;
		const next = e.relatedTarget;
		if (root instanceof Node && next instanceof Node && root.contains(next)) return;
		dropActive = false;
	}

	function onDrop(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dropActive = false;
		void store.addFiles(e.dataTransfer?.files);
	}

	function onPaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind !== 'file') continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		if (files.length === 0) return;
		e.preventDefault();
		void store.addFiles(files);
	}

	function onPicked(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		void store.addFiles(target.files);
		target.value = '';
	}

	function commitEdit() {
		const id = editingId;
		editingId = null;
		if (!id) return;
		const text = editText.trim();
		if (text) store.updateQueued(id, text);
		else store.removeQueued(id);
	}

	const typingLabel = $derived.by(() => {
		if (typing.length === 0) return '';
		const first = (name: string) => name.split(' ')[0] || name;
		if (typing.length === 1) return `${first(typing[0].name)} is typing`;
		if (typing.length === 2) {
			return `${first(typing[0].name)} and ${first(typing[1].name)} are typing`;
		}
		return `${first(typing[0].name)} and ${typing.length - 1} others are typing`;
	});
</script>

<div class="composer-wrap">
	{#if typing.length > 0}
		<div class="typing" transition:slide aria-live="polite" data-align="content">
			<span class="typing-avatar" aria-hidden="true">
				<Avatar
					user={{ id: typing[0].userId, name: typing[0].name, imageUrl: typing[0].avatarUrl }}
					alt=""
					size={16}
					style="width: 1rem; height: 1rem; border-radius: 999px; object-fit: cover;"
				/>
			</span>
			<span class="typing-who">{typingLabel}</span>
			{#if typing.length === 1}
				<span class="typing-text">{truncate(typing[0].text, 140)}</span>
			{/if}
		</div>
	{/if}
	<form
		class="cmp"
		data-align="content"
		class:cmp--drop={dropActive}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		{#if matches.length > 0}
			<div class="slash" role="listbox" aria-label="Commands" transition:fly={{ y: 4 }}>
				{#each sections as section (section.group)}
					<div class="slash-group" role="group" aria-labelledby="{uid}-group-{section.group}">
						<span class="slash-head" id="{uid}-group-{section.group}">{section.label}</span>
						{#each section.items as item (item.match.command.name)}
							<button
								type="button"
								id="{uid}-slash-{item.index}"
								class="slash-item"
								class:slash-item--active={item.index === active}
								role="option"
								aria-selected={item.index === active}
								tabindex="-1"
								onmouseenter={() => (pick = item.index)}
								onmousedown={(e) => e.preventDefault()}
								onclick={() => choose(item.match, true)}
							>
								<span class="slash-name">/{item.match.label}</span>
								<span class="slash-desc">{item.match.command.description}</span>
							</button>
						{/each}
					</div>
				{/each}
			</div>
		{:else if choices.length > 0 && typed}
			<div
				class="slash"
				role="listbox"
				aria-label="/{typed.label} options"
				transition:fly={{ y: 4 }}
			>
				<div class="slash-group">
					<span class="slash-head">{commandLine(typed.command, typed.label)}</span>
					{#each choices as option, oi (option.value)}
						<button
							type="button"
							id="{uid}-slash-{oi}"
							class="slash-item"
							class:slash-item--active={oi === active}
							role="option"
							aria-selected={oi === active}
							tabindex="-1"
							onmouseenter={() => (pick = oi)}
							onmousedown={(e) => e.preventDefault()}
							onclick={() => chooseOption(option)}
						>
							<span class="slash-label">{option.label}</span>
							{#if option.description}
								<span class="slash-desc">{option.description}</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}
		{#if queue.length > 0}
			<ol class="queue" transition:slide aria-label="Queued prompts">
				{#each queue as item, qi (item.id)}
					<li class="queued" data-align="inset">
						<span class="queued-index">{qi + 1}</span>
						{#if editingId === item.id}
							<input
								class="queued-edit"
								bind:value={editText}
								aria-label="Edit queued prompt"
								onkeydown={(e) => {
									if (e.key === 'Enter') commitEdit();
									else if (e.key === 'Escape') editingId = null;
								}}
								onblur={commitEdit}
								{@attach (el) => (el as HTMLInputElement).focus()}
							/>
						{:else}
							<button
								type="button"
								class="queued-text"
								title="Edit queued prompt"
								onclick={() => {
									editingId = item.id;
									editText = item.text;
								}}
							>
								{item.text || `${item.attachments.length} attachment(s)`}
							</button>
						{/if}
						<span class="queued-actions">
							{#if !thread?.stopping}
								<button
									type="button"
									class="icon"
									aria-label={store.busy ? 'Steer now' : 'Send now'}
									title={store.busy ? 'Steer now, the agent reads it at its next step' : 'Send now'}
									onclick={() => store.sendQueuedNow(item.id)}
								>
									<ArrowUp size={16} strokeWidth={1.75} />
								</button>
							{/if}
							<button
								type="button"
								class="icon"
								aria-label="Remove from queue"
								title="Remove from queue"
								onclick={() => store.removeQueued(item.id)}
							>
								<X size={16} strokeWidth={1.75} />
							</button>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
		{#if notice}
			<div class="cmp-note" transition:slide data-align="inset" role="status">
				<div class="note-body">
					<span class="note-text">{notice.text}</span>
					{#if notice.todos}
						<ul class="todos">
							{#each notice.todos as todo, ti (ti)}
								{@const Icon = TODO_ICONS[todo.status as keyof typeof TODO_ICONS] ?? Circle}
								<li
									class="todo"
									class:todo--done={todo.status === 'completed' || todo.status === 'cancelled'}
								>
									<Icon size={14} strokeWidth={1.75} aria-label={todo.status.replace('_', ' ')} />
									<span class="todo-text">{todo.content}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				<button
					type="button"
					class="icon icon--sm"
					aria-label="Dismiss"
					title="Dismiss"
					onclick={() => showNotice(null)}
				>
					<X size={14} strokeWidth={1.75} />
				</button>
			</div>
		{/if}
		{#if hint}
			<div class="cmp-mode cmp-hint" transition:slide data-align="inset">{hint}</div>
		{/if}
		{#if commenting}
			<div class="cmp-mode" transition:slide data-align="inset">
				<MessageCircle size={14} strokeWidth={1.75} />
				Comment to the people in this session. The agent will not see it.
			</div>
		{/if}
		{#if store.attachments.length > 0 && !commenting}
			<div class="cmp-files" transition:slide>
				<FileParts
					files={store.attachments}
					size="sm"
					onremove={(id) => store.removeAttachment(id)}
				/>
			</div>
		{/if}
		<textarea
			bind:this={inputEl}
			bind:value={store.draft}
			class="cmp-input"
			rows="2"
			{placeholder}
			aria-label="Message"
			aria-autocomplete="list"
			aria-activedescendant={listed > 0 ? `${uid}-slash-${active}` : undefined}
			data-align="inset"
			oninput={autosize}
			onkeydown={onKey}
			onpaste={onPaste}></textarea>
		<div class="bar">
			<ModelPicker {store} bind:open={modelOpen} />
			{#if store.plan}
				<button
					type="button"
					class="plan-chip"
					aria-pressed="true"
					title="Plan mode: the agent reads but does not edit. Click to leave plan mode."
					onclick={() => store.setPlan(false)}
				>
					<ListChecks size={16} strokeWidth={1.75} /> Plan
				</button>
			{:else if store.agent}
				<button
					type="button"
					class="plan-chip"
					aria-pressed="true"
					title="The {store.agent} agent answers. Click to go back to the default agent."
					onclick={() => store.setAgent(null)}
				>
					<Bot size={16} strokeWidth={1.75} />
					{store.agent}
				</button>
			{/if}
			{#if prefs.autoAcceptPermissions}
				<button
					type="button"
					class="plan-chip auto-chip"
					aria-pressed="true"
					title="Auto mode: permission requests from turns you started are approved for you. Click or press Shift+Tab to ask again."
					onclick={toggleAuto}
				>
					<ShieldCheck size={16} strokeWidth={1.75} /> Auto
				</button>
			{/if}
			<span class="bar-spacer"></span>
			<ContextRing
				bind:open={contextOpen}
				meter={store.context}
				sandboxId={store.sandboxId}
				always={prefs.alwaysShowContext}
			/>
			{#if prefs.showMcpStatus || mcpOpen}
				<McpServers {store} bind:open={mcpOpen} />
			{/if}
			<input
				bind:this={fileInputEl}
				class="file-input"
				type="file"
				multiple
				accept="image/*,text/*,application/pdf"
				tabindex="-1"
				aria-hidden="true"
				onchange={onPicked}
			/>
			<Menu placement="top-end">
				{#snippet trigger(props, open)}
					<button
						type="button"
						class="icon"
						class:icon--open={open}
						aria-label="Add context"
						title="Add files, plan mode or a comment"
						{...props}
					>
						<Plus size={16} strokeWidth={1.75} />
					</button>
				{/snippet}
				<MenuItem
					disabled={store.attachments.length >= OC_ATTACH_MAX_COUNT}
					onclick={() => fileInputEl?.click()}
				>
					<Paperclip class="h-3.5 w-3.5" /> Attach files or images
				</MenuItem>
				<MenuItem onclick={() => store.setPlan(!store.plan)}>
					<ListChecks class="h-3.5 w-3.5" />
					<span class="menu-label">Plan mode, read only</span>
					{#if store.plan}<Check class="h-3 w-3" />{/if}
				</MenuItem>
				<MenuItem onclick={toggleAuto}>
					<ShieldCheck class="h-3.5 w-3.5" />
					<span class="menu-label">Auto-approve permissions</span>
					<kbd class="menu-kbd">⇧Tab</kbd>
					{#if prefs.autoAcceptPermissions}<Check class="h-3 w-3" />{/if}
				</MenuItem>
				{#if onComment}
					<MenuItem
						onclick={() => {
							store.draft = '/chat ';
							inputEl?.focus();
						}}
					>
						<MessageCircle class="h-3.5 w-3.5" /> Comment to the people here
					</MenuItem>
				{/if}
			</Menu>
			{#if store.busy}
				<button
					type="button"
					class="icon icon--stop"
					disabled={thread?.stopping}
					aria-label="Stop the agent"
					title="Stop (Esc)"
					onclick={() => store.abort()}
				>
					<span class="stop-ring"><Square size={8} fill="currentColor" strokeWidth={0} /></span>
				</button>
			{/if}
			<button
				type="submit"
				class="send"
				disabled={!hasInput}
				aria-label={sendLabel}
				title={sendTitle}
			>
				{#if commenting}
					<MessageCircle size={16} strokeWidth={2} />
				{:else if store.busy && !steering}
					<ListPlus size={16} strokeWidth={2} />
				{:else}
					<ArrowUp size={16} strokeWidth={2} />
				{/if}
			</button>
		</div>
	</form>
</div>

<style>
	.composer-wrap {
		font-weight: 400;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
	}

	.typing {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		margin-top: var(--space-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.typing-avatar {
		position: absolute;
		top: 0;
		left: calc(-1 * var(--chat-gutter, 2rem));
		display: flex;
		justify-content: center;
		width: var(--chat-gutter, 2rem);
	}

	.typing-who {
		flex-shrink: 0;
	}

	.typing-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.cmp {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) calc(var(--space-4) + 1px) var(--space-2);
		border: none;
		border-radius: var(--radius-lg);
		background: var(--bg-raised);
		box-shadow:
			0 0 0 1px var(--border-default),
			var(--elev-1);
		transition: box-shadow var(--dur-fast);
	}

	.cmp:focus-within {
		box-shadow:
			0 0 0 1px var(--border-strong),
			var(--elev-1);
	}

	.cmp--drop {
		outline: 1px dashed var(--border-strong);
		outline-offset: 2px;
	}

	.queue {
		display: flex;
		flex-direction: column;
		margin: calc(-1 * var(--space-1)) 0 0;
		padding: 0 0 var(--space-2);
		border-bottom: 1px solid var(--border-default);
		list-style: none;
	}

	.queued {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		height: 1.75rem;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
	}

	.queued-index {
		flex-shrink: 0;
		min-width: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.queued-text,
	.queued-edit {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-align: left;
	}

	.queued-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: text;
		transition: color var(--dur-fast);
	}

	.queued-text:hover {
		color: var(--text-default);
	}

	.queued-edit {
		color: var(--text-default);
	}

	.queued-edit:focus-visible {
		outline: none;
	}

	.queued-actions {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	.cmp-mode {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.cmp-hint {
		font-family: var(--font-mono, monospace);
	}

	.cmp-note {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.note-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
		padding-top: var(--space-1);
	}

	.todos {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.todo {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		color: var(--text-default);
	}

	.todo--done {
		color: var(--text-faint);
	}

	.todo-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cmp-files {
		padding-top: var(--space-1);
	}

	.cmp-input {
		--caret-room: 3px;
		display: block;
		width: calc(100% + 2 * var(--caret-room));
		min-height: calc(2 * var(--gh-lh-reading, 1.5rem));
		margin: 0 calc(-1 * var(--caret-room));
		padding: 0 var(--caret-room);
		border: none;
		background: none;
		resize: none;
		font-family: inherit;
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		letter-spacing: normal;
		text-indent: 0;
		text-align: start;
		vertical-align: top;
		color: var(--text-default);
		caret-color: var(--accent);
	}

	.cmp-input:focus-visible {
		outline: none;
	}

	.cmp-input::placeholder {
		font: inherit;
		letter-spacing: inherit;
		text-indent: 0;
		color: var(--text-faint);
		opacity: 1;
	}

	.slash {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(100% + var(--space-2));
		z-index: 2;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-height: 20rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-1);
		border-radius: var(--radius-md);
		background: var(--bg-overlay);
		box-shadow:
			0 0 0 1px var(--border-default),
			var(--elev-3);
	}

	.slash-group {
		display: flex;
		flex-direction: column;
	}

	.slash-head {
		padding: var(--space-1) var(--space-3) 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	.slash-item {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		height: 1.75rem;
		padding: 0 var(--space-3);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.slash-item--active {
		background: var(--bg-hover);
	}

	.slash-name {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.slash-label {
		flex-shrink: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.slash-desc {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		height: 2rem;
	}

	.bar-spacer {
		flex: 1;
		min-width: var(--space-2);
	}

	.file-input {
		display: none;
	}

	.plan-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding: 0 var(--space-2) 0 var(--space-1);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--fill-quiet);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.plan-chip:hover {
		background: var(--bg-hover);
	}

	.auto-chip {
		border-color: color-mix(in srgb, var(--status-success) 45%, var(--border-default));
		background: color-mix(in srgb, var(--status-success) 12%, transparent);
	}

	.menu-kbd {
		margin-left: auto;
		padding-left: var(--space-3);
		font-family: inherit;
		font-size: var(--text-caption);
		color: var(--text-faint);
	}

	.icon {
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

	.icon:hover:not(:disabled),
	.icon--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.icon:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.icon--sm {
		width: 1.5rem;
		height: 1.5rem;
	}

	.icon--stop {
		color: var(--text-default);
	}

	.stop-ring {
		display: inline-grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-pill);
		box-shadow: inset 0 0 0 1.5px currentColor;
	}

	.menu-label {
		flex: 1;
		min-width: 0;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast);
	}

	.send:hover:not(:disabled) {
		background: color-mix(in oklab, var(--accent) 88%, var(--text-default));
	}

	.send:disabled {
		background: var(--fill-medium);
		color: var(--text-faint);
		cursor: default;
	}
</style>
