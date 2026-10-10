<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Eye, EyeOff, Trash2 } from 'lucide-svelte';
	import { Button, Skeleton } from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatBytes } from '../machine-usage';
	import Block from './Block.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';
	import { errorText } from './sections';

	type Kind = 'instructions' | 'agent' | 'command' | 'skill' | 'mcp';
	interface Item {
		id: string;
		kind: Kind;
		name: string;
		enabled: boolean;
		sizeBytes: number;
		secretKeys: string[];
	}

	const GROUPS: { kind: Kind; title: string }[] = [
		{ kind: 'agent', title: 'Subagents' },
		{ kind: 'command', title: 'Slash commands' },
		{ kind: 'skill', title: 'Skills' },
		{ kind: 'mcp', title: 'MCP servers' }
	];
	const IMPORT = 'orchard claude import';

	let items = $state<Item[] | null>(null);
	let failed = $state<string | null>(null);
	let instructions = $state('');
	let saved = $state('');
	let saving = $state(false);
	let shown = $state(false);
	let revealing = $state(false);
	let busy = $state<string | null>(null);

	const instructionsItem = $derived(items?.find((item) => item.kind === 'instructions') ?? null);
	const dirty = $derived(instructions !== saved);

	async function json<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await apiFetch(path, init);
		const body = await res.json().catch(() => null);
		if (!res.ok) throw new Error(body?.message ?? 'Request failed');
		return body as T;
	}

	async function load() {
		failed = null;
		try {
			const list = await json<{ items: Item[] }>('/apiv1/me/context');
			items = list.items;
		} catch (e) {
			failed = errorText(e) ?? 'Could not load your context';
		}
	}

	async function reveal() {
		if (revealing) return;
		const own = instructionsItem;
		if (!own) {
			instructions = saved = '';
			shown = true;
			return;
		}
		revealing = true;
		try {
			const detail = await json<{ files?: Record<string, string> }>(`/apiv1/me/context/${own.id}`);
			instructions = saved = detail.files?.['CLAUDE.md'] ?? '';
			shown = true;
		} catch (e) {
			toasts.add({ title: 'Could not open CLAUDE.md', description: errorText(e), color: 'error' });
		} finally {
			revealing = false;
		}
	}

	function conceal() {
		shown = false;
		instructions = saved = '';
	}

	onMount(() => {
		void load();
	});

	async function saveInstructions() {
		if (saving || !dirty) return;
		saving = true;
		try {
			if (!instructions.trim() && instructionsItem) {
				await json(`/apiv1/me/context/${instructionsItem.id}`, { method: 'DELETE' });
			} else {
				await json('/apiv1/me/context', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						kind: 'instructions',
						name: 'CLAUDE.md',
						files: { 'CLAUDE.md': instructions }
					})
				});
			}
			saved = instructions;
			await load();
		} catch (e) {
			toasts.add({ title: 'Could not save CLAUDE.md', description: errorText(e), color: 'error' });
		} finally {
			saving = false;
		}
	}

	async function toggle(item: Item, enabled: boolean) {
		const previous = items;
		items = items?.map((it) => (it.id === item.id ? { ...it, enabled } : it)) ?? null;
		try {
			await json(`/apiv1/me/context/${item.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
		} catch (e) {
			items = previous;
			toasts.add({
				title: `Could not update ${item.name}`,
				description: errorText(e),
				color: 'error'
			});
		}
	}

	async function remove(item: Item) {
		busy = item.id;
		try {
			await json(`/apiv1/me/context/${item.id}`, { method: 'DELETE' });
			items = items?.filter((it) => it.id !== item.id) ?? null;
		} catch (e) {
			toasts.add({
				title: `Could not remove ${item.name}`,
				description: errorText(e),
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	function copyImport() {
		void navigator.clipboard.writeText(IMPORT);
		toasts.add({ title: 'Copied', color: 'success' });
	}

	function hint(item: Item): string | null {
		if (item.kind === 'mcp' && item.secretKeys.length > 0) {
			return `Uses ${item.secretKeys.join(', ')}`;
		}
		return null;
	}
</script>

<Block>
	<p class="lede">
		Your instructions and Claude Code setup follow you onto every machine you own. They are
		encrypted at rest and never land on someone else's machine.
	</p>
</Block>

{#if failed}
	<Block>
		<p class="note">
			{failed}
			<button type="button" class="retry" onclick={load}>Try again</button>
		</p>
	</Block>
{:else if items === null}
	<Block>
		<Skeleton height="8rem" />
		<Skeleton height="2.5rem" width="60%" />
	</Block>
{:else}
	<Block>
		<Card title="CLAUDE.md">
			{#if shown}
				<div class="editor ph-no-capture">
					<textarea
						class="code gh-mono"
						spellcheck="false"
						autocomplete="off"
						placeholder="How you like to work: conventions, tools, things the agent should always or never do."
						aria-label="CLAUDE.md"
						bind:value={instructions}></textarea>
					<div class="actions">
						<span class="meta">Every agent on your machines reads this first.</span>
						<span class="buttons">
							<Button
								variant="secondary"
								size="sm"
								disabled={dirty || saving}
								title={dirty ? 'Save or undo your changes first' : undefined}
								onclick={conceal}
							>
								<EyeOff size={14} strokeWidth={1.75} /> Hide
							</Button>
							<Button
								variant="primary"
								size="sm"
								loading={saving}
								disabled={!dirty}
								onclick={saveInstructions}>Save</Button
							>
						</span>
					</div>
				</div>
			{:else}
				<Row
					title={instructionsItem ? 'Hidden' : 'Not written yet'}
					description={instructionsItem
						? `${formatBytes(instructionsItem.sizeBytes)}, private to you. Every agent on your machines reads it first.`
						: 'Every agent on your machines reads this first.'}
				>
					{#snippet control()}
						<Button variant="secondary" size="sm" loading={revealing} onclick={reveal}>
							<Eye size={14} strokeWidth={1.75} />
							{instructionsItem ? 'Show' : 'Write'}
						</Button>
					{/snippet}
				</Row>
			{/if}
		</Card>
	</Block>

	<Block>
		<Card title="Bring your Claude Code setup">
			<Row
				title={IMPORT}
				description="Imports CLAUDE.md, subagents, slash commands, skills and MCP servers. You pick what to send."
			>
				{#snippet control()}
					<Button variant="secondary" size="sm" onclick={copyImport}>
						<Copy size={14} strokeWidth={1.75} /> Copy
					</Button>
				{/snippet}
			</Row>
		</Card>
	</Block>

	{#each GROUPS as group (group.kind)}
		{@const list = items.filter((item) => item.kind === group.kind)}
		{#if list.length > 0}
			<Block>
				<Card title={group.title}>
					{#each list as item (item.id)}
						<div class="item">
							<div class="item-row">
								<Row
									title={item.name}
									description={hint(item)}
									checked={item.enabled}
									ontoggle={(next) => toggle(item, next)}
								/>
							</div>
							<button
								type="button"
								class="gh-ibtn remove"
								aria-label="Remove {item.name}"
								title="Remove"
								disabled={busy === item.id}
								onclick={() => remove(item)}
							>
								<Trash2 size={16} strokeWidth={1.75} />
							</button>
						</div>
					{/each}
				</Card>
			</Block>
		{/if}
	{/each}
{/if}

<style>
	.lede,
	.note,
	.meta {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.retry {
		color: var(--gh-text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
	}

	.code {
		width: 100%;
		min-height: 12rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
		color: var(--gh-text);
		font-size: var(--gh-code, 0.8125rem);
		line-height: 1.25rem;
		resize: vertical;
	}

	.code:focus {
		outline: none;
		border-color: var(--border-strong);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding-right: 0.5rem;
	}

	.item + .item {
		border-top: 1px solid var(--border-default);
	}

	.item-row {
		flex: 1;
		min-width: 0;
	}

	.remove:hover:not(:disabled) {
		color: var(--status-error);
	}
</style>
