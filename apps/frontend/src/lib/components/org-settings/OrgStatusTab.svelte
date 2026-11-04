<script lang="ts">
	import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Plus, Trash2 } from 'lucide-svelte';
	import {
		Badge,
		Button,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		List,
		ListRow,
		Modal,
		RowList,
		SectionCard,
		SettingsList,
		Skeleton,
		Stack,
		ToggleRow,
		ToneTile
	} from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

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
	const formId = $props.id();

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
					json<StatusPage[]>(r, "Couldn't load status pages")
				),
				apiFetch(`/apiv1/organizations/${organization.id}/status-pages/options`).then((r) =>
					json<Option[]>(r, "Couldn't load apps")
				)
			]);
			pages = p;
			options = o;
		} catch (e) {
			toasts.add({
				title: "Couldn't load status pages",
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

	function addPicked(value: string) {
		const o = available.find((x) => `${x.kind}:${x.resourceId}` === value);
		if (!o) return;
		components = [
			...components,
			{ id: `${o.kind}:${o.resourceId}`, kind: o.kind, resourceId: o.resourceId, name: o.name }
		];
		pick = '';
	}

	function removeComponent(index: number) {
		components = components.filter((_, i) => i !== index);
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
			await json(res, "Couldn't save the status page");
			creating = false;
			editing = null;
			await load();
		} catch (e) {
			toasts.add({
				title: "Couldn't save the status page",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	let removeTarget = $state<StatusPage | null>(null);

	async function remove(p: StatusPage) {
		if (!organization) return;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/status-pages/${p.id}`, {
				method: 'DELETE'
			});
			await json(res, "Couldn't delete the status page");
			pages = pages.filter((x) => x.id !== p.id);
		} catch (e) {
			toasts.add({
				title: "Couldn't delete the status page",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}
</script>

<SectionCard title="Status pages">
	{#snippet actions()}
		{#if isOwner}
			<Button size="sm" icon={Plus} onclick={startCreate} disabled={loading}>New page</Button>
		{/if}
	{/snippet}

	{#if loading}
		<Skeleton height="2.5rem" />
	{:else if pages.length === 0}
		<p class="quiet">
			{isOwner ? 'None yet. A status page shows anyone whether your apps are up.' : 'None yet.'}
		</p>
	{:else}
		<List inset={false} label="Status pages">
			{#each pages as p (p.id)}
				<ListRow flush presence title={p.title}>
					{#snippet leading()}<ToneTile size={32}><Activity size={16} /></ToneTile>{/snippet}
					{#snippet titleSuffix()}
						{#if !p.isPublic}<Badge>Private</Badge>{/if}
					{/snippet}
					{#snippet subtitle()}
						<a
							class="url"
							href={publicUrl(p)}
							target="_blank"
							rel="noopener noreferrer"
							title={p.host ?? `/status/${p.slug}`}
							><span class="url-text">{p.host ?? `/status/${p.slug}`}</span><ArrowUpRight
								size={12}
								aria-hidden="true"
							/></a
						>
						<span>
							· {p.components.length}
							{p.components.length === 1 ? 'component' : 'components'}</span
						>
					{/snippet}
					{#snippet actions()}
						{#if isOwner}
							<Button size="sm" onclick={() => startEdit(p)}>Edit</Button>
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Delete {p.title}"
								onclick={() => (removeTarget = p)}
							/>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</SectionCard>

{#if isOwner}
	<Modal bind:open={creating} size="lg" title={editing ? 'Edit status page' : 'New status page'}>
		<form
			id={formId}
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<Stack>
				<FieldGrid>
					<Field label="Title" for="{formId}-title">
						<Input id="{formId}-title" size="lg" bind:value={title} placeholder="Acme status" />
					</Field>
					<Field label="Slug" for="{formId}-slug" hint={`/status/${slug || 'acme'}`}>
						<Input
							id="{formId}-slug"
							size="lg"
							mono
							bind:value={slug}
							placeholder="acme"
							autocomplete="off"
							spellcheck="false"
						/>
					</Field>
				</FieldGrid>
				{#if baseDomain}
					<Field label="Host" for="{formId}-host" hint="Optional">
						<Input
							id="{formId}-host"
							size="lg"
							mono
							bind:value={subdomain}
							placeholder="acme-status"
							suffix={`.${baseDomain}`}
							autocomplete="off"
							spellcheck="false"
						/>
					</Field>
				{/if}
				<Field label="Description" for="{formId}-description">
					<Input
						id="{formId}-description"
						size="lg"
						bind:value={description}
						placeholder="Optional"
					/>
				</Field>
				<Field label="Components">
					<Stack gap="sm">
						{#if components.length}
							<RowList
								items={components}
								key={(c) => c.id}
								label="Components"
								columns={[
									{ label: 'Name' },
									{ label: 'Kind', width: '5rem' },
									{ label: 'Order', width: '3.75rem' }
								]}
								onremove={removeComponent}
								removeLabel={(c) => `Remove ${c.name}`}
							>
								{#snippet row(c, i)}
									<Input bind:value={c.name} aria-label="Component name" />
									<span class="kind">{c.kind === 'database' ? 'Database' : 'App'}</span>
									<span class="order">
										<Button
											variant="ghost"
											size="sm"
											icon={ArrowUp}
											label="Move {c.name} up"
											disabled={i === 0}
											onclick={() => move(c.id, -1)}
										/>
										<Button
											variant="ghost"
											size="sm"
											icon={ArrowDown}
											label="Move {c.name} down"
											disabled={i === components.length - 1}
											onclick={() => move(c.id, 1)}
										/>
									</span>
								{/snippet}
							</RowList>
						{/if}
						{#if available.length}
							<Dropdown
								bind:value={pick}
								placeholder="Add an app or database"
								options={available.map((o) => ({
									value: `${o.kind}:${o.resourceId}`,
									label: o.name,
									description: o.project
								}))}
								onchange={addPicked}
							/>
						{/if}
					</Stack>
				</Field>
				<SettingsList>
					<ToggleRow label="Public" bind:checked={isPublic} />
				</SettingsList>
			</Stack>
		</form>

		{#snippet footer()}
			<Button variant="ghost" shape="capsule" onclick={cancel} disabled={saving}>Cancel</Button>
			<Button
				type="submit"
				form={formId}
				variant="primary"
				shape="capsule"
				loading={saving}
				disabled={saving || !title.trim() || !slug.trim()}
			>
				{editing ? 'Save' : 'Create page'}
			</Button>
		{/snippet}
	</Modal>
{/if}

<ConfirmModal
	bind:open={() => removeTarget !== null, (v) => !v && (removeTarget = null)}
	title={`Delete ${removeTarget?.title ?? 'this status page'}?`}
	description="The page stops loading for everyone with the link. Its components and history are deleted."
	confirmLabel="Delete page"
	onconfirm={() => {
		if (removeTarget) remove(removeTarget);
	}}
	oncancel={() => (removeTarget = null)}
/>

<style>
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.url {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}
	.url :global(svg) {
		flex-shrink: 0;
	}
	.url-text {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
	.url:hover {
		color: var(--text-default);
	}
	.kind {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.order {
		display: inline-flex;
		align-items: center;
	}
</style>
