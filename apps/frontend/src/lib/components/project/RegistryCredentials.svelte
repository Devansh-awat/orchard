<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, Plus, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Button,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		List,
		ListRow,
		Modal,
		SecretInput,
		SectionCard,
		Skeleton,
		Stack,
		ToneTile
	} from '$lib/components/ui';
	import { REGISTRY_PRESETS, registryHint, tokenLabel } from '$lib/utils/registry';

	let {
		projectId,
		organizationId,
		canEdit = false
	}: { projectId?: string; organizationId?: string; canEdit?: boolean } = $props();
	const endpoint = $derived(
		organizationId
			? `/apiv1/organizations/${organizationId}/registry-credentials`
			: `/apiv1/projects/${projectId}/registry-credentials`
	);

	type Credential = {
		id: string;
		registry: string;
		username: string;
		updatedAt: string;
	};

	const PRESET_OPTIONS = REGISTRY_PRESETS.map((p) => ({ value: p.value, label: p.label }));
	const formId = $props.id();

	let credentials = $state<Credential[]>([]);
	let loaded = $state(false);
	let saving = $state(false);
	let removing = $state<string | null>(null);
	let editorOpen = $state(false);

	let preset = $state(organizationId ? 'dhi.io' : 'ghcr.io');
	let customHost = $state('');
	let username = $state('');
	let password = $state('');

	const registry = $derived(preset === 'custom' ? customHost.trim() : preset);
	const canSave = $derived(!!registry && !!username.trim() && !!password);
	const replacing = $derived(credentials.some((c) => c.registry === registry));

	async function load() {
		try {
			const res = await apiFetch(endpoint);
			if (!res.ok) throw new Error('Failed to load registry credentials');
			credentials = await res.json();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to load credentials',
				color: 'error'
			});
		} finally {
			loaded = true;
		}
	}

	function openEditor(cred?: Credential) {
		const known = cred && REGISTRY_PRESETS.some((p) => p.value === cred.registry);
		preset = cred ? (known ? cred.registry : 'custom') : organizationId ? 'dhi.io' : 'ghcr.io';
		customHost = cred && !known ? cred.registry : '';
		username = cred?.username ?? '';
		password = '';
		editorOpen = true;
	}

	async function save() {
		if (!canSave || saving) return;
		saving = true;
		try {
			const res = await apiFetch(endpoint, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ registry, username: username.trim(), password })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save credential');
			}
			const saved: Credential = await res.json();
			toasts.add({
				title: 'Registry credential saved',
				description: organizationId
					? `Projects now inherit credentials for ${saved.registry ?? registry}. Project and app overrides take precedence.`
					: `Apps pulling from ${saved.registry ?? registry} now sign in as ${saved.username ?? username.trim()}`,
				color: 'success'
			});
			editorOpen = false;
			password = '';
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to save credential',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove(cred: Credential) {
		removing = cred.id;
		try {
			const res = await apiFetch(`${endpoint}/${cred.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to remove credential');
			}
			credentials = credentials.filter((c) => c.id !== cred.id);
			toasts.add({ title: `Removed ${cred.registry} credential`, color: 'success' });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to remove credential',
				color: 'error'
			});
		} finally {
			removing = null;
		}
	}

	onMount(load);
</script>

{#snippet list()}
	{#if !loaded}
		<Skeleton height="2.5rem" />
	{:else}
		<List inset={false} label="Registry credentials">
			{#each credentials as cred (cred.id)}
				<ListRow flush presence title={cred.registry} subtitle={cred.username}>
					{#snippet leading()}<ToneTile size={32}><KeyRound size={16} /></ToneTile>{/snippet}
					{#snippet actions()}
						{#if canEdit}
							<Button size="sm" onclick={() => openEditor(cred)}>Replace</Button>
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove {cred.registry} credential"
								loading={removing === cred.id}
								onclick={() => remove(cred)}
							/>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
{/snippet}

{#snippet add()}
	{#if canEdit}
		<Button size="sm" icon={Plus} onclick={() => openEditor()}>Add</Button>
	{/if}
{/snippet}

<SectionCard
	title="Registry credentials"
	description={organizationId ? 'Every project uses these unless it sets its own.' : undefined}
	actions={add}
	children={!loaded || credentials.length > 0 ? list : undefined}
/>

{#if canEdit}
	<Modal
		bind:open={editorOpen}
		title={replacing ? 'Replace registry credential' : 'Add registry credential'}
	>
		<form
			id={formId}
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<Stack>
				<Field label="Registry" for="{formId}-preset" hint={registryHint(preset)}>
					<Dropdown id="{formId}-preset" size="lg" bind:value={preset} options={PRESET_OPTIONS} />
				</Field>
				{#if preset === 'custom'}
					<Field label="Host" for="{formId}-host">
						<Input
							id="{formId}-host"
							size="lg"
							mono
							bind:value={customHost}
							placeholder="registry.example.com"
							autocomplete="off"
							spellcheck="false"
						/>
					</Field>
				{/if}
				<FieldGrid>
					<Field label="Username" for="{formId}-username">
						<Input
							id="{formId}-username"
							size="lg"
							bind:value={username}
							autocomplete="off"
							spellcheck="false"
						/>
					</Field>
					<Field label={tokenLabel(preset)} for="{formId}-password">
						<SecretInput id="{formId}-password" size="lg" bind:value={password} />
					</Field>
				</FieldGrid>
			</Stack>
		</form>

		{#snippet footer()}
			<Button variant="ghost" onclick={() => (editorOpen = false)}>Cancel</Button>
			<Button type="submit" form={formId} variant="primary" loading={saving} disabled={!canSave}>
				{replacing ? 'Replace credential' : 'Add credential'}
			</Button>
		{/snippet}
	</Modal>
{/if}
