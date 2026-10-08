<script lang="ts">
	import {
		ArrowUp,
		Check,
		ChevronDown,
		ListChecks,
		ListPlus,
		MessageCircle,
		Paperclip,
		Plus,
		Square,
		X
	} from 'lucide-svelte';
	import { Avatar, Menu, MenuItem } from '$lib/components/ui';
	import { fly, slide } from '$lib/utils/transitions';
	import { OC_ATTACH_MAX_COUNT, ocShortModelName } from '../opencode';
	import type { ChatSessionStore, RemoteDraft, SlashCommand } from './session-store.svelte';
	import ContextRing from './ContextRing.svelte';
	import FileParts from './parts/FileParts.svelte';
	import { truncate } from './format';

	let {
		store,
		remoteDrafts = [],
		onComment = undefined,
		commands = []
	}: {
		store: ChatSessionStore;
		remoteDrafts?: RemoteDraft[];
		onComment?: (text: string) => void | Promise<void>;
		commands?: SlashCommand[];
	} = $props();

	const COMMENT = /^\/chat(?:\s([\s\S]*))?$/;
	const CHAT_COMMAND: SlashCommand = {
		name: 'chat',
		description: 'Message the people in this session without asking the agent'
	};

	let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
	let fileInputEl = $state<HTMLInputElement | undefined>(undefined);
	let dropActive = $state(false);
	let editingId = $state<string | null>(null);
	let editText = $state('');
	let pick = $state(0);
	let dismissed = $state<string | null>(null);

	const thread = $derived(store.active);
	const queue = $derived(thread?.queue ?? []);
	const typing = $derived(remoteDrafts.filter((d) => d.text.trim().length > 0));
	const available = $derived<SlashCommand[]>([...(onComment ? [CHAT_COMMAND] : []), ...commands]);
	const token = $derived(/^\/(\S*)$/.exec(store.draft)?.[1] ?? null);
	const matches = $derived(
		token === null || token === dismissed
			? []
			: available.filter((c) => c.name.startsWith(token.toLowerCase()))
	);
	const active = $derived(matches.length === 0 ? 0 : Math.min(pick, matches.length - 1));
	const commenting = $derived(!!onComment && token === null && COMMENT.test(store.draft));
	const commentBody = $derived(commenting ? (COMMENT.exec(store.draft)?.[1] ?? '').trim() : '');
	const hasInput = $derived(
		commenting
			? commentBody.length > 0
			: store.draft.trim().length > 0 || store.attachments.length > 0
	);
	const modelLabel = $derived(ocShortModelName(store.model?.name ?? store.modelID));
	const variantLabel = $derived(
		store.variant ? store.variant.charAt(0).toUpperCase() + store.variant.slice(1) : null
	);

	function autosize() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = `${Math.min(inputEl.scrollHeight, 260)}px`;
	}

	function complete(command: SlashCommand) {
		store.draft = `/${command.name} `;
		pick = 0;
		inputEl?.focus();
	}

	async function submit() {
		if (matches.length > 0) {
			complete(matches[active]);
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
		const pending = store.send();
		requestAnimationFrame(autosize);
		await pending;
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (matches.length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				pick = (active + step + matches.length) % matches.length;
				return;
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				complete(matches[active]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				dismissed = token;
				return;
			}
		}
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
			e.preventDefault();
			void submit();
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
</script>

<div class="composer-wrap">
	{#if typing.length > 0}
		<div class="ghosts" transition:slide aria-live="polite">
			{#each typing as draft (draft.userId)}
				<div class="ghost">
					<Avatar
						user={{ id: draft.userId, name: draft.name, imageUrl: draft.avatarUrl }}
						alt={draft.name}
						size={16}
						style="width: 1rem; height: 1rem; border-radius: 999px; object-fit: cover; flex-shrink: 0;"
					/>
					<span class="ghost-name">{draft.name} is typing…</span>
					<span class="ghost-text">{truncate(draft.text, 140)}</span>
				</div>
			{/each}
		</div>
	{/if}
	{#if queue.length > 0}
		<div class="queue" transition:slide>
			{#each queue as item, qi (item.id)}
				<div class="queued" class:queued--editing={editingId === item.id}>
					<span class="queued-index">{qi + 1}</span>
					{#if editingId === item.id}
						<input
							class="queued-input"
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
					{#if !store.busy}
						<button
							type="button"
							class="queued-btn"
							aria-label="Send now"
							title="Send now"
							onclick={() => store.sendQueuedNow(item.id)}
						>
							<ArrowUp class="h-3 w-3" />
						</button>
					{/if}
					<button
						type="button"
						class="queued-btn"
						aria-label="Remove from queue"
						title="Remove from queue"
						onclick={() => store.removeQueued(item.id)}
					>
						<X class="h-3 w-3" />
					</button>
				</div>
			{/each}
		</div>
	{/if}
	<form
		class="cmp"
		class:cmp--plan={store.plan && !commenting}
		class:cmp--comment={commenting}
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
				{#each matches as command, ci (command.name)}
					<button
						type="button"
						class="slash-item"
						class:slash-item--active={ci === active}
						role="option"
						aria-selected={ci === active}
						onmouseenter={() => (pick = ci)}
						onclick={() => complete(command)}
					>
						<span class="slash-name">/{command.name}</span>
						<span class="slash-desc">{command.description}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if commenting}
			<div class="cmp-mode" transition:slide>
				<MessageCircle class="h-3.5 w-3.5 shrink-0" />
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
			rows="3"
			placeholder="Ask to make changes, @mention files, run /commands"
			aria-label="Message"
			aria-autocomplete="list"
			oninput={autosize}
			onkeydown={onKey}
			onpaste={onPaste}></textarea>
		<div class="bar">
			<Menu placement="top-start">
				{#snippet trigger(props, open)}
					<button
						type="button"
						class="model"
						class:model--open={open}
						aria-label="Model and effort"
						{...props}
					>
						<span class="model-name">{modelLabel}</span>
						{#if variantLabel}<span class="model-effort">{variantLabel}</span>{/if}
						<ChevronDown class="h-3.5 w-3.5 shrink-0" />
					</button>
				{/snippet}
				<div class="menu-scroll">
					{#each store.modelGroups as group (group.name)}
						<div class="menu-group">{group.name}</div>
						{#each group.models as m (m.providerID + m.modelID)}
							<MenuItem onclick={() => store.pickModel(m)}>
								<span class="menu-label">{ocShortModelName(m.name)}</span>
								{#if m.providerID === store.providerID && m.modelID === store.modelID}
									<Check class="h-3 w-3" />
								{/if}
							</MenuItem>
						{/each}
					{:else}
						<div class="menu-group">Loading models</div>
					{/each}
					{#if store.variants.length > 0}
						<div class="menu-group">Effort</div>
						<MenuItem onclick={() => store.pickVariant(null)}>
							<span class="menu-label">Default</span>
							{#if !store.variant}<Check class="h-3 w-3" />{/if}
						</MenuItem>
						{#each store.variants as v (v)}
							<MenuItem onclick={() => store.pickVariant(v)}>
								<span class="menu-label">{v.charAt(0).toUpperCase() + v.slice(1)}</span>
								{#if store.variant === v}<Check class="h-3 w-3" />{/if}
							</MenuItem>
						{/each}
					{/if}
				</div>
			</Menu>
			{#if store.plan}
				<button
					type="button"
					class="plan-chip"
					title="Plan mode: the agent reads but does not edit. Click to leave plan mode."
					onclick={() => store.setPlan(false)}
				>
					<ListChecks class="h-3.5 w-3.5 shrink-0" /> Plan
				</button>
			{/if}
			<span class="bar-spacer"></span>
			<ContextRing meter={store.context} />
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
						title="Add context"
						{...props}
					>
						<Plus class="h-4 w-4" />
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
					<Square class="h-2.5 w-2.5" fill="currentColor" />
				</button>
			{/if}
			<button
				type="submit"
				class="send"
				disabled={!hasInput}
				aria-label={commenting ? 'Send comment' : store.busy ? 'Queue prompt' : 'Send prompt'}
				title={commenting ? 'Comment (↵)' : store.busy ? 'Queue (↵)' : 'Send (↵)'}
			>
				{#if commenting}
					<MessageCircle class="h-4 w-4" />
				{:else if store.busy}
					<ListPlus class="h-4 w-4" />
				{:else}
					<ArrowUp class="h-4 w-4" />
				{/if}
			</button>
		</div>
	</form>
</div>

<style>
	.composer-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
	}

	.ghosts {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0 0.75rem;
	}

	.ghost {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	.ghost-name {
		flex-shrink: 0;
		font-weight: 500;
		color: var(--text-muted);
	}

	.ghost-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-style: italic;
		color: var(--text-faint);
	}

	.queue {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.queued {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		height: 2rem;
		padding: 0 0.375rem 0 0.625rem;
		border-radius: var(--radius-md);
		background: var(--fill-quiet);
	}

	.queued--editing {
		background: var(--bg-sunken);
		box-shadow: 0 0 0 1px var(--border-strong);
	}

	.queued-index {
		flex-shrink: 0;
		width: 1rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
		text-align: center;
		color: var(--text-faint);
	}

	.queued-text,
	.queued-input {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		text-align: left;
	}

	.queued-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: text;
	}

	.queued-input {
		color: var(--text-default);
	}

	.queued-input:focus-visible {
		outline: none;
	}

	.queued-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.queued-btn:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.cmp {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.875rem 0.75rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		background: var(--bg-raised);
		box-shadow: var(--elev-2);
		transition:
			border-color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.cmp:focus-within {
		border-color: var(--border-strong);
	}

	.cmp--plan {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		background: color-mix(in srgb, var(--accent-subtle) 50%, var(--bg-raised));
	}

	.cmp--comment {
		background: color-mix(in srgb, var(--fill-soft) 100%, var(--bg-raised));
	}

	.cmp--drop {
		outline: 1px dashed var(--accent);
		outline-offset: 2px;
	}

	.cmp-mode {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.cmp-files {
		padding: 0.25rem 0.25rem 0;
	}

	.cmp-input {
		width: 100%;
		min-height: 4.5rem;
		padding: 0 0.375rem;
		border: none;
		background: none;
		resize: none;
		font-size: var(--text-body);
		line-height: 1.55;
		color: var(--text-default);
	}

	.cmp-input:focus-visible {
		outline: none;
	}

	.cmp-input::placeholder {
		color: var(--text-faint);
	}

	.slash {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: calc(100% + 0.375rem);
		z-index: 2;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.25rem;
		border-radius: var(--radius-md);
		background: var(--bg-overlay);
		box-shadow: var(--elev-3);
	}

	.slash-item {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		min-width: 0;
		padding: 0.375rem 0.625rem;
		border: none;
		border-radius: var(--radius-sm);
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
		line-height: var(--lh-footnote);
		color: var(--text-default);
	}

	.slash-desc {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.bar-spacer {
		flex: 1;
		min-width: 0.5rem;
	}

	.file-input {
		display: none;
	}

	.model {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		max-width: 16rem;
		height: 1.75rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		color: var(--text-default);
		cursor: pointer;
		white-space: nowrap;
		transition: background-color var(--dur-fast);
	}

	.model:hover,
	.model--open {
		background: var(--bg-hover);
	}

	.model-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.model-effort {
		font-weight: 400;
		color: var(--text-muted);
	}

	.plan-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.5rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--accent-subtle);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
	}

	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-sm);
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

	.icon--stop {
		width: 1.625rem;
		height: 1.625rem;
		margin: 0 0.125rem;
		border-radius: var(--radius-pill);
		box-shadow: inset 0 0 0 1.5px var(--text-default);
		color: var(--text-default);
	}

	.icon--stop:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.menu-scroll {
		max-height: 22rem;
		overflow-y: auto;
	}

	.menu-group {
		padding: 0.5rem 0.75rem 0.125rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 500;
		color: var(--text-faint);
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
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast);
	}

	.send:disabled {
		background: var(--fill-medium);
		color: var(--text-faint);
		cursor: default;
	}
</style>
