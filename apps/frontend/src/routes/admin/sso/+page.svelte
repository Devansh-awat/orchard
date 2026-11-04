<script lang="ts">
	import { onMount } from 'svelte';
	import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		EmptyState,
		List,
		ListRow,
		Menu,
		MenuItem,
		SearchField,
		SectionCard,
		SettingRow,
		SettingsList,
		Skeleton,
		Spinner,
		Stack,
		StatusBadge,
		Swap,
		Switch,
		ToggleRow,
		ToneTile,
		statusMeta
	} from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import SsoProviderModal from '$lib/components/org-settings/SsoProviderModal.svelte';
	import { ProviderIcon } from '$lib/components/login';
	import { draftToPayload } from '$lib/components/org-settings/sso-types';
	import { removeProviderIcon, uploadProviderIcon } from '$lib/components/org-settings/sso-icon';
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

	let loaded = $state(false);
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
		loadError = null;
		try {
			const res = await apiFetch('/apiv1/admin/sso');
			if (!res.ok) throw new Error("Couldn't load SSO configuration");
			const data = await res.json();
			providers = data.providers ?? [];
			presets = data.presets ?? [];
			organizations = data.organizations ?? [];
			envProvider = data.envProvider ?? null;
			enforcement = data.enforcement ?? null;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load SSO configuration";
		} finally {
			loaded = true;
		}
	}

	function providerUrl(id: string) {
		return `/apiv1/admin/sso/providers/${id}`;
	}

	function replaceProvider(updated: SsoProvider) {
		providers = providers.map((p) => (p.id === updated.id ? updated : p));
		if (editing?.id === updated.id) editing = updated;
	}

	async function sendIcon(id: string, file: File) {
		try {
			const updated = await uploadProviderIcon(providerUrl(id), file);
			replaceProvider(updated);
			return updated.iconUrl;
		} catch (e) {
			toasts.add({
				title: "Couldn't upload the icon",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			return null;
		}
	}

	async function uploadIcon(file: File) {
		return editing ? sendIcon(editing.id, file) : null;
	}

	async function removeIcon() {
		if (!editing) return;
		try {
			replaceProvider(await removeProviderIcon(providerUrl(editing.id)));
		} catch (e) {
			toasts.add({
				title: "Couldn't remove the icon",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			throw e;
		}
	}

	async function saveProvider(draft: ProviderDraft) {
		saving = true;
		modalError = null;
		const pendingIcon = draft.pendingIcon ?? null;
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
			if (!res.ok) throw new Error(data?.message || "Couldn't save the provider");
			if (pendingIcon) await sendIcon((data as SsoProvider).id, pendingIcon);
			showModal = false;
			editing = null;
			toasts.add({ title: 'Provider saved', color: 'success' });
			await load();
		} catch (e) {
			modalError = e instanceof Error ? e.message : "Couldn't save the provider";
		} finally {
			saving = false;
		}
	}

	async function deleteProvider() {
		if (!toDelete) return;
		try {
			const res = await apiFetch(`/apiv1/admin/sso/providers/${toDelete.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error("Couldn't remove the provider");
			toasts.add({ title: 'Provider removed', color: 'success' });
			await load();
		} catch (e) {
			toasts.add({
				title: "Couldn't remove the provider",
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
			testResult = { id: provider.id, success: false, error: "Couldn't reach the provider" };
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
			if (!res.ok) throw new Error("Couldn't change this organization");
			await load();
		} catch (e) {
			organizations = organizations.map((item) => ({ ...item }));
			toasts.add({
				title: "Couldn't change this organization",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			togglingOrg = null;
		}
	}

	async function toggleEnforcement() {
		if (!enforcement || enforcement.envOverride !== null) return;
		const previous = enforcement;
		const next = !previous.dbValue;
		togglingEnforcement = true;
		try {
			const res = await apiFetch('/apiv1/admin/sso/enforcement', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || "Couldn't change the sign-in policy");
			enforcement = data;
			toasts.add({
				title: next ? 'Single sign-on required' : 'Single sign-on optional',
				color: 'success'
			});
		} catch (e) {
			enforcement = { ...previous };
			toasts.add({
				title: "Couldn't change the sign-in policy",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			togglingEnforcement = false;
		}
	}

	function statusOf(provider: SsoProvider) {
		if (!provider.usable) return statusMeta('warning', 'Incomplete');
		if (!provider.enabled) return statusMeta('neutral', 'Off');
		return statusMeta('success', 'Live');
	}

	function providerDetail(provider: SsoProvider) {
		const protocol = provider.protocol.toUpperCase();
		return provider.allowedDomains.length
			? `${protocol} · ${provider.allowedDomains.join(', ')}`
			: protocol;
	}

	function orgDetail(org: OrgSsoStatus) {
		const parts = [
			`/${org.slug}`,
			`${org.providerCount} ${org.providerCount === 1 ? 'connection' : 'connections'}`
		];
		if (org.domainCount) {
			parts.push(`${org.domainCount} ${org.domainCount === 1 ? 'domain' : 'domains'}`);
		}
		return parts.join(' · ');
	}

	function orgStatus(org: OrgSsoStatus) {
		if (org.enforced) return statusMeta('info', 'Enforced');
		if (org.enabled) return statusMeta('success', 'On');
		return statusMeta('neutral', 'Off');
	}

	function addProvider() {
		editing = null;
		modalError = null;
		showModal = true;
	}

	function editProvider(provider: SsoProvider) {
		editing = provider;
		modalError = null;
		showModal = true;
	}

	function askDelete(provider: SsoProvider) {
		toDelete = provider;
		showDelete = true;
	}
</script>

<Swap key={!loaded ? 'loading' : loadError && !organizations.length ? 'error' : 'ready'}>
	{#if !loaded}
		<Stack>
			<Skeleton height="10rem" rounded="var(--radius-widget)" />
			<Skeleton height="7rem" rounded="var(--radius-widget)" />
			<Skeleton height="16rem" rounded="var(--radius-widget)" />
		</Stack>
	{:else if loadError && !organizations.length}
		<Alert tone="error" title="Couldn't load sign-in settings">
			{loadError}
			{#snippet actions()}
				<Button size="sm" variant="ghost" onclick={load}>Retry</Button>
			{/snippet}
		</Alert>
	{:else}
		<Stack>
			{#if loadError}
				<Alert tone="error">{loadError}</Alert>
			{/if}

			<SectionCard
				title="Platform sign-in"
				description="Identity providers on this instance's sign-in page."
			>
				{#snippet actions()}
					{#if providers.length || envProvider}
						<Button size="sm" shape="capsule" icon={Plus} onclick={addProvider}>Add provider</Button
						>
					{/if}
				{/snippet}
				{#if providers.length || envProvider}
					<List inset={false} label="Identity providers">
						{#if envProvider}
							<ListRow
								flush
								title={envProvider.name}
								subtitle="Configured through environment variables"
							>
								{#snippet leading()}
									<ToneTile size={32}>
										<ProviderIcon preset={envProvider?.preset ?? 'generic'} size={16} />
									</ToneTile>
								{/snippet}
								{#snippet trailing()}
									<Badge>Read only</Badge>
								{/snippet}
							</ListRow>
						{/if}
						{#each providers as provider (provider.id)}
							{@const result = testResult?.id === provider.id ? testResult : null}
							{#snippet detail()}
								{#if testing === provider.id}
									<Spinner size={12} />Testing
								{:else if result}
									<span
										class="line"
										class:ok={result.success}
										class:bad={!result.success}
										title={result.success ? undefined : `Test failed: ${result.error}`}
									>
										{result.success ? 'Reached the provider' : `Test failed: ${result.error}`}
									</span>
								{:else}
									<span class="line" title={providerDetail(provider)}>
										{providerDetail(provider)}
									</span>
								{/if}
							{/snippet}
							{#snippet controls()}
								<span class="icons">
									<Button
										variant="ghost"
										size="sm"
										icon={Pencil}
										label="Edit {provider.name}"
										onclick={() => editProvider(provider)}
									/>
									<Menu>
										{#snippet trigger(attrs)}
											<Button
												{...attrs}
												variant="ghost"
												size="sm"
												icon={MoreHorizontal}
												label="More for {provider.name}"
											/>
										{/snippet}
										<MenuItem disabled={testing !== null} onclick={() => testProvider(provider)}>
											Test connection
										</MenuItem>
										<MenuItem danger icon={Trash2} onclick={() => askDelete(provider)}>
											Remove
										</MenuItem>
									</Menu>
								</span>
							{/snippet}
							<ListRow flush pinned title={provider.name} subtitle={detail} actions={controls}>
								{#snippet leading()}
									<ToneTile size={32}>
										<ProviderIcon preset={provider.preset} iconUrl={provider.iconUrl} size={16} />
									</ToneTile>
								{/snippet}
								{#snippet titleSuffix()}
									<StatusBadge meta={statusOf(provider)} variant="plain" />
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{:else}
					<EmptyState
						title="No platform providers"
						description="Add Google, GitHub, Microsoft, or any OIDC or SAML provider to the sign-in page."
					>
						<Button icon={Plus} onclick={addProvider}>Add provider</Button>
					</EmptyState>
				{/if}
			</SectionCard>

			{#if enforcement}
				<SectionCard
					title="Sign-in policy"
					description="Superadmins can always sign in without a provider, so a broken one can't lock you out."
				>
					<SettingsList>
						{#if enforcement.envOverride !== null}
							<SettingRow label="Require single sign-on for everyone">
								{#snippet hint()}
									Pinned {enforcement?.envOverride ? 'on' : 'off'} by the
									<code>SSO_ENFORCED</code> environment variable.
								{/snippet}
								<Badge>env override</Badge>
							</SettingRow>
						{:else}
							<ToggleRow
								checked={enforcement.dbValue}
								disabled={togglingEnforcement ||
									(!enforcement.dbValue && !enforcement.providersAvailable)}
								label="Require single sign-on for everyone"
								hint={enforcement.providersAvailable
									? "Stops email codes, passkeys and the superadmin password for everyone but superadmins, and signs out sessions that didn't come through a provider."
									: 'Add and enable a working provider first, or nobody but a superadmin could sign in.'}
								onchange={toggleEnforcement}
							/>
						{/if}
					</SettingsList>
				</SectionCard>
			{/if}

			<SectionCard
				title="Organization access"
				description="Single sign-on stays off for an organization until you allow it here. Turning it off keeps its setup, and its owner can't turn it back on."
			>
				{#snippet actions()}
					{#if organizations.length}
						<span class="filter">
							<SearchField size="sm" bind:value={orgFilter} placeholder="Filter organizations" />
						</span>
					{/if}
				{/snippet}
				{#if filteredOrgs.length}
					<List inset={false} label="Organizations">
						{#each filteredOrgs as org (org.organizationId)}
							{@const status = orgStatus(org)}
							{@const switchId = `sso-allow-${org.organizationId}`}
							{#snippet controls()}
								<span class="org-controls">
									<span class="org-status"><StatusBadge meta={status} variant="plain" /></span>
									<label class="allow" for={switchId}>Allowed</label>
									<Switch
										id={switchId}
										checked={org.platformEnabled}
										disabled={togglingOrg === org.organizationId}
										onchange={() => toggleOrg(org)}
									/>
								</span>
							{/snippet}
							<ListRow flush pinned title={org.name} subtitle={orgDetail(org)} actions={controls} />
						{/each}
					</List>
				{:else if organizations.length}
					<EmptyState title="No organizations match" description="Nothing matches “{orgFilter}”.">
						<Button onclick={() => (orgFilter = '')}>Clear filter</Button>
					</EmptyState>
				{:else}
					<EmptyState
						title="No organizations yet"
						description="Organizations show up here once someone creates one."
					>
						<Button href="/admin/organizations">View organizations</Button>
					</EmptyState>
				{/if}
			</SectionCard>
		</Stack>
	{/if}
</Swap>

<SsoProviderModal
	bind:open={showModal}
	{presets}
	{editing}
	{saving}
	error={modalError}
	onSave={saveProvider}
	onIconUpload={uploadIcon}
	onIconRemove={removeIcon}
	onClose={() => {
		editing = null;
		modalError = null;
	}}
/>

<ConfirmModal
	bind:open={showDelete}
	title="Remove this provider?"
	description="It leaves the sign-in page immediately. Accounts created through it keep working."
	confirmLabel="Remove provider"
	onconfirm={deleteProvider}
	oncancel={() => {
		toDelete = null;
	}}
/>

<style>
	.filter {
		display: block;
		width: 14rem;
	}
	.line {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
	.ok {
		color: var(--status-success);
	}
	.bad {
		color: var(--status-error);
	}
	.icons {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.org-controls {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.org-status {
		display: block;
		width: 5rem;
	}
	.allow {
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		cursor: pointer;
	}
</style>
