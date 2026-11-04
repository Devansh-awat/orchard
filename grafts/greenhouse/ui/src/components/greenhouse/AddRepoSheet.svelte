<script lang="ts">
	import { Button, Field, Input, Modal } from '@orchardlabs/graft-ui';
	import SegmentedControl from '@orchardlabs/graft-ui/components/ui/SegmentedControl.svelte';
	import GitHubRepoPicker, {
		type PickedRepo
	} from '../deployment/GitHubRepoPicker.svelte';
	import { toasts } from '../../host/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import FolderPicker from './FolderPicker.svelte';

	type Mode = 'clone' | 'new' | 'open';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine?.name ?? 'the machine');

	const MODES = [
		{ value: 'clone', label: 'Clone' },
		{ value: 'new', label: 'New' },
		{ value: 'open', label: 'Open folder' }
	];
	const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

	let mode = $state<Mode>('clone');
	let picked = $state<PickedRepo | null>(null);
	let location = $state('~');
	let name = $state('');
	let folder = $state('');
	let pickedFolder = $state<{ path: string; git: boolean } | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (open) return;
		mode = 'clone';
		picked = null;
		location = '~';
		name = '';
		folder = '';
		pickedFolder = null;
	});

	const folderGit = $derived(
		pickedFolder && folder.trim() === api.displayPath(pickedFolder.path) ? pickedFolder.git : null
	);

	const cloneName = $derived(
		picked?.url
			.replace(/\.git$/, '')
			.split('/')
			.filter(Boolean)
			.pop() ?? ''
	);
	const where = $derived(
		api.isHomeLocation(location) ? '~' : location.trim().replace(/\/+$/, '')
	);
	const nameError = $derived(
		name.trim() && (!NAME_RE.test(name.trim()) || name.trim().length > 63)
			? 'Use letters, numbers, dots, dashes or underscores'
			: null
	);
	const ready = $derived(
		mode === 'clone'
			? !!picked
			: mode === 'new'
				? !!name.trim() && !nameError
				: !!folder.trim()
	);
	const action = $derived(mode === 'clone' ? 'Clone' : mode === 'new' ? 'Create' : 'Open');
	const pending = $derived(
		mode === 'clone' ? 'Cloning…' : mode === 'new' ? 'Creating…' : 'Opening…'
	);
	const title = $derived(
		mode === 'clone'
			? 'Clone a repository'
			: mode === 'new'
				? 'Start a new project'
				: 'Open a folder'
	);
	const placedLocation = $derived(api.isHomeLocation(location) ? undefined : location.trim());

	async function submit() {
		if (!ws?.isOwner || !ready || busy) return;
		busy = true;
		try {
			if (mode === 'clone' && picked) {
				const res = await api.addRepo(ws.sandboxId, picked.url, placedLocation);
				const key = res?.name ?? cloneName;
				toasts.add({ title: `Cloning ${key}…`, color: 'info' });
				open = false;
				void ws.watchClone(key);
			} else if (mode === 'new') {
				const res = await api.initRepo(ws.sandboxId, name.trim(), placedLocation);
				toasts.add({ title: `Created ${res?.name ?? name.trim()}`, color: 'success' });
				open = false;
				void ws.refreshRepos();
			} else {
				const res = await api.linkRepo(ws.sandboxId, folder.trim());
				toasts.add({ title: `Opened ${res?.name ?? folder.trim()}`, color: 'success' });
				open = false;
				void ws.refreshRepos();
			}
		} catch (e) {
			toasts.add({
				title: `${action} failed`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open || e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
		if (e.target instanceof Element && e.target.closest('button, a, [role="radio"]')) return;
		if (!ready) return;
		e.preventDefault();
		void submit();
	}
</script>

<svelte:window {onkeydown} />

<Modal bind:open {title}>
	<div class="sheet">
		<SegmentedControl
			options={MODES}
			value={mode}
			label="How to add it"
			grow
			onchange={(v) => (mode = v as Mode)}
		/>

		{#if mode === 'clone'}
			<GitHubRepoPicker
				autofocus
				load={!app.env.harness}
				onpick={(repo) => (picked = repo)}
				onclear={() => (picked = null)}
			/>
			{#if ws}
				<Field label="Location" for="gh-clone-location">
					<FolderPicker id="gh-clone-location" sandboxId={ws.sandboxId} bind:value={location} />
				</Field>
			{/if}
			<p class="where">
				Clones into <code>{where}/{cloneName || '…'}</code> on {machine}
			</p>
		{:else if mode === 'new'}
			<Field label="Name" for="gh-new-name" error={nameError}>
				<Input
					id="gh-new-name"
					bind:value={name}
					placeholder="my-project"
					maxlength={63}
					autofocus
					spellcheck="false"
					autocomplete="off"
				/>
			</Field>
			{#if ws}
				<Field label="Location" for="gh-new-location">
					<FolderPicker id="gh-new-location" sandboxId={ws.sandboxId} bind:value={location} />
				</Field>
			{/if}
			<p class="where">
				Creates <code>{where}/{name.trim() || '…'}</code> as an empty git repository on {machine}
			</p>
		{:else}
			{#if ws}
				<Field label="Folder" for="gh-open-folder">
					<FolderPicker
						id="gh-open-folder"
						sandboxId={ws.sandboxId}
						bind:value={folder}
						placeholder="~/projects/app"
						autofocus
						onpicked={(path, git) => (pickedFolder = { path, git })}
					/>
				</Field>
			{/if}
			<p class="where">
				{#if folderGit === true}
					Opens the repository where it is. Nothing is moved or committed.
				{:else if folderGit === false}
					Not a git repository yet. Greenhouse sets one up and commits the folder's files.
				{:else}
					Stays where it is. A folder that isn't a git repository yet gets one, with its files
					in the first commit.
				{/if}
			</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={!ready || busy || !ws?.isOwner} onclick={() => submit()}>
			{busy ? pending : action}
		</Button>
	{/snippet}
</Modal>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.where {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}

	.where code {
		font-family: var(--font-mono);
		color: var(--text-muted);
	}
</style>
