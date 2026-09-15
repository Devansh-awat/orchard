<script lang="ts">
	import { Check, Copy, ExternalLink } from 'lucide-svelte';
	import { Modal, Button, Field, Input, Select, ToggleRow, Alert } from '$lib/components/ui';
	import { ProviderIcon } from '$lib/components/login';
	import type { ProviderDraft, SsoProvider, SsoProviderPreset } from './sso-types';
	import { emptyDraft, draftFromProvider } from './sso-types';

	let {
		open = $bindable(false),
		presets,
		editing = null,
		saving = false,
		error = null,
		onSave,
		onClose
	}: {
		open?: boolean;
		presets: SsoProviderPreset[];
		editing?: SsoProvider | null;
		saving?: boolean;
		error?: string | null;
		onSave: (draft: ProviderDraft) => void;
		onClose: () => void;
	} = $props();

	let draft = $state<ProviderDraft | null>(null);
	let copied = $state<string | null>(null);

	// Editing jumps straight to the form; adding starts on the catalogue.
	let step = $state<'preset' | 'form'>('preset');
	let lastEditingId: string | null = null;
	let wasOpen = false;

	$effect(() => {
		const id = editing?.id ?? null;
		if (open === wasOpen && id === lastEditingId) return;
		wasOpen = open;
		lastEditingId = id;
		if (!open) return;
		if (editing) {
			draft = draftFromProvider(editing);
			step = 'form';
		} else {
			draft = null;
			step = 'preset';
		}
	});

	const preset = $derived(presets.find((p) => p.id === draft?.preset) ?? null);
	const grouped = $derived({
		social: presets.filter((p) => p.category === 'social'),
		enterprise: presets.filter((p) => p.category === 'enterprise'),
		custom: presets.filter((p) => p.category === 'custom')
	});

	function choose(chosen: SsoProviderPreset) {
		draft = emptyDraft(chosen);
		step = 'form';
	}

	function has(field: string) {
		return preset?.fields.includes(field) ?? false;
	}

	async function copy(value: string, key: string) {
		await navigator.clipboard.writeText(value);
		copied = key;
		setTimeout(() => {
			if (copied === key) copied = null;
		}, 1500);
	}
</script>

<Modal
	bind:open
	size="lg"
	title={editing ? `Edit ${editing.name}` : 'Add an identity provider'}
	onclose={onClose}
