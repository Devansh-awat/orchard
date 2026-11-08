<script lang="ts">
	import { Plus, Trash2 } from 'lucide-svelte';
	import {
		Alert,
		Button,
		FormActions,
		Input,
		SectionCard,
		SettingRow,
		SettingsList,
		Select,
		Skeleton,
		Textarea
	} from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		ROLE_OPTIONS,
		describePreview,
		describeSaveError,
		duplicateValue,
		missingOrganization,
		newRow,
		parseGroupList,
		rowsFromRules,
		rulesFromRows,
		snapshot,
		type RuleRow
	} from './group-rules';
	import type { GroupRulesState, RulePreview } from './sso-types';

	let {
		baseUrl,
		providerName,
		fixedOrganizationId = null,
		organizations = [],
		readonly = false
	}: {
		baseUrl: string;
		providerName: string;
		fixedOrganizationId?: string | null;
		organizations?: Array<{ id: string; name: string }>;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let groupClaim = $state('groups');
	let rows = $state<RuleRow[]>([]);
	let saved = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	let sample = $state('');
	let previewing = $state(false);
	let preview = $state<RulePreview | null>(null);
	let previewError = $state<string | null>(null);

	const dirty = $derived(snapshot(groupClaim, rows, fixedOrganizationId) !== saved);
	const duplicate = $derived(duplicateValue(rows, fixedOrganizationId));
	const needsOrganization = $derived(missingOrganization(rows, fixedOrganizationId));
	const claimMissing = $derived(groupClaim.trim() === '');
	const invalid = $derived(!!duplicate || needsOrganization || claimMissing);
	const hasRules = $derived(rulesFromRows(rows, fixedOrganizationId).length > 0);
	const previewLine = $derived(
		preview
			? describePreview(preview, (id) => organizations.find((o) => o.id === id)?.name ?? null)
			: null
	);

	$effect(() => {
		void load(baseUrl);
	});

	function apply(state: GroupRulesState) {
		groupClaim = state.groupClaim;
		rows = rowsFromRules(state.rules);
		saved = snapshot(groupClaim, rows, fixedOrganizationId);
	}

	async function load(url: string) {
		loading = true;
		loadError = null;
		preview = null;
		try {
			const res = await apiFetch(`${url}/rules`);
			if (!res.ok) throw new Error("Couldn't load the group rules");
			apply((await res.json()) as GroupRulesState);
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the group rules";
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (invalid || saving) return;
		saving = true;
		saveError = null;
		try {
			const res = await apiFetch(`${baseUrl}/rules`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					groupClaim: groupClaim.trim(),
					rules: rulesFromRows(rows, fixedOrganizationId)
				})
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || "Couldn't save the rules");
			apply(data as GroupRulesState);
			preview = null;
			toasts.add({ title: 'Group rules saved', color: 'success' });
		} catch (e) {
			saveError = describeSaveError(e instanceof Error ? e.message : "Couldn't save the rules");
		} finally {
			saving = false;
		}
	}

	function discard() {
		void load(baseUrl);
		saveError = null;
	}

	async function runPreview() {
		const groups = parseGroupList(sample);
		previewing = true;
		previewError = null;
		try {
			const res = await apiFetch(`${baseUrl}/rules/preview`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ groups })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || "Couldn't run the preview");
			preview = data as RulePreview;
		} catch (e) {
			preview = null;
			previewError = e instanceof Error ? e.message : "Couldn't run the preview";
		} finally {
			previewing = false;
		}
	}

	function addRow() {
		rows = [...rows, newRow({ organizationId: fixedOrganizationId ?? organizations[0]?.id ?? '' })];
	}

	function removeRow(key: string) {
		rows = rows.filter((r) => r.key !== key);
	}
</script>

<SectionCard
	title="Group rules"
	description="Map groups from {providerName} to a role. Matching is exact and case sensitive, and the highest role wins."
