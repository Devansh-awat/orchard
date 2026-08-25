<script lang="ts">
	import {
		Loader2,
		Plus,
		Check,
		Copy,
		ExternalLink,
		Pencil,
		Trash2,
		Activity,
		Globe
	} from 'lucide-svelte';
	import { ShieldCheck } from '@jis3r/icons';
	import {
		Button,
		Field,
		Input,
		Alert,
		Badge,
		ToggleRow,
		ColorField,
		EmptyState
	} from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { ProviderIcon } from '$lib/components/login';
	import { apiFetch, toasts } from '$lib/stores';
	import SsoProviderModal from './SsoProviderModal.svelte';
	import type {
		ProviderDraft,
		SsoDomain,
		SsoOverview,
		SsoProvider,
		SsoSettings
	} from './sso-types';
	import { draftToPayload, DEFAULT_LOGIN_ACCENT, DEFAULT_LOGIN_BG } from './sso-types';

	let {
		organization,
		isOwner,
		baseDomain,
		index = 0
	}: {
		organization: { id: string; name: string; subdomain?: string } | null;
		isOwner: boolean;
		baseDomain: string;
		index?: number;
	} = $props();

	let loading = $state(true);
	let overview = $state<SsoOverview | null>(null);
	let loadError = $state<string | null>(null);

	let savingSettings = $state(false);
	let savingProvider = $state(false);
	let providerError = $state<string | null>(null);
	let testing = $state<string | null>(null);
	let testResult = $state<{ id: string; success: boolean; error?: string } | null>(null);
	let copied = $state<string | null>(null);

	let showProviderModal = $state(false);
	let editingProvider = $state<SsoProvider | null>(null);
	let providerToDelete = $state<SsoProvider | null>(null);
	let showDeleteModal = $state(false);

	let newDomain = $state('');
	let addingDomain = $state(false);
	let verifyingDomain = $state<string | null>(null);
	let domainError = $state<string | null>(null);
	let logoUrl = $state('');
	let welcomeText = $state('');
	let tagline = $state('');
	let primaryColor = $state('');
	let bgColor = $state('');
	let subdomain = $state('');
	let savingSubdomain = $state(false);

	const settings = $derived(overview?.settings ?? null);
	const providers = $derived(overview?.providers ?? []);
	const domains = $derived(overview?.domains ?? []);
	const locked = $derived(settings ? !settings.platformEnabled : false);
	const canEnable = $derived(providers.some((p) => p.enabled && p.usable));

	$effect(() => {
		if (organization?.id) void load(organization.id);
	});

	async function load(organizationId: string) {
		loading = true;
		loadError = null;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organizationId}/sso`);
			if (!res.ok) throw new Error('Could not load SSO settings');
			const data = (await res.json()) as SsoOverview;
			overview = data;
			logoUrl = data.settings.loginLogoUrl ?? '';
			welcomeText = data.settings.loginWelcomeText ?? '';
			tagline = data.settings.loginTagline ?? '';
			primaryColor = data.settings.loginPrimaryColor ?? '';
			bgColor = data.settings.loginBgColor ?? '';
			subdomain = organization?.subdomain ?? '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not load SSO settings';
		} finally {
			loading = false;
		}
	}

	async function patchSettings(patch: Partial<SsoSettings>, successTitle?: string) {
		if (!organization) return;
		savingSettings = true;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/sso/settings`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not save');
			if (overview) overview = { ...overview, settings: data as SsoSettings };
			if (successTitle) toasts.add({ title: successTitle, color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Could not save',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			// The toggle already flipped optimistically in the DOM; refetch so
			// what is on screen is what the server actually stored.
			if (organization) await load(organization.id);
		} finally {
			savingSettings = false;
		}
	}

	async function saveProvider(draft: ProviderDraft) {
		if (!organization) return;
		savingProvider = true;
		providerError = null;
		try {
			const base = `/apiv1/organizations/${organization.id}/sso/providers`;
			const res = await apiFetch(editingProvider ? `${base}/${editingProvider.id}` : base, {
				method: editingProvider ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(draftToPayload(draft))
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not save the connection');

			showProviderModal = false;
			editingProvider = null;
			toasts.add({ title: 'Connection saved', color: 'success' });
			await load(organization.id);
		} catch (e) {
			providerError = e instanceof Error ? e.message : 'Could not save the connection';
		} finally {
			savingProvider = false;
		}
	}

	async function deleteProvider() {
		if (!organization || !providerToDelete) return;
		const { id } = providerToDelete;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/sso/providers/${id}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error('Could not remove the connection');
			toasts.add({ title: 'Connection removed', color: 'success' });
			await load(organization.id);
		} catch (e) {
			toasts.add({
				title: 'Could not remove the connection',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			providerToDelete = null;
		}
	}

	async function testProvider(provider: SsoProvider) {
		if (!organization) return;
		testing = provider.id;
		testResult = null;
		try {
			const res = await apiFetch(
				`/apiv1/organizations/${organization.id}/sso/providers/${provider.id}/test`,
				{ method: 'POST' }
			);
			const data = await res.json().catch(() => ({}));
			testResult = { id: provider.id, success: Boolean(data?.success), error: data?.error };
		} catch {
			testResult = { id: provider.id, success: false, error: 'Could not reach the provider' };
		} finally {
			testing = null;
		}
	}

	async function saveBranding() {
		await patchSettings(
			{
				loginLogoUrl: logoUrl.trim() || null,
				loginWelcomeText: welcomeText.trim() || null,
				loginTagline: tagline.trim() || null,
				loginPrimaryColor: primaryColor || null,
				loginBgColor: bgColor || null
			},
			'Login page updated'
		);
	}

	async function addDomain() {
		if (!organization || addingDomain) return;
		const value = newDomain.trim();
		if (!value) return;

		addingDomain = true;
		domainError = null;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/sso/domains`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domain: value })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not add that domain');
			newDomain = '';
			await load(organization.id);
		} catch (e) {
			domainError = e instanceof Error ? e.message : 'Could not add that domain';
		} finally {
			addingDomain = false;
		}
	}

	async function verifyDomain(domain: SsoDomain) {
		if (!organization || verifyingDomain) return;
		verifyingDomain = domain.id;
		domainError = null;
		try {
			const res = await apiFetch(
				`/apiv1/organizations/${organization.id}/sso/domains/${domain.id}/verify`,
				{ method: 'POST' }
			);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not check DNS');
			if (data?.verified) {
				toasts.add({ title: `${domain.domain} verified`, color: 'success' });
			}
			await load(organization.id);
		} catch (e) {
			domainError = e instanceof Error ? e.message : 'Could not check DNS';
		} finally {
			verifyingDomain = null;
		}
	}

	async function removeDomain(domain: SsoDomain) {
		if (!organization) return;
		try {
			const res = await apiFetch(
				`/apiv1/organizations/${organization.id}/sso/domains/${domain.id}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error('Could not remove that domain');
			await load(organization.id);
		} catch (e) {
			toasts.add({
				title: 'Could not remove that domain',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async function saveSubdomain() {
		if (!organization) return;
		savingSubdomain = true;
		try {
			const res = await apiFetch(`/apiv1/organizations/${organization.id}/subdomain`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subdomain: subdomain.trim() || null })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not save the subdomain');
			toasts.add({ title: 'Vanity address updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Could not save the subdomain',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingSubdomain = false;
		}
	}

	async function copyText(value: string, key: string) {
		await navigator.clipboard.writeText(value);
		copied = key;
		setTimeout(() => {
			if (copied === key) copied = null;
		}, 1500);
	}

	function providerStatus(provider: SsoProvider) {
		if (!provider.usable) return { label: 'Incomplete', tone: 'warning' as const };
		if (!provider.enabled) return { label: 'Off', tone: 'neutral' as const };
		return { label: 'Live', tone: 'success' as const };
	}

	function lastUsedLabel(value: string | null) {
		if (!value) return 'never used';
		return `last used ${new Date(value).toLocaleDateString()}`;
	}
</script>

<SettingsSection
	title="Single sign-on"
	description="Let members sign in through your own identity providers"
	{index}
>
	{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}

	{#if loading}
		<div class="sso-loading"><Loader2 class="h-5 w-5 animate-spin" /></div>
	{:else if loadError}
		<Alert tone="error">{loadError}</Alert>
	{:else if settings && overview}
		{#if locked}
			<Alert tone="warning" title="Turned off by the platform administrator">
				Single sign-on is unavailable for this organization. Existing configuration is kept, but
				members cannot sign in through it until an administrator re-enables it.
			</Alert>
		{/if}

		<!-- Where members sign in -->
		<div class="sso-block">
			<h3 class="sso-block-title">Your sign-in page</h3>
			<div class="sso-url">
				<code>{overview.loginUrl}</code>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => copyText(overview?.loginUrl ?? '', 'login')}
					aria-label="Copy sign-in URL"
				>
					{#if copied === 'login'}<Check size={13} />{:else}<Copy size={13} />{/if}
				</Button>
				<Button variant="ghost" size="sm" href={overview.loginUrl} target="_blank" rel="noopener">
					<ExternalLink size={13} />
				</Button>
			</div>
			<p class="sso-hint">
				Anyone who opens this page gets your connections and your branding. There is no subdomain to
				set up.
			</p>

			<ToggleRow
				checked={settings.enabled}
				disabled={locked || !canEnable || savingSettings}
				label="Single sign-on is on"
				hint={canEnable
					? 'Members can sign in through the connections below.'
					: 'Add and enable a working connection first.'}
				onchange={() => patchSettings({ enabled: !settings.enabled })}
			/>
			<ToggleRow
				checked={settings.enforced}
				disabled={locked || !settings.enabled || savingSettings}
				label="Require single sign-on"
				hint="Blocks email codes, passkeys, and platform providers for everyone in this organization."
				onchange={() => patchSettings({ enforced: !settings.enforced })}
			/>
		</div>

		<!-- Connections -->
		<div class="sso-block">
			<div class="sso-block-head">
				<h3 class="sso-block-title">Connections</h3>
				<Button
					variant="secondary"
					size="sm"
					disabled={locked}
					onclick={() => {
						editingProvider = null;
						providerError = null;
						showProviderModal = true;
					}}
				>
					<Plus size={14} />
					Add connection
				</Button>
			</div>

			{#if !providers.length}
				<EmptyState
					title="No identity providers yet"
					description="Connect Google, Microsoft, Okta, GitHub, or any OpenID Connect or SAML provider."
				/>
			{:else}
				<ul class="sso-list">
					{#each providers as provider (provider.id)}
						{@const status = providerStatus(provider)}
						<li class="sso-item">
							<span class="sso-item-icon"><ProviderIcon preset={provider.preset} size={18} /></span>
							<div class="sso-item-main">
								<span class="sso-item-name">{provider.name}</span>
								<span class="sso-item-meta">
									{provider.protocol.toUpperCase()} · {lastUsedLabel(provider.lastUsedAt)}
									{#if provider.allowedDomains.length}
										· {provider.allowedDomains.join(', ')}
									{/if}
								</span>
								{#if testResult?.id === provider.id}
									<span class="sso-item-test" class:sso-item-test--bad={!testResult.success}>
										{testResult.success
											? 'Reached the provider successfully.'
											: `Test failed: ${testResult.error}`}
									</span>
								{/if}
							</div>
							<Badge tone={status.tone}>{status.label}</Badge>
							<div class="sso-item-actions">
								<Button
									variant="ghost"
									size="sm"
									loading={testing === provider.id}
									onclick={() => testProvider(provider)}
									aria-label="Test connection"
								>
									{#if testing !== provider.id}<Activity size={14} />{/if}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => {
										editingProvider = provider;
										providerError = null;
										showProviderModal = true;
									}}
									aria-label="Edit connection"
								>
									<Pencil size={14} />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => {
										providerToDelete = provider;
										showDeleteModal = true;
									}}
									aria-label="Remove connection"
								>
									<Trash2 size={14} />
								</Button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- Domains -->
		<div class="sso-block">
			<h3 class="sso-block-title">Email domains</h3>
			<p class="sso-hint">
				Proving you own a domain lets work addresses at it route here from the platform login page,
				and lets your providers create accounts for people at that domain who have never signed in
				before. Until then, new people join by invitation.
			</p>

			<form
				class="sso-inline"
				onsubmit={(e) => {
					e.preventDefault();
					addDomain();
				}}
			>
				<Input bind:value={newDomain} placeholder="acme.com" disabled={locked} />
				<Button variant="secondary" type="submit" loading={addingDomain} disabled={locked}>
					Add domain
				</Button>
			</form>

			{#if domainError}
				<Alert tone="error">{domainError}</Alert>
			{/if}

			{#each domains as domain (domain.id)}
				<div class="sso-domain">
					<div class="sso-domain-head">
						<span class="sso-domain-name">{domain.domain}</span>
						<Badge tone={domain.verified ? 'success' : 'warning'}>
							{domain.verified ? 'Verified' : 'Pending'}
						</Badge>
						<div class="sso-item-actions">
							{#if !domain.verified}
								<Button
									variant="secondary"
									size="sm"
									loading={verifyingDomain === domain.id}
									onclick={() => verifyDomain(domain)}
								>
									Check DNS
								</Button>
							{/if}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => removeDomain(domain)}
								aria-label="Remove domain"
							>
								<Trash2 size={14} />
							</Button>
						</div>
					</div>

					{#if !domain.verified}
						<p class="sso-hint">Add this TXT record at your DNS provider, then check again.</p>
						<div class="sso-copy-row">
							<span class="sso-copy-label">Name</span>
							<code class="sso-copy-value">{domain.recordName}</code>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => copyText(domain.recordName, `n-${domain.id}`)}
								aria-label="Copy record name"
							>
								{#if copied === `n-${domain.id}`}<Check size={13} />{:else}<Copy size={13} />{/if}
							</Button>
						</div>
						<div class="sso-copy-row">
							<span class="sso-copy-label">Value</span>
							<code class="sso-copy-value">{domain.recordValue}</code>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => copyText(domain.recordValue, `v-${domain.id}`)}
								aria-label="Copy record value"
							>
								{#if copied === `v-${domain.id}`}<Check size={13} />{:else}<Copy size={13} />{/if}
							</Button>
						</div>
						{#if domain.lastError}
							<p class="sso-domain-error">{domain.lastError}</p>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		<!-- Branding -->
		<div class="sso-block">
			<h3 class="sso-block-title">Login page</h3>
			<Field label="Logo URL" for="sso-logo">
				<Input
					id="sso-logo"
					type="url"
					bind:value={logoUrl}
					placeholder="https://acme.com/logo.svg"
				/>
			</Field>
			<Field label="Heading" for="sso-welcome">
				<Input
					id="sso-welcome"
					bind:value={welcomeText}
					placeholder={`Sign in to ${organization?.name ?? ''}`}
				/>
			</Field>
			<Field label="Subheading" for="sso-tagline">
				<Input id="sso-tagline" bind:value={tagline} placeholder="Use your work account" />
			</Field>
			<div class="sso-colors">
				<ColorField
					label="Accent"
					value={primaryColor || DEFAULT_LOGIN_ACCENT}
					onchange={(v) => (primaryColor = v)}
				/>
				<ColorField
					label="Background"
					value={bgColor || DEFAULT_LOGIN_BG}
					onchange={(v) => (bgColor = v)}
				/>
			</div>
			<div class="sso-actions">
				<Button variant="primary" loading={savingSettings} onclick={saveBranding}>
					Save login page
				</Button>
				<Button variant="ghost" href={overview.loginUrl} target="_blank" rel="noopener">
					Preview
					<ExternalLink size={13} />
				</Button>
			</div>
		</div>

		{#if isOwner}
			<div class="sso-block">
				<h3 class="sso-block-title"><Globe size={13} /> Vanity address</h3>
				<Field
					label="Subdomain"
					for="sso-subdomain"
					hint="Optional. Visitors are redirected to the sign-in page above."
				>
					<div class="sso-inline">
						<Input id="sso-subdomain" bind:value={subdomain} placeholder="acme" />
						<span class="sso-suffix">.{baseDomain}</span>
						<Button variant="secondary" loading={savingSubdomain} onclick={saveSubdomain}>
							Save
						</Button>
					</div>
				</Field>
			</div>
		{/if}
	{/if}
</SettingsSection>

{#if overview}
	<SsoProviderModal
		bind:open={showProviderModal}
		presets={overview.presets}
		editing={editingProvider}
		saving={savingProvider}
		error={providerError}
		onSave={saveProvider}
		onClose={() => {
			editingProvider = null;
			providerError = null;
		}}
	/>
{/if}

<ConfirmModal
	bind:open={showDeleteModal}
	title="Remove this connection?"
	description="Members who sign in through it will lose that route immediately. Their accounts and memberships are untouched."
	confirmLabel="Remove connection"
	onconfirm={deleteProvider}
	oncancel={() => {
		providerToDelete = null;
	}}
/>

<style>
	.sso-loading {
		display: flex;
		justify-content: center;
		padding: 2rem;
		color: var(--text-muted);
	}

	.sso-block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 0;
		border-top: 1px solid var(--border-subtle);
	}

	.sso-block:first-of-type {
		border-top: none;
	}

	.sso-block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.sso-block-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		margin: 0;
	}

	.sso-url {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.sso-url code {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-default);
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 0.4rem 0.6rem;
		overflow-x: auto;
		white-space: nowrap;
	}

	.sso-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		margin: 0;
	}

	.sso-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.sso-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
	}

	.sso-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.sso-item-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.sso-item-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		color: var(--text-default);
	}

	.sso-item-meta {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.sso-item-test {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--status-success);
	}

	.sso-item-test--bad {
		color: var(--status-error);
	}

	.sso-item-actions {
		display: flex;
		align-items: center;
		gap: 0.1rem;
	}

	.sso-domain {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
	}

	.sso-domain-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-domain-name {
		flex: 1;
		min-width: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		color: var(--text-default);
	}

	.sso-domain-error {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--status-warning);
		margin: 0;
	}

	.sso-copy-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-copy-label {
		width: 3.5rem;
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.sso-copy-value {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-default);
		background: var(--bg-raised);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 0.3rem 0.5rem;
		overflow-x: auto;
		white-space: nowrap;
	}

	.sso-inline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-inline :global(.ui-input-wrap),
	.sso-inline :global(input) {
		flex: 1;
		min-width: 0;
	}

	.sso-suffix {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.sso-colors {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.75rem;
	}

	.sso-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
</style>
