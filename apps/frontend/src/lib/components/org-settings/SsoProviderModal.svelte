<script lang="ts">
	import { uploadsEnabled } from '$lib/stores';
	import { ExternalLink } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Card,
		Dropdown,
		Field,
		Input,
		Modal,
		SectionTitle,
		SettingRow,
		SettingsList,
		Stack,
		Textarea,
		ToggleRow,
		ToneTile
	} from '$lib/components/ui';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { ProviderIcon } from '$lib/components/login';
	import type { ProviderDraft, SsoProvider, SsoProviderPreset } from './sso-types';
	import {
		emptyDraft,
		draftFromProvider,
		PROVIDER_ICON_MAX_BYTES,
		PROVIDER_ICON_TYPES
	} from './sso-types';

	let {
		open = $bindable(false),
		presets,
		editing = null,
		saving = false,
		error = null,
		onSave,
		onClose,
		onIconUpload,
		onIconRemove,
		instance = false
	}: {
		open?: boolean;
		presets: SsoProviderPreset[];
		editing?: SsoProvider | null;
		saving?: boolean;
		error?: string | null;
		onSave: (draft: ProviderDraft) => void;
		onClose: () => void;
		onIconUpload?: (file: File) => Promise<string | null>;
		onIconRemove?: () => Promise<void>;
		instance?: boolean;
	} = $props();

	let draft = $state<ProviderDraft | null>(null);
	let iconInput = $state<HTMLInputElement | null>(null);
	let iconError = $state<string | null>(null);
	let iconBusy = $state<'upload' | 'remove' | null>(null);
	let pendingPreview = $state<string | null>(null);

	const previewUrl = $derived(pendingPreview ?? draft?.iconUrl ?? null);

	$effect(() => {
		const file = draft?.pendingIcon ?? null;
		if (!file) {
			pendingPreview = null;
			return;
		}
		const url = URL.createObjectURL(file);
		pendingPreview = url;
		return () => URL.revokeObjectURL(url);
	});

	let step = $state<'preset' | 'form'>('preset');
	let lastEditingId: string | null = null;
	let wasOpen = false;

	$effect(() => {
		const id = editing?.id ?? null;
		if (open === wasOpen && id === lastEditingId) return;
		wasOpen = open;
		lastEditingId = id;
		if (!open) return;
		iconError = null;
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

	async function pickIcon(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !draft) return;
		iconError = null;
		if (!PROVIDER_ICON_TYPES.includes(file.type)) {
			iconError = 'Use a PNG, JPG or WebP image.';
			return;
		}
		if (file.size > PROVIDER_ICON_MAX_BYTES) {
			iconError = 'That image is larger than 1 MB.';
			return;
		}
		if (!editing || !onIconUpload) {
			draft.pendingIcon = file;
			return;
		}
		iconBusy = 'upload';
		try {
			const url = await onIconUpload(file);
			if (url && draft) draft.iconUrl = url;
		} finally {
			iconBusy = null;
		}
	}

	async function removeIcon() {
		if (!draft) return;
		iconError = null;
		if (draft.pendingIcon) {
			draft.pendingIcon = null;
			return;
		}
		if (!editing || !onIconRemove) {
			draft.iconUrl = null;
			return;
		}
		iconBusy = 'remove';
		try {
			await onIconRemove();
			if (draft) draft.iconUrl = null;
		} catch {
			return;
		} finally {
			iconBusy = null;
		}
	}

	const uid = $props.id();

	const ROLES = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'guest', label: 'Guest' }
	];
</script>

