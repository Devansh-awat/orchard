<script lang="ts">
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, FormActions, Input, SecretInput } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
	import { presence } from '$lib/utils/transitions';
	import { imageRegistryHost, registryHint, tokenLabel } from '$lib/utils/registry';

	let { projectId, image }: { projectId: string; image: string } = $props();

	const uid = $props.id();

	type Credential = { id: string; registry: string; username: string };

	let credentials = $state<Credential[]>([]);
	let loaded = $state(false);
	let editing = $state(false);
	let saving = $state(false);
	let removing = $state(false);
	let username = $state('');
	let password = $state('');

	const host = $derived(imageRegistryHost(image));
	const match = $derived(credentials.find((c) => c.registry === host) ?? null);
	const canSave = $derived(!!host && !!username.trim() && !!password);

	async function load() {
		if (!projectId) return;
		const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`);
		if (res.ok) credentials = await res.json();
		loaded = true;
	}

	$effect(() => {
		if (projectId) void load();
	});

	function open() {
		username = match?.username ?? '';
		password = '';
		editing = true;
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ registry: host, username: username.trim(), password })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't save credential");
			}
			toasts.add({
				title: `Pulling from ${host} as ${username.trim()}`,
				description: 'Your app is restarting to use the credential.',
				color: 'success'
			});
			editing = false;
			password = '';
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't save credential",
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!match) return;
		removing = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials/${match.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't remove credential");
			}
			toasts.add({ title: `Removed ${host} credential`, color: 'success' });
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't remove credential",
				color: 'error'
			});
		} finally {
			removing = false;
		}
	}
</script>

{#if loaded && host}
	<SettingRow label="Registry login">
		{#snippet hint()}
			{#if match}
				Pulls from <code>{host}</code> as <code>{match.username}</code>, for every app in this
				project
			{:else}
				Pulls from <code>{host}</code> anonymously
			{/if}
		{/snippet}
		{#if match}
			<Button variant="ghost" size="sm" loading={removing} disabled={editing} onclick={remove}
				>Remove</Button
			>
			<Button variant="secondary" size="sm" disabled={editing} onclick={open}>Replace</Button>
		{:else}
			<Button variant="secondary" size="sm" disabled={editing} onclick={open}>Add login</Button>
		{/if}
	</SettingRow>
	{#if editing}
		<form
			class="ra-form"
			in:presence
			out:presence
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<SettingsList>
				<SettingRow label="Username" for="{uid}-user" wide>
					<Input id="{uid}-user" bind:value={username} autocomplete="off" spellcheck="false" />
				</SettingRow>
				<SettingRow label={tokenLabel(host)} for="{uid}-token" wide>
					<SecretInput id="{uid}-token" bind:value={password} autocomplete="new-password" />
				</SettingRow>
			</SettingsList>
			<FormActions hint={registryHint(host)}>
				<Button variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
				<Button type="submit" variant="primary" loading={saving} disabled={!canSave}>Save</Button>
			</FormActions>
		</form>
	{/if}
{/if}

<style>
	.ra-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
</style>
