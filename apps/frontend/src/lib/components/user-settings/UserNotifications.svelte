<script lang="ts">
	import { Ellipsis, Mail, MessageSquare, Plus, Send, Slack, Trash2, Webhook } from 'lucide-svelte';
	import {
		Badge,
		Button,
		Dropdown,
		Field,
		Input,
		List,
		ListRow,
		Menu,
		MenuItem,
		Modal,
		ModalIntro,
		SectionCard,
		SegmentedControl,
		SettingRow,
		SettingsList,
		Skeleton,
		Switch,
		ToneTile
	} from '$lib/components/ui';
	import { formatRelativeTime } from '$lib/utils/format';
	import { toasts } from '$lib/stores';
	import {
		addDestination,
		clearScopeSettings,
		deleteDestination,
		fetchDestinations,
		fetchUserSettings,
		saveGlobalSettings,
		setDestinationEnabled,
		testDestination
	} from '$lib/components/notifications/api';
	import {
		CATEGORY_LABELS,
		CATEGORY_OPTIONS,
		settingLabel,
		type NotificationCategory,
		type SettingValue,
		CORE_CATEGORIES,
		registerExtensionCategories,
		type UserDestination,
		type UserSettings
	} from '$lib/components/notifications/types';

	let { index: _index = 0 }: { index?: number } = $props();

	const uid = $props.id();

	const CATEGORIES: NotificationCategory[] = $derived([
		...CORE_CATEGORIES,
		...registerExtensionCategories(settings?.extensionCategories)
	]);

	const DEST_META: Record<string, { label: string; icon: typeof Webhook }> = {
		email: { label: 'Email', icon: Mail },
		slack: { label: 'Slack', icon: Slack },
		discord: { label: 'Discord', icon: MessageSquare }
	};

	let loading = $state(true);
	let settings = $state<UserSettings | null>(null);
	let destinations = $state<UserDestination[]>([]);
	let savingCategory = $state<NotificationCategory | null>(null);
	let busyId = $state<string | null>(null);
	let clearingKey = $state<string | null>(null);
	let addOpen = $state(false);
	let addType = $state('slack');
	let addUrl = $state('');
	let adding = $state(false);

	async function load() {
		loading = true;
		try {
			[settings, destinations] = await Promise.all([fetchUserSettings(), fetchDestinations()]);
		} catch (e) {
			toasts.add({
				title: 'Could not load your notification settings',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
	});

	async function choose(category: NotificationCategory, value: SettingValue) {
		if (savingCategory || !settings) return;
		const previous = settings.global[category];
		if (previous === value) return;
		savingCategory = category;
		settings.global[category] = value;
		try {
			settings = await saveGlobalSettings({ [category]: value });
		} catch (e) {
			if (settings) settings.global[category] = previous;
			toasts.add({
				title: 'Could not save that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingCategory = null;
		}
	}

	function overrideKey(override: UserSettings['overrides'][number]) {
		return `${override.scopeType}:${override.scopeId}`;
	}

	async function clearOverride(override: UserSettings['overrides'][number]) {
		const key = overrideKey(override);
		if (clearingKey) return;
		clearingKey = key;
		try {
			await clearScopeSettings(override.scopeType, override.scopeId);
			settings = await fetchUserSettings();
		} catch (e) {
			toasts.add({
				title: 'Could not clear that override',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			clearingKey = null;
		}
	}

	async function toggleDestination(dest: UserDestination) {
		if (busyId) return;
		busyId = dest.id;
		try {
			await setDestinationEnabled(dest.id, !dest.enabled);
			destinations = await fetchDestinations();
		} catch (e) {
			toasts.add({
				title: 'Could not update that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	async function removeDestination(dest: UserDestination) {
		if (busyId) return;
		busyId = dest.id;
		try {
			await deleteDestination(dest.id);
			destinations = destinations.filter((d) => d.id !== dest.id);
		} catch (e) {
			toasts.add({
				title: 'Could not remove that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	async function test(dest: UserDestination) {
		if (busyId) return;
		busyId = dest.id;
		try {
			const result = await testDestination(dest.id);
			if (result.success) toasts.add({ title: 'Test sent', color: 'success' });
			else throw new Error(result.error || 'Test delivery failed');
		} catch (e) {
			toasts.add({
				title: 'Test failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
			destinations = await fetchDestinations().catch(() => destinations);
		}
	}

	function openAdd() {
		addType = 'slack';
		addUrl = '';
		addOpen = true;
	}

	async function submitDestination() {
		if (!addUrl.trim() || adding) return;
		adding = true;
		try {
			await addDestination(addType, addUrl.trim());
			addOpen = false;
			addUrl = '';
			destinations = await fetchDestinations();
			toasts.add({ title: 'Delivery method added', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Could not add that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			adding = false;
		}
	}

	function overrideSummary(override: UserSettings['overrides'][number]): string {
		const values = Object.entries(override.values).map(([category, value]) => {
			const key = category as NotificationCategory;
			const label = CATEGORY_LABELS[key] ?? category;
			const choice = settingLabel(key, value as SettingValue)?.label ?? String(value);
			return `${choice} for ${label.toLowerCase()}`;
		});
		return [override.context ? `In ${override.context}` : null, ...values]
			.filter(Boolean)
			.join(' · ');
	}

	function scopeLabel(scopeType: string) {
		return scopeType.charAt(0).toUpperCase() + scopeType.slice(1);
	}

	function destStatus(dest: UserDestination): string | undefined {
		if (dest.circuitOpenUntil && new Date(dest.circuitOpenUntil).getTime() > Date.now()) {
			return `Paused until ${formatRelativeTime(new Date(dest.circuitOpenUntil))}`;
		}
		if (dest.consecutiveFailures > 0 && dest.lastErrorAt) {
			return `Failing since ${formatRelativeTime(new Date(dest.lastErrorAt))}`;
		}
		if (dest.lastSuccessAt) {
			return `Last delivered ${formatRelativeTime(new Date(dest.lastSuccessAt))}`;
		}
		return dest.enabled ? undefined : 'Off';
	}

	const webhookCount = $derived(destinations.filter((d) => d.type !== 'email').length);
</script>

{#if loading}
	<SectionCard title="Your defaults">
		<div class="placeholder">
			<Skeleton height="2.5rem" />
			<Skeleton height="2.5rem" />
			<Skeleton height="2.5rem" />
		</div>
	</SectionCard>
{:else if !settings}
	<SectionCard title="Notifications">
		{#snippet actions()}
			<Button variant="ghost" size="sm" onclick={load}>Retry</Button>
		{/snippet}
		<p class="quiet">Could not load your notification settings.</p>
	</SectionCard>
{:else}
	<SectionCard
		title="Your defaults"
		description="Applies everywhere unless you override it on a project or app. Team channels your organization set up are separate."
	>
		<SettingsList label="Your defaults">
			{#each CATEGORIES as category (category)}
				{@const current = settings.global[category]}
				<SettingRow label={CATEGORY_LABELS[category]} hint={settingLabel(category, current).hint}>
					<SegmentedControl
						label={CATEGORY_LABELS[category]}
						value={current}
						options={CATEGORY_OPTIONS[category].map((option) => ({
							value: option,
							label: settingLabel(category, option).label,
							hint: settingLabel(category, option).hint,
							disabled: savingCategory === category
						}))}
						onchange={(v) => choose(category, v as SettingValue)}
					/>
				</SettingRow>
			{/each}
		</SettingsList>
	</SectionCard>

	<SectionCard
		title="Where they go"
		description="Nothing is sent until you turn one on. Your account email plus up to three Slack or Discord webhooks."
	>
		{#snippet actions()}
			{#if webhookCount < 3}
				<Button size="sm" icon={Plus} onclick={openAdd}>Add webhook</Button>
			{/if}
		{/snippet}
		{#if destinations.length}
			<List inset={false} label="Delivery methods">
				{#each destinations as dest (dest.id)}
					{@const meta = DEST_META[dest.type]}
					<ListRow flush pinned presence title={meta.label} subtitle={destStatus(dest)}>
						{#snippet leading()}
							<ToneTile size={32}><meta.icon size={16} /></ToneTile>
						{/snippet}
						{#snippet actions()}
							<Switch
								label={dest.enabled ? `Turn off ${meta.label}` : `Turn on ${meta.label}`}
								bind:checked={() => dest.enabled, () => toggleDestination(dest)}
								disabled={busyId === dest.id}
							/>
							<Menu>
								{#snippet trigger(props)}
									<Button
										{...props}
										size="sm"
										variant="ghost"
										icon={Ellipsis}
										label={`More for ${meta.label}`}
										loading={busyId === dest.id}
									/>
								{/snippet}
								<MenuItem icon={Send} onclick={() => test(dest)}>Send a test</MenuItem>
								{#if dest.type !== 'email'}
									<MenuItem icon={Trash2} danger onclick={() => removeDestination(dest)}
										>Remove</MenuItem
									>
								{/if}
							</Menu>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</SectionCard>

	<SectionCard title="Overrides" description="Everywhere you have changed your defaults.">
		{#if settings.overrides.length === 0}
			<p class="quiet">None. Your defaults apply everywhere.</p>
		{:else}
			<List inset={false} label="Overrides">
				{#each settings.overrides as override (overrideKey(override))}
					{@const key = overrideKey(override)}
					<ListRow
						flush
						presence
						pinned={clearingKey === key}
						title={override.label}
						subtitle={overrideSummary(override)}
					>
						{#snippet titleSuffix()}
							<Badge>{scopeLabel(override.scopeType)}</Badge>
							{#if override.missing}<Badge>Deleted</Badge>{/if}
						{/snippet}
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								loading={clearingKey === key}
								onclick={() => clearOverride(override)}>Clear</Button
							>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</SectionCard>
{/if}

<Modal bind:open={addOpen} size="sm" closable={false} dismissable labelledby="{uid}-title">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submitDestination();
		}}
	>
		<ModalIntro id="{uid}-title" icon={Webhook} title="Add a personal webhook" />
		<Field label="Service" for="{uid}-type">
			<Dropdown
				id="{uid}-type"
				size="lg"
				bind:value={addType}
				options={[
					{ value: 'slack', label: 'Slack' },
					{ value: 'discord', label: 'Discord' }
				]}
			/>
		</Field>
		<Field label="Webhook URL" for="{uid}-url">
			<Input
				id="{uid}-url"
				size="lg"
				mono
				bind:value={addUrl}
				autocomplete="off"
				spellcheck={false}
				placeholder={addType === 'slack'
					? 'https://hooks.slack.com/services/…'
					: 'https://discord.com/api/webhooks/…'}
			/>
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" disabled={adding} onclick={() => (addOpen = false)}
			>Cancel</Button
		>
		<Button
			variant="primary"
			shape="capsule"
			loading={adding}
			disabled={!addUrl.trim()}
			onclick={submitDestination}>Add webhook</Button
		>
	{/snippet}
</Modal>

<style>
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
