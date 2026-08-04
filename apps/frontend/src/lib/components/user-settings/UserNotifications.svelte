<script lang="ts">
	import { Loader2, Mail, MessageSquare, Plus, Send, Slack, Trash2, Webhook } from 'lucide-svelte';
	import { Bell } from '@jis3r/icons';
	import { Badge, Button, EmptyState, Field, Input, Select } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
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
		SETTING_LABELS,
		type NotificationCategory,
		type SettingValue,
		type UserDestination,
		type UserSettings
	} from '$lib/components/notifications/types';

	let { index = 0 }: { index?: number } = $props();

	const CATEGORIES: NotificationCategory[] = ['deploys', 'health', 'jobs', 'data'];

	const DEST_META: Record<string, { label: string; icon: typeof Webhook; hue: string }> = {
		email: { label: 'Email', icon: Mail, hue: 'var(--hue-amber)' },
		slack: { label: 'Slack', icon: Slack, hue: 'var(--hue-green)' },
		discord: { label: 'Discord', icon: MessageSquare, hue: 'var(--hue-violet)' }
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
		if (savingCategory) return;
		savingCategory = category;
		try {
			settings = await saveGlobalSettings({ [category]: value });
		} catch (e) {
			toasts.add({
				title: 'Could not save that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingCategory = null;
		}
	}

	async function clearOverride(override: UserSettings['overrides'][number]) {
		const key = `${override.scopeType}:${override.scopeId}`;
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
		return Object.entries(override.values)
			.map(([category, value]) => {
				const label = CATEGORY_LABELS[category as NotificationCategory] ?? category;
				return `${label}: ${SETTING_LABELS[value as SettingValue]?.label ?? value}`;
			})
			.join(' · ');
	}

	function destStatus(dest: UserDestination): string | null {
		if (dest.circuitOpenUntil && new Date(dest.circuitOpenUntil).getTime() > Date.now()) {
			return `paused until ${formatRelativeTime(new Date(dest.circuitOpenUntil))}`;
		}
		if (dest.consecutiveFailures > 0 && dest.lastErrorAt) {
			return `failing since ${formatRelativeTime(new Date(dest.lastErrorAt))}`;
		}
		if (dest.lastSuccessAt) {
			return `last delivered ${formatRelativeTime(new Date(dest.lastSuccessAt))}`;
		}
		return null;
	}

	const webhookCount = $derived(destinations.filter((d) => d.type !== 'email').length);
</script>

<SettingsSection
	title="Notifications"
	description="What Orchard tells you about, and where. Only affects you"
	{index}
>
	{#snippet icon(hovered)}<Bell size={18} animate={hovered} />{/snippet}

	{#if loading}
		<div class="un-skeleton"></div>
	{:else if settings}
		<div class="un-block">
			<div class="un-block-head">
				<h4 class="un-block-title">Your defaults</h4>
				<p class="un-block-sub">
					What counts as yours, once you have turned on somewhere to receive it below. Applies
					everywhere unless you override it on a specific project or app. Team channels your
					organization set up are separate and are not affected by this.
				</p>
			</div>
			<div class="un-rows">
				{#each CATEGORIES as category (category)}
					<div class="un-row">
						<div class="un-row-meta">
							<span class="un-row-label">{CATEGORY_LABELS[category]}</span>
							<span class="un-row-hint">{SETTING_LABELS[settings.global[category]].hint}</span>
						</div>
						<div class="un-seg" role="radiogroup" aria-label={CATEGORY_LABELS[category]}>
							{#each ['always', 'subscribed', 'never'] as const as option (option)}
								<button
									type="button"
									role="radio"
									aria-checked={settings.global[category] === option}
									class="un-seg-btn"
									class:un-seg-btn-active={settings.global[category] === option}
									disabled={savingCategory === category}
									title={SETTING_LABELS[option].hint}
									onclick={() => choose(category, option)}
								>
									{SETTING_LABELS[option].label}
								</button>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<div class="un-block">
			<div class="un-block-head">
				<h4 class="un-block-title">Where they go</h4>
				<p class="un-block-sub">
					Everything here is off until you turn it on, so Orchard sends you nothing by default. Your
					account email plus any personal Slack or Discord webhook you add, up to three.
				</p>
			</div>
			<div class="un-rows">
				{#each destinations as dest, i (dest.id)}
					{@const meta = DEST_META[dest.type]}
					{@const status = destStatus(dest)}
					<div
						class="un-dest"
						class:un-dest-off={!dest.enabled}
						style="--un-hue: {meta.hue}"
						{@attach motionStagger({ index: i })}
					>
						<div class="un-dest-icon"><meta.icon size={15} /></div>
						<div class="un-row-meta">
							<div class="un-dest-title">
								<span class="un-row-label">{meta.label}</span>
								{#if !dest.enabled}<Badge>Off</Badge>{/if}
							</div>
							{#if status}
								<span class="un-row-hint">{status}</span>
							{/if}
						</div>
						<div class="un-dest-actions">
							<Button
								variant="ghost"
								size="sm"
								onclick={() => test(dest)}
								disabled={busyId === dest.id}
								aria-label="Send a test"
								title="Send a test"
							>
								{#if busyId === dest.id}
									<Loader2 class="h-4 w-4 animate-spin" />
								{:else}
									<Send class="h-4 w-4" />
								{/if}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => toggleDestination(dest)}
								disabled={busyId === dest.id}
							>
								{dest.enabled ? 'Turn off' : 'Turn on'}
							</Button>
							{#if dest.type !== 'email'}
								<Button
									variant="ghost"
									size="sm"
									onclick={() => removeDestination(dest)}
									disabled={busyId === dest.id}
									aria-label="Remove"
									title="Remove"
								>
									<Trash2 class="h-4 w-4" />
								</Button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
			{#if addOpen}
				<div class="un-add" {@attach motionStagger({ from: { y: 8 } })}>
					<Field label="Type" for="un-dest-type">
						<Select id="un-dest-type" bind:value={addType}>
							<option value="slack">Slack</option>
							<option value="discord">Discord</option>
						</Select>
					</Field>
					<Field label="Webhook URL" for="un-dest-url">
						<Input
							id="un-dest-url"
							bind:value={addUrl}
							placeholder={addType === 'slack'
								? 'https://hooks.slack.com/services/…'
								: 'https://discord.com/api/webhooks/…'}
						/>
					</Field>
					<div class="un-add-actions">
						<Button variant="ghost" size="sm" onclick={() => (addOpen = false)} disabled={adding}>
							Cancel
						</Button>
						<Button
							variant="primary"
							size="sm"
							onclick={submitDestination}
							loading={adding}
							disabled={!addUrl.trim()}
						>
							Add
						</Button>
					</div>
				</div>
			{:else if webhookCount < 3}
				<Button variant="secondary" size="sm" onclick={() => (addOpen = true)}>
					<Plus class="h-4 w-4" />
					Add a personal webhook
				</Button>
			{/if}
		</div>

		<div class="un-block">
			<div class="un-block-head">
				<h4 class="un-block-title">Overrides</h4>
				<p class="un-block-sub">
					Everywhere you have deviated from your defaults. This is the whole list, so nothing is
					muted without showing up here.
				</p>
			</div>
			{#if settings.overrides.length === 0}
				<EmptyState
					title="No overrides"
					description="Your defaults apply everywhere. Change a setting on a project or app to add one."
				>
					{#snippet icon()}<Bell size={22} />{/snippet}
				</EmptyState>
			{:else}
				<div class="un-rows">
					{#each settings.overrides as override, i (`${override.scopeType}:${override.scopeId}`)}
						<div class="un-row" {@attach motionStagger({ index: i })}>
							<div class="un-row-meta">
								<div class="un-dest-title">
									<span class="un-row-label">{override.label}</span>
									<Badge>{override.scopeType}</Badge>
									{#if override.context}
										<span class="un-row-hint">in {override.context}</span>
									{/if}
									{#if override.missing}
										<Badge>Deleted</Badge>
									{/if}
								</div>
								<span class="un-row-hint">{overrideSummary(override)}</span>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => clearOverride(override)}
								disabled={clearingKey === `${override.scopeType}:${override.scopeId}`}
							>
								{#if clearingKey === `${override.scopeType}:${override.scopeId}`}
									<Loader2 class="h-4 w-4 animate-spin" />
								{:else}
									Clear
								{/if}
							</Button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</SettingsSection>

<style>
	.un-skeleton {
		height: 6rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		opacity: 0.6;
	}

	.un-block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 0;
	}

	.un-block + .un-block {
		border-top: 1px solid var(--border-default);
	}

	.un-block-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-fg);
		margin: 0;
	}

	.un-block-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.2rem 0 0;
		max-width: 56ch;
	}

	.un-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.un-row,
	.un-dest {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.7rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.un-dest-off {
		opacity: 0.6;
	}

	.un-dest-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--un-hue) 12%, transparent);
		color: color-mix(in srgb, var(--un-hue) 80%, var(--text-fg));
		flex-shrink: 0;
	}

	.un-dest-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.un-row-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.un-row-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.un-row-hint {
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	.un-dest-actions {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		flex-shrink: 0;
	}

	.un-seg {
		display: inline-flex;
		padding: 0.15rem;
		gap: 0.15rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
	}

	.un-seg-btn {
		padding: 0.25rem 0.6rem;
		border: none;
		border-radius: calc(var(--radius-md) - 0.15rem);
		background: transparent;
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-base) ease,
			color var(--dur-base) ease;
	}

	.un-seg-btn:hover:not(:disabled) {
		color: var(--text-fg);
	}

	.un-seg-btn-active {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text-fg);
	}

	.un-add {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.un-add-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
