<script lang="ts">
	import { Loader2, Plus, Trash2, ExternalLink, X } from 'lucide-svelte';
	import {
		Button,
		SectionCard,
		Field,
		Input,
		EmptyState,
		ToggleRow,
		Dropdown
	} from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import { apiFetch, toasts } from '$lib/stores';

	interface Component {
		id: string;
		kind: 'deployment' | 'database';
		resourceId: string;
		name: string;
	}
	interface StatusPage {
		id: string;
		slug: string;
		title: string;
		description: string | null;
		subdomain: string | null;
		host: string | null;
		isPublic: boolean;
		components: Component[];
	}
	interface Option {
		kind: 'deployment' | 'database';
		resourceId: string;
		name: string;
		project: string;
	}

	let {
		organization,
		isOwner = false,
		baseDomain = ''
	}: {
		organization: { id: string; name: string; slug: string } | null;
		isOwner?: boolean;
		baseDomain?: string;
	} = $props();

	let loading = $state(true);
	let pages = $state<StatusPage[]>([]);
	let options = $state<Option[]>([]);
	let saving = $state(false);
	let creating = $state(false);
	let editing = $state<StatusPage | null>(null);
	let title = $state('');
	let slug = $state('');
	let description = $state('');
	let subdomain = $state('');
	let isPublic = $state(true);
	let components = $state<Component[]>([]);
	let pick = $state('');

	const available = $derived(
		options.filter(
			(o) => !components.some((c) => c.kind === o.kind && c.resourceId === o.resourceId)
		)
	);
	const publicUrl = $derived((p: StatusPage) =>
		p.host ? `https://${p.host}` : `${location.origin}/status/${p.slug}`
	);

	async function json<T>(res: Response, fallback: string): Promise<T> {
		const body = await res.json().catch(() => ({}) as any);
		if (!res.ok) throw new Error(body?.message || fallback);
		return body as T;
	}

	async function load() {
		if (!organization) return;
		loading = true;
		try {
			const [p, o] = await Promise.all([
				apiFetch(`/apiv1/organizations/${organization.id}/status-pages`).then((r) =>
					json<StatusPage[]>(r, 'Could not load status pages')
				),
				apiFetch(`/apiv1/organizations/${organization.id}/status-pages/options`).then((r) =>
					json<Option[]>(r, 'Could not load apps')
				)
			]);
			pages = p;
			options = o;
		} catch (e) {
			toasts.add({
				title: 'Could not load status pages',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (organization?.id) void load();
	});

	function startCreate() {
		editing = null;
		title = `${organization?.name ?? ''} status`.trim();
		slug = organization?.slug ?? '';
		description = '';
		subdomain = '';
		isPublic = true;
		components = [];
		pick = '';
		creating = true;
	}

	function startEdit(p: StatusPage) {
		editing = p;
		title = p.title;
		slug = p.slug;
		description = p.description ?? '';
		subdomain = p.subdomain ?? '';
		isPublic = p.isPublic;
		components = [...p.components];
		pick = '';
		creating = true;
	}

	function cancel() {
		creating = false;
		editing = null;
	}

	function addPicked() {
		const o = available.find((x) => `${x.kind}:${x.resourceId}` === pick);
		if (!o) return;
		components = [
			...components,
			{ id: `${o.kind}:${o.resourceId}`, kind: o.kind, resourceId: o.resourceId, name: o.name }
		];
		pick = '';
	}

	function removeComponent(id: string) {
		components = components.filter((c) => c.id !== id);
	}

	function move(id: string, dir: -1 | 1) {
		const i = components.findIndex((c) => c.id === id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= components.length) return;
		const next = [...components];
		[next[i], next[j]] = [next[j], next[i]];
		components = next;
	}

	async function save() {
		if (!organization || saving) return;
		saving = true;
		try {
			const body = {
				title: title.trim(),
				slug: slug.trim(),
				description: description.trim() || null,
				subdomain: baseDomain ? subdomain.trim() || null : undefined,
				isPublic,
				components: components.map((c) => ({
					kind: c.kind,
					resourceId: c.resourceId,
					name: c.name
				}))
			};
			const res = await apiFetch(
				editing
					? `/apiv1/organizations/${organization.id}/status-pages/${editing.id}`
					: `/apiv1/organizations/${organization.id}/status-pages`,
				{
					method: editing ? 'PATCH' : 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				}
			);
			await json(res, 'Could not save the status page');
			creating = false;
			editing = null;
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not save the status page',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove(p: StatusPage) {
		if (!organization) return;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/status-pages/${p.id}`, {
				method: 'DELETE'
			});
			await json(res, 'Could not delete the status page');
			pages = pages.filter((x) => x.id !== p.id);
		} catch (e) {
			toasts.add({
				title: 'Could not delete the status page',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}
</script>

<SectionCard title="Status pages">
	{#snippet actions()}
		{#if isOwner && !creating}
			<Button variant="secondary" size="sm" onclick={startCreate} disabled={loading}>
				<Plus class="h-3.5 w-3.5" />
				<span>New page</span>
			</Button>
		{/if}
	{/snippet}

	{#if creating}
		<form
			class="st-form"
			transition:slide={{ duration: 160 }}
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div class="st-grid">
				<Field label="Title"><Input bind:value={title} placeholder="Acme status" /></Field>
				<Field label="Slug" hint={`/status/${slug || 'acme'}`}>
					<Input bind:value={slug} placeholder="acme" />
				</Field>
				{#if baseDomain}
					<Field label="Host" hint={subdomain ? `${subdomain}.${baseDomain}` : 'Optional'}>
						<Input bind:value={subdomain} placeholder="acme-status" />
					</Field>
				{/if}
			</div>
			<Field label="Description"><Input bind:value={description} placeholder="Optional" /></Field>

			<div class="st-components">
				{#each components as c, i (c.id)}
					<div class="st-comp" {@attach motionStagger({ index: i, from: { y: 4 } })}>
						<input class="st-comp-name" bind:value={c.name} aria-label="Component name" />
						<span class="st-comp-kind">{c.kind === 'database' ? 'database' : 'app'}</span>
						<button
							type="button"
							class="st-icon"
							onclick={() => move(c.id, -1)}
							aria-label="Move up"
							disabled={i === 0}>↑</button
						>
						<button
							type="button"
							class="st-icon"
							onclick={() => move(c.id, 1)}
							aria-label="Move down"
							disabled={i === components.length - 1}>↓</button
						>
						<button
							type="button"
							class="st-icon"
							onclick={() => removeComponent(c.id)}
							aria-label="Remove"><X class="h-3.5 w-3.5" /></button
						>
					</div>
				{/each}
				{#if available.length}
					<div class="st-add">
						<Dropdown
							bind:value={pick}
							placeholder="Add an app or database"
							options={available.map((o) => ({
								value: `${o.kind}:${o.resourceId}`,
								label: `${o.name} · ${o.project}`
							}))}
						/>
						<Button variant="secondary" size="sm" onclick={addPicked} disabled={!pick}>Add</Button>
					</div>
				{/if}
			</div>

			<ToggleRow label="Public" checked={isPublic} onchange={(v) => (isPublic = v)} />

			<div class="st-actions">
				<Button variant="ghost" size="sm" onclick={cancel} disabled={saving}>Cancel</Button>
				<Button
					variant="primary"
					size="sm"
					type="submit"
					loading={saving}
					disabled={saving || !title.trim() || !slug.trim()}
				>
					{editing ? 'Save' : 'Create'}
				</Button>
			</div>
		</form>
	{/if}

	{#if loading}
		<div class="st-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if pages.length === 0 && !creating}
		<EmptyState
			title="No status pages"
			description={isOwner ? 'Publish a page anyone can check.' : ''}
		/>
	{:else if pages.length}
		<ul class="st-list">
			{#each pages as p, i (p.id)}
				<li class="st-row" {@attach motionStagger({ index: i, from: { y: 4 } })}>
					<div class="st-row-main">
						<span class="st-row-title">{p.title}</span>
						<a class="st-row-url" href={publicUrl(p)} target="_blank" rel="noopener noreferrer">
							{p.host ?? `/status/${p.slug}`}
							<ExternalLink class="h-3 w-3" />
						</a>
					</div>
					<span class="st-row-meta">
						{p.components.length} component{p.components.length === 1 ? '' : 's'}{p.isPublic
							? ''
							: ' · private'}
					</span>
					{#if isOwner}
						<div class="st-row-actions">
							<Button variant="ghost" size="sm" onclick={() => startEdit(p)}>Edit</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => remove(p)}
								aria-label="Delete status page"
							>
								<Trash2 class="h-3.5 w-3.5" />
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>

<style>
	.st-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3);
		margin-bottom: var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.st-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}
	.st-components {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.st-comp {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
	}
	.st-comp-name {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		outline: none;
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
		padding: 0.25rem 0.25rem;
		border-radius: var(--radius-xs);
	}
	.st-comp-name:focus {
		background: var(--bg-sunken);
	}
	.st-comp-kind {
		font-size: var(--text-micro);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.st-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		background: none;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		cursor: pointer;
		font-size: var(--text-caption);
	}
	.st-icon:hover:not(:disabled) {
		background: var(--fill-soft);
		color: var(--text-default);
	}
	.st-icon:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.st-add {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.st-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.st-loading {
		display: flex;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-faint);
	}
	.st-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.st-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.625rem 0.5rem;
		border-top: 1px solid var(--rule);
	}
	.st-row:first-child {
		border-top: none;
	}
	.st-row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.st-row-title {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
	}
	.st-row-url {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-muted);
		text-decoration: none;
	}
	.st-row-url:hover {
		color: var(--text-default);
	}
	.st-row-meta {
		font-size: var(--text-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.st-row-actions {
		display: flex;
		gap: 0.125rem;
	}
	@media (max-width: 760px) {
		.st-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
