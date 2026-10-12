<script lang="ts">
	import {
		Check,
		ChevronRight,
		FilePen,
		FileText,
		FolderOpen,
		Globe,
		Search,
		SquareTerminal,
		Wrench
	} from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { modKey } from '$lib/components/greenhouse/format';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import { describePermission, type PermissionIcon, type PermissionRequest } from '../pending';
	import type { ChatSessionStore } from '../session-store.svelte';
	import RequestCard from './RequestCard.svelte';

	let {
		store,
		request,
		auto = false,
		directory = null,
		readonly = false,
		focusOnMount = false
	}: {
		store: ChatSessionStore;
		request: PermissionRequest;
		auto?: boolean;
		directory?: string | null;
		readonly?: boolean;
		focusOnMount?: boolean;
	} = $props();

	const ICONS: Record<PermissionIcon, typeof Wrench> = {
		command: SquareTerminal,
		edit: FilePen,
		fetch: Globe,
		folder: FolderOpen,
		read: FileText,
		search: Search,
		tool: Wrench
	};

	const mod = modKey().trim();
	const view = $derived(describePermission(request, directory));
	const Icon = $derived(ICONS[view.icon]);
	const covers = $derived(`${view.covers ?? 'Allow without asking again'} (${mod}↵)`);

	let denying = $state(false);
	let reason = $state('');
	let showDiff = $state(true);
	let reasonEl = $state<HTMLInputElement | undefined>(undefined);
	let cardEl = $state<HTMLElement | undefined>(undefined);

	function reply(kind: 'once' | 'always' | 'reject') {
		if (readonly || auto) return;
		void store.replyPermission(request.id, kind, kind === 'reject' ? reason : undefined);
	}

	function startDeny() {
		denying = true;
		requestAnimationFrame(() => reasonEl?.focus());
	}

	function onkey(e: KeyboardEvent) {
		if (readonly || auto || e.isComposing) return;
		const onCard = e.target === e.currentTarget;
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			reply('always');
		} else if (e.key === 'Enter' && onCard && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			reply('once');
		} else if (e.key === 'Escape' && !denying) {
			e.preventDefault();
			e.stopPropagation();
			startDeny();
		}
	}

	function onReasonKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			e.stopPropagation();
			reply('reject');
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			denying = false;
			reason = '';
			cardEl?.focus({ preventScroll: true });
		}
	}
</script>

<RequestCard
	bind:el={cardEl}
	label={view.title}
	{readonly}
	focusOnMount={focusOnMount && !auto}
	{onkey}
>
	{#snippet header()}
		<span class="perm-glyph" aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>
		<span class="perm-title">{view.title}</span>
		{#if view.diff}
			<button
				type="button"
				class="perm-toggle"
				aria-expanded={showDiff}
				title={showDiff ? 'Hide the change' : 'Show the change'}
				onclick={() => (showDiff = !showDiff)}
			>
				<span class="perm-chev" {@attach springRotate(() => showDiff, { rest: 0, on: 90 })}>
					<ChevronRight size={16} strokeWidth={1.75} />
				</span>
			</button>
		{/if}
	{/snippet}
	{#if view.detail}
		<pre class="perm-code" data-align="inset">{view.detail}</pre>
	{/if}
	{#if view.diff && showDiff}
		<pre
			class="perm-code perm-diff"
			data-align="inset"
			transition:slide>{#each view.diff as line, li (li)}<span
					class="perm-line"
					class:diff-add={line.sign === '+'}
					class:diff-del={line.sign === '−'}>{line.sign} {line.text}</span
				>{/each}</pre>
	{/if}
	{#snippet actions()}
		{#if auto}
			<span class="perm-auto">
				<span class="perm-ok"><Check size={16} strokeWidth={1.75} /></span>
				Allowed automatically
			</span>
		{:else if denying}
			<div class="perm-deny" transition:slide>
				<input
					bind:this={reasonEl}
					bind:value={reason}
					class="perm-reason"
					placeholder="Tell the agent what to do instead"
					aria-label="Tell the agent what to do instead"
					onkeydown={onReasonKey}
				/>
				<Button size="sm" title="Deny (↵)" onclick={() => reply('reject')}>Deny</Button>
			</div>
		{:else}
			<Button size="sm" variant="primary" title="Allow once (↵)" onclick={() => reply('once')}>
				Allow
			</Button>
			<Button size="sm" title={covers} onclick={() => reply('always')}>Always allow</Button>
			<Button size="sm" variant="ghost" title="Deny (Esc)" onclick={startDeny}>Deny</Button>
		{/if}
	{/snippet}
</RequestCard>

<style>
	.perm-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.perm-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.perm-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		margin: calc(-1 * var(--space-1)) 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.perm-toggle:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.perm-chev {
		display: inline-flex;
	}

	.perm-code {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		max-height: 10rem;
		overflow: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: var(--gh-code-size, 13px);
		line-height: round(up, calc(var(--gh-code-size, 13px) * 1.5), 0.25rem);
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.perm-diff {
		max-height: 12rem;
		white-space: pre;
		overflow-wrap: normal;
		color: var(--text-muted);
	}

	.perm-line {
		display: block;
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}

	.perm-auto {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.perm-ok {
		display: inline-flex;
		color: var(--status-success);
	}

	.perm-deny {
		display: flex;
		flex: 1;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.perm-reason {
		flex: 1;
		min-width: 0;
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font: inherit;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.perm-reason::placeholder {
		color: var(--text-faint);
	}

	.perm-reason:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
