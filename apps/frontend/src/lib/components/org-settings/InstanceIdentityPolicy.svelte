<script lang="ts">
	import { Plus, Trash2 } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		FormActions,
		Input,
		SectionCard,
		SettingRow,
		SettingsList,
		Select,
		Skeleton,
		ToggleRow
	} from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import { ROLE_OPTIONS, describeSaveError, newRow, type RuleRow } from './group-rules';
	import type { AutoCreateRule, IdentityPolicy, MappableRole, SsoProvider } from './sso-types';

	let {
		providers
	}: {
		providers: SsoProvider[];
	} = $props();

	const uid = $props.id();
	const mappable = $derived(
		providers.filter((p) => p.protocol === 'oidc' || p.protocol === 'saml')
	);

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let policy = $state<IdentityPolicy | null>(null);
	let toggling = $state(false);

	let ruleProviderId = $state('');
	let ruleGroup = $state('');
	let savedRule = $state('');
	let savingRule = $state(false);
	let ruleError = $state<string | null>(null);

	let autoProviderId = $state('');
	let autoRows = $state<RuleRow[]>([]);
	let autoSaved = $state('');
	let autoLoading = $state(false);
	let autoSaving = $state(false);
	let autoError = $state<string | null>(null);

	const autoProvider = $derived(
		mappable.find((p) => p.id === autoProviderId) ?? mappable[0] ?? null
	);
	const ruleDirty = $derived(`${ruleProviderId}\u0000${ruleGroup.trim()}` !== savedRule);
	const autoDirty = $derived(autoSnapshot() !== autoSaved);

	function autoSnapshot() {
		return JSON.stringify(
			autoRows.filter((r) => r.value.trim()).map((r) => [r.value.trim(), r.role])
		);
	}

	$effect(() => {
		void load();
	});

	$effect(() => {
		const id = autoProvider?.id;
		if (id) void loadAuto(id);
	});

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await apiFetch('/apiv1/admin/sso/identity-policy');
			if (!res.ok) throw new Error("Couldn't load the identity policy");
			setPolicy((await res.json()) as IdentityPolicy);
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the identity policy";
		} finally {
			loading = false;
		}
	}

	function setPolicy(next: IdentityPolicy) {
		policy = next;
		ruleProviderId = next.superadminRule?.providerId ?? mappable[0]?.id ?? '';
		ruleGroup = next.superadminRule?.value ?? '';
		savedRule = `${next.superadminRule?.providerId ?? mappable[0]?.id ?? ''}\u0000${next.superadminRule?.value ?? ''}`;
	}

	async function patch(body: Record<string, unknown>) {
		const res = await apiFetch('/apiv1/admin/sso/identity-policy', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.message || "Couldn't save");
		setPolicy(data as IdentityPolicy);
	}

	async function toggleAutoCreate() {
		if (!policy || policy.autoCreateOrgs.envOverride !== null) return;
		toggling = true;
		try {
			await patch({ autoCreateOrgs: !policy.autoCreateOrgs.dbValue });
			toasts.add({
				title: policy.autoCreateOrgs.enabled
					? 'Providers can create organizations'
					: 'Providers cannot create organizations',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't save",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			await load();
		} finally {
			toggling = false;
		}
	}

	async function saveRule() {
		savingRule = true;
		ruleError = null;
		try {
			await patch({
				superadminRule: ruleGroup.trim()
					? { providerId: ruleProviderId, value: ruleGroup.trim() }
					: null
			});
			toasts.add({ title: 'Superadmin rule saved', color: 'success' });
		} catch (e) {
			ruleError = describeSaveError(e instanceof Error ? e.message : "Couldn't save the rule");
		} finally {
			savingRule = false;
		}
	}

	async function clearRule() {
		ruleGroup = '';
		await saveRule();
	}

	async function loadAuto(providerId: string) {
		autoLoading = true;
		autoError = null;
		try {
			const res = await apiFetch(`/apiv1/admin/sso/providers/${providerId}/auto-create-rules`);
			if (!res.ok) throw new Error("Couldn't load the organization rules");
			const data = (await res.json()) as { rules: AutoCreateRule[] };
			autoRows = data.rules.map((r) => newRow({ value: r.value, role: r.role }));
			autoSaved = autoSnapshot();
		} catch (e) {
			autoError = e instanceof Error ? e.message : "Couldn't load the organization rules";
		} finally {
			autoLoading = false;
		}
	}

	async function saveAuto() {
		if (!autoProvider) return;
		autoSaving = true;
		autoError = null;
		try {
			const res = await apiFetch(
				`/apiv1/admin/sso/providers/${autoProvider.id}/auto-create-rules`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						rules: autoRows
							.filter((r) => r.value.trim())
							.map((r) => ({ value: r.value.trim(), role: r.role }))
					})
				}
			);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || "Couldn't save the organization rules");
			autoRows = (data as { rules: AutoCreateRule[] }).rules.map((r) =>
				newRow({ value: r.value, role: r.role })
			);
			autoSaved = autoSnapshot();
			toasts.add({ title: 'Organization rules saved', color: 'success' });
		} catch (e) {
			autoError = describeSaveError(e instanceof Error ? e.message : "Couldn't save the rules");
		} finally {
			autoSaving = false;
		}
	}
</script>