{#snippet copyable(label: string, value: string, id: string)}
	{#snippet copy()}<CopyButton {value} label="Copy {label.toLowerCase()}" />{/snippet}
	<Field {label} for={id}>
		<Input {id} {value} readonly mono suffix={copy} />
	</Field>
{/snippet}

<Modal
	bind:open
	size="lg"
	title={editing ? `Edit ${editing.name}` : 'Add an identity provider'}
	onclose={onClose}
>
	{#if step === 'preset' || !draft}
		<Stack gap="lg">
			<p class="lede">Pick what your members already sign in with.</p>
			{#each [['Social', grouped.social], ['Enterprise', grouped.enterprise], ['Custom', grouped.custom]] as [label, items] (label)}
				{#if (items as SsoProviderPreset[]).length}
					<Stack gap="sm">
						<SectionTitle title={label as string} />
						<div class="presets">
							{#each items as SsoProviderPreset[] as item (item.id)}
								<Card padding="sm" onclick={() => choose(item)}>
									<span class="preset">
										<ProviderIcon preset={item.id} size={18} />
										<span class="preset-name">{item.name}</span>
										<span class="preset-proto">{item.protocol.toUpperCase()}</span>
									</span>
								</Card>
							{/each}
						</div>
					</Stack>
				{/if}
			{/each}
		</Stack>
	{:else}
		<Stack gap="lg">
			{#if error}
				<Alert tone="error">{error}</Alert>
			{/if}

			<div class="head">
				<ToneTile size={36}>
					<ProviderIcon preset={draft.preset} iconUrl={previewUrl} size={18} />
				</ToneTile>
				<div class="head-text">
					<span class="head-name">{preset?.name ?? draft.preset}</span>
					{#if preset?.hint}<span class="head-hint">{preset.hint}</span>{/if}
				</div>
				{#if preset?.docsUrl}
					<Button
						variant="ghost"
						size="sm"
						shape="capsule"
						iconRight={ExternalLink}
						href={preset.docsUrl}
						target="_blank"
						rel="noopener"
					>
						Setup guide
					</Button>
				{/if}
			</div>

			<Stack gap="md">
				<Field label="Display name" for="{uid}-name">
					<Input id="{uid}-name" bind:value={draft.name} placeholder="Acme Okta" />
				</Field>

				<Field
					label="Icon"
					for="{uid}-icon"
					hint="PNG, JPG or WebP, up to 1 MB. Shown on the sign-in button."
					error={iconError}
				>
					<div class="icon-row">
						<ToneTile size={32}>
							<ProviderIcon preset={draft.preset} iconUrl={previewUrl} size={16} />
						</ToneTile>
						{#if $uploadsEnabled}
							<Button
								size="sm"
								loading={iconBusy === 'upload'}
								disabled={iconBusy !== null}
								onclick={() => iconInput?.click()}
							>
								{previewUrl ? 'Replace' : 'Upload'}
							</Button>
						{/if}
						{#if previewUrl}
							<Button
								variant="ghost"
								size="sm"
								loading={iconBusy === 'remove'}
								disabled={iconBusy !== null}
								onclick={removeIcon}
							>
								Remove
							</Button>
						{/if}
						<input
							bind:this={iconInput}
							id="{uid}-icon"
							type="file"
							accept="image/png,image/jpeg,image/webp"
							hidden
							onchange={pickIcon}
						/>
					</div>
				</Field>

				{#if has('tenant')}
					<Field
						label={draft.preset === 'microsoft' ? 'Directory (tenant) ID' : 'Realm'}
						for="{uid}-tenant"
					>
						<Input id="{uid}-tenant" bind:value={draft.tenant} placeholder="organizations" />
					</Field>
				{/if}
				{#if has('domain')}
					<Field label="Provider domain" for="{uid}-domain">
						<Input id="{uid}-domain" bind:value={draft.domain} placeholder="acme.okta.com" />
					</Field>
				{/if}
				{#if has('issuerUrl')}
					<Field label="Issuer URL" for="{uid}-issuer">
						<Input
							id="{uid}-issuer"
							type="url"
							bind:value={draft.issuerUrl}
							placeholder="https://idp.example.com"
						/>
					</Field>
				{/if}
				{#if has('clientId')}
					<Field label="Client ID" for="{uid}-client-id">
						<Input id="{uid}-client-id" mono bind:value={draft.clientId} />
					</Field>
				{/if}
				{#if has('clientSecret')}
					<Field label="Client secret" for="{uid}-client-secret">
						<Input
							id="{uid}-client-secret"
							type="password"
							bind:value={draft.clientSecret}
							placeholder={editing?.clientSecret ? 'Stored. Leave blank to keep it.' : ''}
						/>
					</Field>
				{/if}
				{#if has('scopes')}
					<Field label="Scopes" for="{uid}-scopes">
						<Input
							id="{uid}-scopes"
							mono
							bind:value={draft.scopes}
							placeholder="openid email profile"
						/>
					</Field>
				{/if}

				{#if draft.protocol === 'saml'}
					<Field label="IdP metadata URL" for="{uid}-saml-metadata">
						<Input
							id="{uid}-saml-metadata"
							type="url"
							bind:value={draft.samlMetadataUrl}
							placeholder="https://idp.example.com/metadata"
						/>
					</Field>
					<Field label="Sign-in URL" for="{uid}-saml-entry">
						<Input
							id="{uid}-saml-entry"
							type="url"
							bind:value={draft.samlEntryPoint}
							placeholder="Filled in from metadata when left blank"
						/>
					</Field>
					<Field label="IdP entity ID" for="{uid}-saml-entity">
						<Input
							id="{uid}-saml-entity"
							bind:value={draft.samlIdpEntityId}
							placeholder="urn:idp:acme"
						/>
					</Field>
					<Field label="Signing certificate" for="{uid}-saml-cert">
						<Textarea
							id="{uid}-saml-cert"
							mono
							rows={4}
							bind:value={draft.samlCertificate}
							placeholder={editing?.samlCertificate
								? 'Stored. Leave blank to keep it.'
								: 'Paste the X.509 certificate, or leave blank to read it from metadata'}
						/>
					</Field>
				{/if}
			</Stack>

			{#if editing}
				<Stack gap="sm">
					<SectionTitle title="Give these to your identity provider" />
					<Stack gap="md">
						{@render copyable('Redirect URL', editing.callbackUrl, `${uid}-callback`)}
						{#if draft.protocol === 'saml'}
							{@render copyable('Entity ID', editing.entityId, `${uid}-entity`)}
							{#if editing.metadataUrl}
								{@render copyable('SP metadata', editing.metadataUrl, `${uid}-metadata`)}
							{/if}
						{/if}
					</Stack>
				</Stack>
			{:else}
				<Alert tone="info">
					Save the connection first, then copy the redirect URL it generates into your identity
					provider.
				</Alert>
			{/if}

			<Stack gap="sm">
				<SectionTitle title="Who this lets in" />
				<SettingsList>
					<ToggleRow
						bind:checked={draft.jitProvisioning}
						label="Create accounts on first sign-in"
						hint="Off means only people with an account or a pending invite can use it"
					/>
					<ToggleRow
						bind:checked={draft.requireVerifiedEmail}
						label="Require a verified email"
						hint="Rejects sign-ins when the provider hasn't verified the address"
					/>
					{#if instance && draft.protocol === 'saml'}
						<ToggleRow
							bind:checked={draft.trustEmail}
							label="This provider verifies email addresses"
							hint="SAML can't say whether an address was checked. Only turn this on if your IdP stops people from setting an email they don't own"
						/>
					{/if}
					<SettingRow label="Role for new members" for="{uid}-role">
						<div class="role">
							<Dropdown
								id="{uid}-role"
								bind:value={draft.defaultRole}
								options={ROLES}
								placement="bottom-end"
							/>
						</div>
					</SettingRow>
					<SettingRow
						label="Email domains"
						for="{uid}-domains"
						hint="Blank accepts any address"
						wide
					>
						<Input
							id="{uid}-domains"
							bind:value={draft.allowedDomains}
							placeholder="acme.com, acme.io"
						/>
					</SettingRow>
					<ToggleRow
						bind:checked={draft.enabled}
						label="Show on the sign-in page"
						hint="Off keeps the setup but hides it from members"
					/>
				</SettingsList>
			</Stack>
		</Stack>
	{/if}

	{#snippet footer()}
		<Button
			variant="ghost"
			shape="capsule"
			onclick={() => {
				open = false;
				onClose();
			}}
		>
			Cancel
		</Button>
		{#if step === 'form' && draft}
			<Button
				variant="primary"
				shape="capsule"
				loading={saving}
				disabled={iconBusy !== null}
				onclick={() => draft && onSave(draft)}
			>
				{editing ? 'Save changes' : 'Add connection'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.lede {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
	}
	.preset {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--text-default);
	}
	.preset-name {
		flex: 1;
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
	}
	.preset-proto {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.head-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.head-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.head-hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.icon-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.role {
		width: 9rem;
	}
</style>
