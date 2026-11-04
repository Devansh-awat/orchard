<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Trash2, UserPlus, UserRound } from 'lucide-svelte';
	import ToneTile from '$lib/components/ui/ToneTile.svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Button,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SecretString,
		SectionCard,
		SegmentedControl,
		Skeleton
	} from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { errorMessage } from './recovery';
	import type { DatabaseDetail } from './types';

	type Access = 'read' | 'write';
	interface DbUser {
		name: string;
		access: Access;
		present: boolean;
	}
	interface Created {
		name: string;
		access: Access;
		password: string;
		connectionString: string;
	}

	let { database }: { database: DatabaseDetail } = $props();

	const uid = $props.id();
	const NAME = /^[a-z][a-z0-9_]{1,40}$/;

	let users = $state<DbUser[] | null>(null);
	let addOpen = $state(false);
	let name = $state('');
	let access = $state<Access>('read');
	let adding = $state(false);
	let addError = $state<string | null>(null);
	let created = $state<Created | null>(null);
	let removeTarget = $state<DbUser | null>(null);
	let confirmRemove = $state(false);
	let removing = $state<string | null>(null);

	const nameProblem = $derived(
		name && !NAME.test(name)
			? 'Lowercase letters, digits and underscores, starting with a letter'
			: null
	);

	const ACCESS = [
		{ value: 'read', label: 'Read only' },
		{ value: 'write', label: 'Read and write' }
	];

	async function load() {
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/users`);
			users = res.ok ? await res.json() : [];
		} catch {
			users = [];
		}
	}

	function openAdd() {
		name = '';
		access = 'read';
		addError = null;
		created = null;
		addOpen = true;
	}

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => el.focus());
	}

	async function add() {
		if (!name || nameProblem || adding) return;
		adding = true;
		addError = null;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/users`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, access })
			});
			if (!res.ok) throw new Error(await errorMessage(res, "Couldn't add the user"));
			created = (await res.json()) as Created;
			await load();
		} catch (e) {
			addError = e instanceof Error ? e.message : "Couldn't add the user";
		} finally {
			adding = false;
		}
	}

	async function remove(user: DbUser) {
		removing = user.name;
		try {
			const res = await apiFetch(
				`/apiv1/databases/${database.id}/users/${encodeURIComponent(user.name)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error(await errorMessage(res, "Couldn't remove the user"));
			users = (users ?? []).filter((u) => u.name !== user.name);
			toasts.add({ title: `${user.name} removed`, color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't remove the user",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			removing = null;
		}
	}

	const mask = (s: string, secret: string) => s.replace(secret, '•'.repeat(12));

	onMount(load);
</script>

<SectionCard title="Users">
	{#snippet actions()}
		<Button size="sm" icon={UserPlus} disabled={database.mode !== 'cnpg'} onclick={openAdd}
			>Add user</Button
		>
	{/snippet}
	{#if users === null}
		<div class="placeholder">
			<Skeleton height="2.5rem" />
			<Skeleton height="2.5rem" />
		</div>
	{:else}
		<List inset={false} label="Database users">
			<ListRow flush pinned title={database.dbUser} subtitle="Owner · used by apps in this project">
				{#snippet leading()}<ToneTile size={32}><UserRound size={16} /></ToneTile>{/snippet}
			</ListRow>
			{#each users as user (user.name)}
				<ListRow
					flush
					presence
					title={user.name}
					subtitle={user.access === 'read' ? 'Read only' : 'Read and write'}
				>
					{#snippet leading()}<ToneTile size={32}><UserRound size={16} /></ToneTile>{/snippet}
					{#snippet actions()}
						<Button
							size="sm"
							variant="ghost"
							icon={Trash2}
							label={`Remove ${user.name}`}
							loading={removing === user.name}
							onclick={() => {
								removeTarget = user;
								confirmRemove = true;
							}}
						/>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</SectionCard>

<Modal
	bind:open={addOpen}
	size={created ? 'md' : 'sm'}
	closable={false}
	dismissable
	labelledby="{uid}-title"
>
	{#if created}
		<div class="form">
			<ModalIntro
				id="{uid}-title"
				icon={UserPlus}
				tone="success"
				solid
				title={`${created.name} can log in`}
				description="Copy the password now. It isn't shown again."
			/>
			<Field label="Password">
				<SecretString
					masked={'•'.repeat(24)}
					resolve={async () => created?.password ?? null}
					label="Password"
				/>
			</Field>
			<Field label="Connection string">
				<SecretString
					masked={mask(created.connectionString, created.password)}
					resolve={async () => created?.connectionString ?? null}
					label="Connection string"
				/>
			</Field>
		</div>
	{:else}
		<form
			class="form"
			onsubmit={(e) => {
				e.preventDefault();
				add();
			}}
		>
			<ModalIntro id="{uid}-title" icon={UserPlus} tone="accent" title="Add a user" />
			<Field label="Name" for="{uid}-name" error={nameProblem ?? addError}>
				<Input
					id="{uid}-name"
					mono
					bind:value={name}
					placeholder="metabase"
					autocomplete="off"
					spellcheck={false}
					{@attach focusOnOpen}
				/>
			</Field>
			<Field label="Access">
				<SegmentedControl label="Access" options={ACCESS} bind:value={access} grow />
			</Field>
		</form>
	{/if}
	{#snippet footer()}
		{#if created}
			<Button variant="primary" onclick={() => (addOpen = false)}>Done</Button>
		{:else}
			<Button variant="ghost" disabled={adding} onclick={() => (addOpen = false)}>Cancel</Button>
			<Button variant="primary" loading={adding} disabled={!name || !!nameProblem} onclick={add}
				>Add user</Button
			>
		{/if}
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={confirmRemove}
	title={`Remove ${removeTarget?.name ?? 'this user'}?`}
	description="Anything logged in as this user is disconnected and can't log in again."
	confirmLabel="Remove user"
	onconfirm={() => {
		if (removeTarget) remove(removeTarget);
	}}
	oncancel={() => (removeTarget = null)}
/>

<style>
	.form,
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		gap: 0.5rem;
	}
</style>