>
	{#if step === 'preset' || !draft}
		<p class="spm-lede">
			Pick the service your members already sign in with. Everything after this is the client
			credentials it gives you.
		</p>
		{#each [['Social', grouped.social], ['Enterprise', grouped.enterprise], ['Custom', grouped.custom]] as [label, items] (label)}
			{#if (items as SsoProviderPreset[]).length}
				<h4 class="spm-group">{label}</h4>
				<div class="spm-grid">
					{#each items as SsoProviderPreset[] as item (item.id)}
						<button type="button" class="spm-card" onclick={() => choose(item)}>
							<ProviderIcon preset={item.id} size={18} />
							<span class="spm-card-name">{item.name}</span>
							<span class="spm-card-proto">{item.protocol.toUpperCase()}</span>
						</button>
					{/each}
				</div>
			{/if}
		{/each}
	{:else}
		{#if error}
			<Alert tone="error">{error}</Alert>
		{/if}

		<div class="spm-head">
			<ProviderIcon preset={draft.preset} size={20} />
			<div>
				<p class="spm-head-name">{preset?.name ?? draft.preset}</p>
				{#if preset?.hint}
					<p class="spm-head-hint">{preset.hint}</p>
				{/if}
			</div>
			{#if preset?.docsUrl}
				<a class="spm-docs" href={preset.docsUrl} target="_blank" rel="noopener">
					Setup guide <ExternalLink size={12} />
				</a>
			{/if}
		</div>

		<div class="spm-section">
			<Field label="Display name" for="spm-name">
				<Input id="spm-name" bind:value={draft.name} placeholder="Acme Okta" />
			</Field>

			{#if has('tenant')}
				<Field
					label={draft.preset === 'microsoft' ? 'Directory (tenant) ID' : 'Realm'}
					for="spm-tenant"
				>
					<Input id="spm-tenant" bind:value={draft.tenant} placeholder="organizations" />
				</Field>
			{/if}
			{#if has('domain')}
				<Field label="Provider domain" for="spm-domain">
					<Input id="spm-domain" bind:value={draft.domain} placeholder="acme.okta.com" />
				</Field>
			{/if}
			{#if has('issuerUrl')}
				<Field label="Issuer URL" for="spm-issuer">
					<Input
						id="spm-issuer"
						type="url"
						bind:value={draft.issuerUrl}
						placeholder="https://idp.example.com"
					/>
				</Field>
			{/if}
			{#if has('clientId')}
				<Field label="Client ID" for="spm-client-id">
					<Input id="spm-client-id" bind:value={draft.clientId} />
				</Field>
			{/if}
			{#if has('clientSecret')}
				<Field label="Client secret" for="spm-client-secret">
					<Input
						id="spm-client-secret"
						type="password"
						bind:value={draft.clientSecret}
						placeholder={editing?.clientSecret ? 'Stored. Leave blank to keep it.' : ''}
					/>
				</Field>
			{/if}
			{#if has('scopes')}
				<Field label="Scopes" for="spm-scopes">
					<Input id="spm-scopes" bind:value={draft.scopes} placeholder="openid email profile" />
				</Field>
			{/if}

			{#if draft.protocol === 'saml'}
				<Field label="IdP metadata URL" for="spm-saml-metadata">
					<Input
						id="spm-saml-metadata"
						type="url"
						bind:value={draft.samlMetadataUrl}
						placeholder="https://idp.example.com/metadata"
					/>
				</Field>
				<Field label="Sign-in URL" for="spm-saml-entry">
					<Input
						id="spm-saml-entry"
						type="url"
						bind:value={draft.samlEntryPoint}
						placeholder="Filled in from metadata when left blank"
					/>
				</Field>
				<Field label="IdP entity ID" for="spm-saml-entity">
					<Input
						id="spm-saml-entity"
						bind:value={draft.samlIdpEntityId}
						placeholder="urn:idp:acme"
					/>
				</Field>
				<Field label="Signing certificate" for="spm-saml-cert">
					<textarea
						id="spm-saml-cert"
						class="spm-textarea"
						rows="4"
						bind:value={draft.samlCertificate}
						placeholder={editing?.samlCertificate
							? 'Stored. Leave blank to keep it.'
							: 'Paste the X.509 certificate, or leave blank to read it from metadata'}></textarea>
				</Field>
			{/if}
		</div>

		{#if editing}
			<div class="spm-section">
				<h4 class="spm-section-title">Give these to your identity provider</h4>
				<div class="spm-copy-row">
					<span class="spm-copy-label">Redirect URL</span>
					<code class="spm-copy-value">{editing.callbackUrl}</code>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => copy(editing.callbackUrl, 'callback')}
						aria-label="Copy redirect URL"
					>
						{#if copied === 'callback'}<Check size={13} />{:else}<Copy size={13} />{/if}
					</Button>
				</div>
				{#if draft.protocol === 'saml'}
					<div class="spm-copy-row">
						<span class="spm-copy-label">Entity ID</span>
						<code class="spm-copy-value">{editing.entityId}</code>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => copy(editing.entityId, 'entity')}
							aria-label="Copy entity ID"
						>
							{#if copied === 'entity'}<Check size={13} />{:else}<Copy size={13} />{/if}
						</Button>
					</div>
					{#if editing.metadataUrl}
						<div class="spm-copy-row">
							<span class="spm-copy-label">SP metadata</span>
							<code class="spm-copy-value">{editing.metadataUrl}</code>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => copy(editing.metadataUrl ?? '', 'metadata')}
								aria-label="Copy metadata URL"
							>
								{#if copied === 'metadata'}<Check size={13} />{:else}<Copy size={13} />{/if}
							</Button>
						</div>
					{/if}
				{/if}
			</div>
		{:else}
			<Alert tone="info">
				Save the connection first, then copy the redirect URL it generates into your identity
				provider.
			</Alert>
		{/if}

		<div class="spm-section">
			<h4 class="spm-section-title">Who this lets in</h4>
			<ToggleRow
				bind:checked={draft.jitProvisioning}
				label="Create accounts on first sign-in"
				hint="Off means only people who already have an account or a pending invite can use this connection."
			/>
			<ToggleRow
				bind:checked={draft.requireVerifiedEmail}
				label="Require a verified email"
				hint="Rejects sign-ins where the provider does not vouch for the address. Leave on unless your IdP omits the claim."
			/>
			<Field label="Role for new members" for="spm-role">
				<Select id="spm-role" bind:value={draft.defaultRole}>
					<option value="member">Member</option>
					<option value="admin">Admin</option>
					<option value="guest">Guest</option>
				</Select>
			</Field>
			<Field
				label="Restrict to email domains"
				for="spm-domains"
				hint="Comma separated. Leave blank to accept every address the provider returns."
			>
				<Input id="spm-domains" bind:value={draft.allowedDomains} placeholder="acme.com, acme.io" />
			</Field>
			<ToggleRow
				bind:checked={draft.enabled}
				label="Show on the login page"
				hint="Turn off to keep the configuration without offering it to members."
			/>
		</div>
	{/if}

	{#snippet footer()}
		<Button
			variant="ghost"
			onclick={() => {
				open = false;
				onClose();
			}}
		>
			Cancel
		</Button>
		{#if step === 'form' && draft}
			<Button variant="primary" loading={saving} onclick={() => draft && onSave(draft)}>
				{editing ? 'Save changes' : 'Add connection'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.spm-lede {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0 0 1rem;
	}

	.spm-group {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
		margin: 1rem 0 0.5rem;
	}

	.spm-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: 0.5rem;
	}

	.spm-card {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		color: var(--text-default);
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--dur-fast),
			background var(--dur-fast);
	}

	.spm-card:hover {
		border-color: var(--accent);
		background: var(--bg-raised);
	}

	.spm-card-name {
		flex: 1;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		min-width: 0;
	}

	.spm-card-proto {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.spm-head {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.spm-head-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		margin: 0;
	}

	.spm-head-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		margin: 0.15rem 0 0;
		max-width: 44ch;
	}

	.spm-docs {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		text-decoration: none;
		white-space: nowrap;
	}

	.spm-docs:hover {
		color: var(--text-default);
	}

	.spm-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 0;
		border-bottom: 1px solid var(--border-subtle);
	}

	.spm-section:last-of-type {
		border-bottom: none;
		padding-bottom: 0;
	}

	.spm-section-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		margin: 0;
	}

	.spm-textarea {
		width: 100%;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.5;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-default);
		resize: vertical;
	}

	.spm-copy-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.spm-copy-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		width: 7rem;
		flex-shrink: 0;
	}

	.spm-copy-value {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-default);
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 0.3rem 0.5rem;
		overflow-x: auto;
		white-space: nowrap;
	}
</style>