{#if mappable.length}
	<SectionCard
		title="Identity provider access"
		description="Decide what a group from an instance provider is allowed to create or become."
	>
		{#if loading}
			<Skeleton height="6rem" rounded="var(--radius-card)" />
		{:else if loadError || !policy}
			<Alert tone="error">
				{loadError}
				{#snippet actions()}
					<Button size="sm" variant="ghost" onclick={load}>Retry</Button>
				{/snippet}
			</Alert>
		{:else}
			<SettingsList>
				{#if policy.autoCreateOrgs.envOverride !== null}
					<SettingRow label="Let providers create organizations">
						{#snippet hint()}
							Pinned {policy?.autoCreateOrgs.envOverride ? 'on' : 'off'} by the
							<code>IDP_AUTO_CREATE_ORGS</code> environment variable.
						{/snippet}
						<Badge>env override</Badge>
					</SettingRow>
				{:else}
					<ToggleRow
						checked={policy.autoCreateOrgs.dbValue}
						disabled={toggling}
						label="Let providers create organizations"
						hint="When a person's group matches an organization rule below, the organization is created once and the group maps into it. Off, those rules do nothing."
						onchange={toggleAutoCreate}
					/>
				{/if}
			</SettingsList>
		{/if}
	</SectionCard>

	{#if autoProvider}
		<SectionCard
			title="Organizations from groups"
			description="A group on {autoProvider.name} that creates its own organization the first time someone in it signs in. The role is what members of that group get."
		>
			{#snippet actions()}
				<Button
					size="sm"
					shape="capsule"
					icon={Plus}
					disabled={autoLoading}
					onclick={() => (autoRows = [...autoRows, newRow()])}
				>
					Add group
				</Button>
			{/snippet}
			{#if mappable.length > 1}
				<SettingsList>
					<SettingRow label="Provider" for="{uid}-auto-provider">
						<Select
							id="{uid}-auto-provider"
							value={autoProvider.id}
							onchange={(e: Event) =>
								(autoProviderId = (e.currentTarget as HTMLSelectElement).value)}
						>
							{#each mappable as provider (provider.id)}
								<option value={provider.id}>{provider.name}</option>
							{/each}
						</Select>
					</SettingRow>
				</SettingsList>
			{/if}
			{#if policy && !policy.autoCreateOrgs.enabled}
				<div class="notice">
					<Alert tone="info">Turned off above, so these groups create nothing yet.</Alert>
				</div>
			{/if}
			{#if autoRows.length}
				<ul class="rules" aria-label="Organizations from groups">
					{#each autoRows as row (row.key)}
						<li class="rule">
							<Input
								bind:value={row.value}
								placeholder="Group name"
								aria-label="Group name"
								autocomplete="off"
								spellcheck={false}
							/>
							<Select bind:value={row.role} aria-label="Role">
								{#each ROLE_OPTIONS as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</Select>
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove {row.value || 'this group'}"
								onclick={() => (autoRows = autoRows.filter((r) => r.key !== row.key))}
							/>
						</li>
					{/each}
				</ul>
			{:else if !autoLoading}
				<p class="quiet">No groups create organizations.</p>
			{/if}
			{#if autoError}
				<div class="notice">
					<Alert tone="error">{autoError}</Alert>
				</div>
			{/if}
			<div class="save">
				<FormActions>
					<Button
						variant="ghost"
						disabled={!autoDirty || autoSaving}
						onclick={() => autoProvider && loadAuto(autoProvider.id)}
					>
						Discard
					</Button>
					<Button variant="primary" loading={autoSaving} disabled={!autoDirty} onclick={saveAuto}>
						Save groups
					</Button>
				</FormActions>
			</div>
		</SectionCard>
	{/if}

	{#if policy}
		<SectionCard
			title="Superadmin group"
			description="People in this group on the chosen provider become superadmins at sign-in, and stop being one when they leave it. Organization providers can never do this. The last superadmin is never removed."
		>
			<SettingsList>
				{#if mappable.length > 1}
					<SettingRow label="Provider" for="{uid}-rule-provider">
						<Select id="{uid}-rule-provider" bind:value={ruleProviderId}>
							{#each mappable as provider (provider.id)}
								<option value={provider.id}>{provider.name}</option>
							{/each}
						</Select>
					</SettingRow>
				{/if}
				<SettingRow label="Group" for="{uid}-rule-group" wide>
					<Input
						id="{uid}-rule-group"
						bind:value={ruleGroup}
						placeholder="Leave empty to turn this off"
						autocomplete="off"
						spellcheck={false}
					/>
				</SettingRow>
			</SettingsList>
			{#if ruleError}
				<div class="notice">
					<Alert tone="error">{ruleError}</Alert>
				</div>
			{/if}
			<div class="save">
				<FormActions>
					{#if policy.superadminRule}
						<Button variant="ghost" disabled={savingRule} onclick={clearRule}>Turn off</Button>
					{/if}
					<Button
						variant="primary"
						loading={savingRule}
						disabled={!ruleDirty || !ruleGroup.trim()}
						onclick={saveRule}
					>
						Save group
					</Button>
				</FormActions>
			</div>
		</SectionCard>
	{/if}
{/if}

<style>
	.rules {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: var(--space-4) 0 0;
		padding: 0;
		list-style: none;
	}
	.rule {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 8rem auto;
		align-items: center;
		gap: var(--space-2);
	}
	.quiet {
		margin-top: var(--space-4);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.notice {
		margin-top: var(--space-4);
	}
	.save {
		margin-top: var(--space-4);
	}
	code {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}
</style>
