<script lang="ts">
	import { Shield } from 'lucide-svelte';
	import {
		Button,
		Field,
		FieldGrid,
		Input,
		Modal,
		ModalIntro,
		SecretInput,
		Swap,
		Textarea
	} from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';
	import Snippet from '$lib/components/ui/Snippet.svelte';
	import { apiFetch } from '$lib/stores';
	import { displayHost, protectionOf, type ProtectionMode } from './network';

	const MIN_PASSWORD = 8;

	let {
		open = $bindable(false),
		ingress,
		projectId,
		saving,
		onSave
	}: {
		open: boolean;
		ingress: any | null;
		projectId: string | undefined;
		saving: boolean;
		onSave: (mode: ProtectionMode, password?: string, paths?: string[], username?: string) => void;
	} = $props();

	const uid = $props.id();

	const OPTIONS = [
		{ value: 'none', label: 'None' },
		{ value: 'password', label: 'Password' },
		{ value: 'basic', label: 'Username and password' },
		{ value: 'orchard', label: 'Project members' }
	];

	let mode = $state<ProtectionMode>('none');
	let current = $state<ProtectionMode>('none');
	let username = $state('');
	let password = $state('');
	let paths = $state('');
	let secret = $state<string | null>(null);
	let loadedFor: string | null = null;

	$effect.pre(() => {
		const target = open ? ingress : null;
		if (!target || loadedFor === target.id) return;
		loadedFor = target.id;
		const was = protectionOf(target);
		current = was === 'legacy' ? 'basic' : was;
		mode = current;
		username = '';
		password = '';
		paths = (target.protectionBypassPaths ?? []).join('\n');
		secret = null;
		void loadSecret(target.id);
	});

	$effect(() => {
		if (!open) loadedFor = null;
	});

	async function loadSecret(id: string) {
		if (!projectId) return;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/ingresses/${id}/protection`);
			if (!res.ok) return;
			const data = await res.json().catch(() => null);
			if (loadedFor === id && typeof data?.protectionBypassSecret === 'string')
				secret = data.protectionBypassSecret;
		} catch {
			secret = null;
		}
	}

	const pathList = $derived(
		paths
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	);
	const ready = $derived(
		mode === 'none' ||
			mode === 'orchard' ||
			(mode === 'password' && password.length >= MIN_PASSWORD) ||
			(mode === 'basic' &&
				!!username.trim() &&
				!username.includes(':') &&
				password.length >= MIN_PASSWORD)
	);
	const changed = $derived(
		mode !== current ||
			mode === 'password' ||
			mode === 'basic' ||
			pathList.join('\n') !== (ingress?.protectionBypassPaths ?? []).join('\n')
	);

	function submit() {
		if (!ready || !changed || saving) return;
		onSave(
			mode,
			mode === 'password' || mode === 'basic' ? password : undefined,
			pathList,
			mode === 'basic' ? username.trim() : undefined
		);
	}
</script>

<Modal bind:open size="md" closable={false} dismissable labelledby="{uid}-title">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro
			id="{uid}-title"
			icon={Shield}
			tone="success"
			solid
			title="Protection"
			description={ingress ? displayHost(ingress) : undefined}
		/>
		<div>
			<p class="label">Protection type</p>
			<RadioGroup label="Protection type" options={OPTIONS} bind:value={mode} />
			<Swap key={mode}>
				{#if mode !== 'none'}
					<div class="stack">
						{#if mode === 'password'}
							<Field
								label="Password"
								for="{uid}-password"
								hint="At least {MIN_PASSWORD} characters."
							>
								<SecretInput
									id="{uid}-password"
									placeholder={current === 'password' ? 'Enter a new password' : ''}
									bind:value={password}
								/>
							</Field>
						{:else if mode === 'basic'}
							<FieldGrid>
								<Field
									label="Username"
									for="{uid}-user"
									error={username.includes(':') ? "Can't contain a colon." : undefined}
								>
									<Input id="{uid}-user" autocomplete="off" bind:value={username} />
								</Field>
								<Field
									label="Password"
									for="{uid}-password"
									hint="At least {MIN_PASSWORD} characters."
								>
									<SecretInput id="{uid}-password" bind:value={password} />
								</Field>
							</FieldGrid>
						{/if}
						<Field
							label="Public paths"
							for="{uid}-paths"
							hint="One per line. /api also opens /api/v1, not /apikeys."
						>
							<Textarea
								id="{uid}-paths"
								mono
								rows={3}
								placeholder={'/api\n/webhooks/stripe'}
								bind:value={paths}
							/>
						</Field>
						{#if secret && current !== 'none'}
							<Field label="Bypass header" hint="Lets scripts and CI skip sign-in.">
								<Snippet
									prompt=""
									command="x-orchard-protection-bypass: {secret}"
									label="Copy header"
								/>
							</Field>
						{/if}
					</div>
				{/if}
			</Swap>
		</div>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!ready || !changed} onclick={submit}
			>Save</Button
		>
	{/snippet}
</Modal>

<style>
	.label {
		margin-bottom: 0.5rem;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding-top: 1.5rem;
	}
</style>
