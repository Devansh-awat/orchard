<script lang="ts">
	import { MessageSquareText, Send, Trash2 } from 'lucide-svelte';
	import { VIEWER_ONLY, type MachineWorkspace } from './workspace.svelte';
	import type { GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession } = $props();

	const items = $derived(ws.comments.items.filter((c) => c.path.includes(session.worktreePath)));

	const byFile = $derived.by(() => {
		const map = new Map<string, typeof items>();
		for (const c of items) {
			const list = map.get(c.path) ?? [];
			list.push(c);
			map.set(c.path, list);
		}
		for (const list of map.values()) list.sort((a, b) => a.line - b.line);
		return [...map.entries()];
	});

	function send() {
		const prompt = ws.comments.toPrompt({ root: session.worktreePath });
		if (!prompt.trim()) return;
		void ws.queuePrompt(prompt);
		ws.comments.clear();
		ws.host.openTab(null);
	}
</script>

<div class="review gh-scroll">
	{#if byFile.length === 0}
		<div class="empty">
			<MessageSquareText size={18} strokeWidth={1.5} />
			<p>
				Open a changed file and click a line number to leave a comment. Collect a few, then send
				them to the agent as one review.
			</p>
		</div>
	{:else}
		{#each byFile as [path, list] (path)}
			<button type="button" class="file gh-mono" onclick={() => ws.openDiff(path)}>
				{ws.resolve(path).rel}
			</button>
			{#each list as c (c.id)}
				<div class="comment">
					<span class="line gh-num">L{c.line}</span>
					<p class="body">{c.body}</p>
					<button
						type="button"
						class="gh-ibtn"
						aria-label="Remove comment"
						onclick={() => ws.comments.remove(c.id)}
					>
						<Trash2 size={13} strokeWidth={1.75} />
					</button>
				</div>
			{/each}
		{/each}
	{/if}
</div>
{#if byFile.length > 0}
	<div class="foot">
		<span class="count">{items.length} comment{items.length === 1 ? '' : 's'}</span>
		<span class="grow"></span>
		<button
			type="button"
			class="gh-btn gh-btn--primary"
			disabled={!ws.canEdit}
			title={ws.canEdit ? undefined : VIEWER_ONLY}
			onclick={send}
		>
			<Send size={13} /> Send review to agent
		</button>
	</div>
{/if}

<style>
	.review {
		flex: 1;
		min-height: 0;
		padding: 0.5rem 0.5rem 1rem;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 2rem 1.5rem;
		text-align: center;
		color: var(--gh-faint);
	}

	.empty p {
		margin: 0;
		max-width: 22rem;
		font-size: var(--gh-caption);
	}

	.file {
		display: block;
		width: 100%;
		margin-top: 0.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-xs);
		text-align: left;
		font-size: var(--gh-caption);
		color: var(--gh-muted);
	}

	.file:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.comment {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.375rem 0.25rem 0.375rem 0.5rem;
	}

	.line {
		flex: none;
		width: 2.5rem;
		padding-top: 0.125rem;
		color: var(--gh-faint);
	}

	.body {
		flex: 1;
		min-width: 0;
		margin: 0;
		white-space: pre-wrap;
		color: var(--gh-text);
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		padding: 0.5rem 0.75rem;
		border-top: 1px solid var(--gh-line-soft);
	}

	.count {
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.grow {
		flex: 1;
	}
</style>
