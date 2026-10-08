<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2, Plus, Pencil, Trash2, Activity, Search } from 'lucide-svelte';
	import { Button, Badge, Alert, Input, ToggleRow, EmptyState } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import SsoProviderModal from '$lib/components/org-settings/SsoProviderModal.svelte';
	import { ProviderIcon } from '$lib/components/login';
	import { draftToPayload } from '$lib/components/org-settings/sso-types';
	import type {
		ProviderDraft,
		SsoProvider,
		SsoProviderPreset
	} from '$lib/components/org-settings/sso-types';
	import { apiFetch, toasts } from '$lib/stores';

	interface OrgSsoStatus {
		organizationId: string;
		name: string;
		slug: string;
		platformEnabled: boolean;
		enabled: boolean;
		enforced: boolean;
		domainCount: number;
		providerCount: number;
		loginUrl: string;
	}

	interface EnvProvider {
		name: string;
		preset: string;
		label: string;
	}

	interface Enforcement {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
		providersAvailable: boolean;
	}

	let loading = $state(true);
	let providers = $state<SsoProvider[]>([]);
	let presets = $state<SsoProviderPreset[]>([]);
	let organizations = $state<OrgSsoStatus[]>([]);
	let envProvider = $state<EnvProvider | null>(null);
	let enforcement = $state<Enforcement | null>(null);
	let togglingEnforcement = $state(false);
	let loadError = $state<string | null>(null);

	let showModal = $state(false);
	let editing = $state<SsoProvider | null>(null);
	let saving = $state(false);
	let modalError = $state<string | null>(null);
	let testing = $state<string | null>(null);
	let testResult = $state<{ id: string; success: boolean; error?: string } | null>(null);
	let toDelete = $state<SsoProvider | null>(null);
	let showDelete = $state(false);
	let togglingOrg = $state<string | null>(null);
	let orgFilter = $state('');

	const filteredOrgs = $derived.by(() => {
		const q = orgFilter.trim().toLowerCase();
		if (!q) return organizations;
		return organizations.filter(
			(o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q)
		);
	});

	onMount(load);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await apiFetch('/apiv1/admin/sso');
			if (!res.ok) throw new Error('Could not load SSO configuration');
			const data = await res.json();
			providers = data.providers ?? [];
			presets = data.presets ?? [];
			organizations = data.organizations ?? [];
			envProvider = data.envProvider ?? null;
			enforcement = data.enforcement ?? null;
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not load SSO configuration';
		} finally {
			loading = false;
		}
	}

	async function saveProvider(draft: ProviderDraft) {
		saving = true;
		modalError = null;
		try {
			const res = await apiFetch(
				editing ? `/apiv1/admin/sso/providers/${editing.id}` : '/apiv1/admin/sso/providers',
				{
					method: editing ? 'PATCH' : 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(draftToPayload(draft))
				}
			);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not save the provider');
			showModal = false;
			editing = null;
			toasts.add({ title: 'Provider saved', color: 'success' });
			await load();
		} catch (e) {
			modalError = e instanceof Error ? e.message : 'Could not save the provider';
		} finally {
			saving = false;
		}
	}

	async function deleteProvider() {
		if (!toDelete) return;
		try {
			const res = await apiFetch(`/apiv1/admin/sso/providers/${toDelete.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Could not remove the provider');
			toasts.add({ title: 'Provider removed', color: 'success' });
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not remove the provider',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			toDelete = null;
		}
	}

	async function testProvider(provider: SsoProvider) {
		testing = provider.id;
		testResult = null;
		try {
			const res = await apiFetch(`/apiv1/admin/sso/providers/${provider.id}/test`, {
				method: 'POST'
			});
			const data = await res.json().catch(() => ({}));
			testResult = { id: provider.id, success: Boolean(data?.success), error: data?.error };
		} catch {
			testResult = { id: provider.id, success: false, error: 'Could not reach the provider' };
		} finally {
			testing = null;
		}
	}

	async function toggleOrg(org: OrgSsoStatus) {
		togglingOrg = org.organizationId;
		try {
			const res = await apiFetch(`/apiv1/admin/sso/organizations/${org.organizationId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ platformEnabled: !org.platformEnabled })
			});
			if (!res.ok) throw new Error('Could not change this organization');
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not change this organization',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			togglingOrg = null;
		}
	}

	async function toggleEnforcement() {
		if (!enforcement || enforcement.envOverride !== null) return;
		const next = !enforcement.dbValue;
		togglingEnforcement = true;
		try {
			const res = await apiFetch('/apiv1/admin/sso/enforcement', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Could not change the sign-in policy');
			enforcement = data;
			toasts.add({
				title: next ? 'Single sign-on required' : 'Single sign-on optional',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Could not change the sign-in policy',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			togglingEnforcement = false;
		}
	}

	function statusOf(provider: SsoProvider) {
		if (!provider.usable) return { label: 'Incomplete', tone: 'warning' as const };
		if (!provider.enabled) return { label: 'Off', tone: 'neutral' as const };
		return { label: 'Live', tone: 'success' as const };
	}
</script>

<div class="asso">
	{#if loading}
		<div class="asso-loading"><Loader2 class="h-5 w-5 animate-spin" /></div>
	{:else if loadError}
		<Alert tone="error">{loadError}</Alert>
	{:else}
		<section class="asso-section">
			<header class="asso-head">
				<div>
					<h2 class="asso-title">Platform sign-in</h2>
					<p class="asso-desc">
						Identity providers offered to everyone on the platform login page.
					</p>
				</div>
				<Button
					variant="secondary"
					size="sm"
					onclick={() => {
						editing = null;
						modalError = null;
						showModal = true;
					}}
				>
					<Plus size={14} />
					Add provider
				</Button>
			</header>

			{#if envProvider}
				<div class="asso-row asso-row--static">
					<span class="asso-row-icon"><ProviderIcon preset={envProvider.preset} size={18} /></span>
					<div class="asso-row-main">
						<span class="asso-row-name">{envProvider.name}</span>
						<span class="asso-row-meta">Configured through environment variables</span>
					</div>
					<Badge tone="info">Read only</Badge>
				</div>
			{/if}

			{#if !providers.length && !envProvider}
				<EmptyState
					title="No platform providers"
					description="Add Google, GitHub, Microsoft, or any OIDC or SAML provider to offer it on the login page."
				/>
			{:else}
				<ul class="asso-list">
					{#each providers as provider (provider.id)}
						{@const status = statusOf(provider)}
						<li class="asso-row">
							<span class="asso-row-icon"><ProviderIcon preset={provider.preset} size={18} /></span>
							<div class="asso-row-main">
								<span class="asso-row-name">{provider.name}</span>
								<span class="asso-row-meta">
									{provider.protocol.toUpperCase()}
									{#if provider.allowedDomains.length}
										· {provider.allowedDomains.join(', ')}
									{/if}
								</span>
								{#if testResult?.id === provider.id}
									<span class="asso-row-test" class:asso-row-test--bad={!testResult.success}>
										{testResult.success
											? 'Reached the provider successfully.'
											: `Test failed: ${testResult.error}`}
									</span>
								{/if}
							</div>
							<Badge tone={status.tone}>{status.label}</Badge>
							<div class="asso-row-actions">
								<Button
									variant="ghost"
									size="sm"
									loading={testing === provider.id}
									onclick={() => testProvider(provider)}
									aria-label="Test provider"
								>
									{#if testing !== provider.id}<Activity size={14} />{/if}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => {
										editing = provider;
										modalError = null;
										showModal = true;
									}}
									aria-label="Edit provider"
								>
									<Pencil size={14} />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => {
										toDelete = provider;
										showDelete = true;
									}}
									aria-label="Remove provider"
								>
									<Trash2 size={14} />
								</Button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if enforcement}
			<section class="asso-section">
				<header class="asso-head">
					<div>
						<h2 class="asso-title">Sign-in policy</h2>
						<p class="asso-desc">
							Whether anyone may sign in without an identity provider. Superadmins always can, so a
							broken provider never locks the instance.
						</p>
					</div>
				</header>
				<div class="asso-row">
					{#if enforcement.envOverride !== null}
						<div class="asso-row-main">
							<span class="asso-row-name">Require single sign-on for everyone</span>
							<span class="asso-row-meta">
								Pinned {enforcement.envOverride ? 'on' : 'off'} by the SSO_ENFORCED environment variable.
							</span>
						</div>
						<Badge tone="neutral">env override</Badge>
					{:else}
						<div class="asso-row-main">
							<ToggleRow
								checked={enforcement.dbValue}
								disabled={togglingEnforcement ||
									(!enforcement.dbValue && !enforcement.providersAvailable)}
								label="Require single sign-on for everyone"
								hint={enforcement.providersAvailable
									? 'Email codes, passkeys and the superadmin password stop working for everyone except superadmins. Turning this on signs out every session that did not come through a provider.'
									: 'Add and enable a working provider first, or nobody but a superadmin could sign in.'}
								onchange={toggleEnforcement}
							/>
						</div>
					{/if}
				</div>
			</section>
		{/if}

		<section class="asso-section">
			<header class="asso-head">
				<div>
					<h2 class="asso-title">Organization access</h2>
					<p class="asso-desc">
						Turn single sign-on off for one organization without touching its configuration. An org
						owner cannot re-enable it from their own settings.
					</p>
				</div>
				<div class="asso-search">
					<Search size={14} />
					<Input bind:value={orgFilter} placeholder="Filter organizations" />
				</div>
			</header>

			{#if !filteredOrgs.length}
				<EmptyState
					title="No organizations match"
					description="Single sign-on is off for every organization until you allow it here."
				/>
			{:else}
				<ul class="asso-list">
					{#each filteredOrgs as org (org.organizationId)}
						<li class="asso-row">
							<div class="asso-row-main">
								<span class="asso-row-name">{org.name}</span>
								<span class="asso-row-meta">
									/{org.slug} · {org.providerCount}
									{org.providerCount === 1 ? 'connection' : 'connections'}
									{#if org.domainCount}
										· {org.domainCount}
										{org.domainCount === 1 ? 'domain' : 'domains'}
									{/if}
								</span>
							</div>
							{#if org.enforced}
								<Badge tone="info">Enforced</Badge>
							{:else if org.enabled}
								<Badge tone="success">On</Badge>
							{:else}
								<Badge tone="neutral">Off</Badge>
							{/if}
							<div class="asso-row-toggle">
								<ToggleRow
									checked={org.platformEnabled}
									disabled={togglingOrg === org.organizationId}
									label="Allowed"
									onchange={() => toggleOrg(org)}
								/>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<SsoProviderModal
	bind:open={showModal}
	{presets}
	{editing}
	{saving}
	error={modalError}
	onSave={saveProvider}
	onClose={() => {
		editing = null;
		modalError = null;
	}}
/>

<ConfirmModal
	bind:open={showDelete}
	title="Remove this provider?"
	description="It disappears from the platform login page immediately. Accounts created through it keep working."
	confirmLabel="Remove provider"
	onconfirm={deleteProvider}
	oncancel={() => {
		toDelete = null;
	}}
/>

<style>
	.asso {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.asso-loading {
		display: flex;
		justify-content: center;
		padding: 3rem;
		color: var(--text-muted);
	}

	.asso-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.asso-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.asso-title {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 600;
		margin: 0;
		color: var(--text-default);
	}

	.asso-desc {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
		max-width: 60ch;
	}

	.asso-search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--text-faint);
		width: 16rem;
	}

	.asso-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.asso-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.7rem 0.85rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
	}

	.asso-row--static {
		background: var(--bg-raised);
	}

	.asso-row-icon {
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

	.asso-row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.asso-row-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		color: var(--text-default);
	}

	.asso-row-meta {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.asso-row-test {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--status-success);
	}

	.asso-row-test--bad {
		color: var(--status-error);
	}

	.asso-row-actions {
		display: flex;
		align-items: center;
		gap: 0.1rem;
	}

	.asso-row-toggle {
		width: 8rem;
		flex-shrink: 0;
	}
</style>
