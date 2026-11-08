<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Building2, ExternalLink, Unlink } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Input,
		List,
		ListRow,
		SectionCard,
		Skeleton,
		ToneTile
	} from '$lib/components/ui';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';

	interface LinkedOrganization {
		id: string;
		organization: { id: string; name: string; slug: string; avatarUrl: string | null };
		email: string;
		disabled: boolean;
		loginUrl: string | null;
	}

	let links = $state<LinkedOrganization[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let removing = $state<string | null>(null);
	let adding = $state(false);
	let slug = $state('');
	let broken = $state<Record<string, boolean>>({});

	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await apiFetch('/apiv1/auth/links');
			if (!res.ok) throw new Error("Couldn't load linked organizations");
			links = await res.json();
		} catch (err) {
			error = err instanceof Error ? err.message : "Couldn't load linked organizations";
		} finally {
			loading = false;
		}
	}

	async function remove(link: LinkedOrganization) {
		removing = link.id;
		try {
			const res = await apiFetch(`/apiv1/auth/links/${link.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error("Couldn't unlink that organization");
			links = links.filter((l) => l.id !== link.id);
			toasts.add({ title: `Unlinked ${link.organization.name}`, color: 'success' });
		} catch (err) {
			toasts.add({
				title: err instanceof Error ? err.message : "Couldn't unlink that organization",
				color: 'error'
			});
		} finally {
			removing = null;
		}
	}

	function open(link: LinkedOrganization) {
		if (link.loginUrl) window.location.href = link.loginUrl;
	}

	function startAdding() {
		const clean = slug.trim().replace(/^\/+|\/+$/g, '');
		if (!clean) return;
		void goto(`/${encodeURIComponent(clean)}/login`);
	}
</script>

<SectionCard
	title="Work organizations"
	description="Organizations you sign in to with their single sign-on. Linking one lists it here and in your switcher. The organization never sees or controls this account."
>
	{#snippet actions()}
		{#if !adding}
			<Button size="sm" onclick={() => (adding = true)}>Add work organization</Button>
		{/if}
	{/snippet}
	<div class="body">
		{#if adding}
			<form
				class="add"
				onsubmit={(e) => {
					e.preventDefault();
					startAdding();
				}}
			>
				<Field
					label="Organization"
					for="link-org-slug"
					hint="The name in its sign-in link, like acme in orchard.example/acme/login. You'll sign in with its single sign-on."
				>
					<Input id="link-org-slug" bind:value={slug} placeholder="acme" autocomplete="off" />
				</Field>
				<div class="add-actions">
					<Button size="sm" variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
					<Button size="sm" variant="primary" type="submit" disabled={!slug.trim()}>Continue</Button
					>
				</div>
			</form>
		{/if}
		{#if error}
			<Alert tone="error">{error}</Alert>
		{/if}
		{#if loading}
			<Skeleton height="2.5rem" />
		{:else if links.length === 0}
			{#if !error && !adding}
				<p class="quiet">No work organizations linked.</p>
			{/if}
		{:else}
			<List inset={false} label="Linked organizations">
				{#each links as link (link.id)}
					<ListRow flush presence title={link.organization.name} subtitle={link.email}>
						{#snippet leading()}
							<ToneTile size={32}>
								{#if link.organization.avatarUrl && !broken[link.id]}
									<RemoteImg
										src={link.organization.avatarUrl}
										style="width: 100%; height: 100%; object-fit: cover;"
										onerror={() => (broken[link.id] = true)}
									/>
								{:else}
									<Building2 size={16} />
								{/if}
							</ToneTile>
						{/snippet}
						{#snippet titleSuffix()}
							{#if link.disabled}<Badge>Access turned off</Badge>{:else}<Badge>SSO</Badge>{/if}
						{/snippet}
						{#snippet actions()}
							{#if !link.disabled && link.loginUrl}
								<Button size="sm" variant="ghost" icon={ExternalLink} onclick={() => open(link)}
									>Open</Button
								>
							{/if}
							<Button
								size="sm"
								variant="ghost"
								icon={Unlink}
								label={`Unlink ${link.organization.name}`}
								loading={removing === link.id}
								onclick={() => remove(link)}
							/>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</div>
</SectionCard>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.add {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.add-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.quiet {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