>
	{#snippet actions()}
		{#if !readonly}
			<Button size="sm" shape="capsule" icon={Plus} disabled={loading} onclick={addRow}>
				Add rule
			</Button>
		{/if}
	{/snippet}

	{#if loading}
		<Skeleton height="6rem" rounded="var(--radius-card)" />
	{:else if loadError}
		<Alert tone="error">
			{loadError}
			{#snippet actions()}
				<Button size="sm" variant="ghost" onclick={() => load(baseUrl)}>Retry</Button>
			{/snippet}
		</Alert>
	{:else}
		<SettingsList>
			<SettingRow
				label="Group claim"
				for="{uid}-claim"
				hint="Attribute or ID token claim that carries the groups. A dotted path reaches nested claims."
				wide
			>
				<Input
					id="{uid}-claim"
					bind:value={groupClaim}
					placeholder="groups"
					mono
					autocomplete="off"
					spellcheck={false}
					disabled={readonly}
					error={claimMissing}
				/>
			</SettingRow>
		</SettingsList>

		{#if rows.length}
			<ul class="rules" aria-label="Group rules">
				{#each rows as row (row.key)}
					<li class="rule" class:rule--org={fixedOrganizationId === null}>
						<Input
							bind:value={row.value}
							placeholder="Group name"
							aria-label="Group name"
							autocomplete="off"
							spellcheck={false}
							disabled={readonly}
						/>
						<Select bind:value={row.role} aria-label="Role" disabled={readonly}>
							{#each ROLE_OPTIONS as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</Select>
						{#if fixedOrganizationId === null}
							<Select bind:value={row.organizationId} aria-label="Organization" disabled={readonly}>
								<option value="" disabled>Choose an organization</option>
								{#each organizations as org (org.id)}
									<option value={org.id}>{org.name}</option>
								{/each}
							</Select>
						{/if}
						{#if !readonly}
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove rule for {row.value || 'this group'}"
								onclick={() => removeRow(row.key)}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="quiet">
				No rules. Everyone who signs in gets the connection's default role. Once there is one rule,
				people who match none are refused with <code>sso_not_mapped</code>.
			</p>
		{/if}

		{#if hasRules}
			<div class="notice">
				<Alert tone="info">
					People who match no rule are refused with <code>sso_not_mapped</code>. Roles are
					re-evaluated at every sign-in, and owners are never changed by rules.
				</Alert>
			</div>
		{/if}
		{#if duplicate}
			<div class="notice">
				<Alert tone="error">“{duplicate}” appears twice for the same organization.</Alert>
			</div>
		{/if}
		{#if needsOrganization}
			<div class="notice">
				<Alert tone="error">Choose an organization for every rule.</Alert>
			</div>
		{/if}
		{#if saveError}
			<div class="notice">
				<Alert tone="error">{saveError}</Alert>
			</div>
		{/if}

		{#if !readonly}
			<div class="save">
				<FormActions>
					<Button variant="ghost" disabled={!dirty || saving} onclick={discard}>Discard</Button>
					<Button variant="primary" loading={saving} disabled={!dirty || invalid} onclick={save}>
						Save rules
					</Button>
				</FormActions>
			</div>
		{/if}
	{/if}
</SectionCard>

{#if !loading && !loadError}
	<SectionCard
		title="Try a sign-in"
		description="Paste the groups a person has, one per line, and see what the saved rules do."
	>
		<SettingsList>
			<SettingRow label="Groups" for="{uid}-sample" wide>
				<Textarea
					id="{uid}-sample"
					bind:value={sample}
					rows={3}
					mono
					placeholder={'platform-admins\neng'}
					spellcheck={false}
				/>
			</SettingRow>
		</SettingsList>
		<div class="save">
			<FormActions>
				<Button loading={previewing} disabled={dirty || previewing} onclick={runPreview}>
					Run preview
				</Button>
			</FormActions>
		</div>
		{#if dirty}
			<p class="quiet">Save your changes first. The preview uses the saved rules.</p>
		{/if}
		{#if previewError}
			<div class="notice">
				<Alert tone="error">{previewError}</Alert>
			</div>
		{:else if previewLine}
			<div class="notice">
				<Alert tone={previewLine.tone} title={previewLine.title}>
					{#if previewLine.detail}{previewLine.detail}{/if}
				</Alert>
			</div>
		{/if}
	</SectionCard>
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
	.rule--org {
		grid-template-columns: minmax(0, 1fr) 8rem minmax(0, 1fr) auto;
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
