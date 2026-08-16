<script lang="ts">
	import { BellOff, Loader2, Plus, Trash2, VolumeX } from 'lucide-svelte';
	import { Badge, Button, EmptyState, Field, Input, Select } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { toasts } from '$lib/stores';
	import {
		createChannel,
		createRule,
		deleteRule as deleteRuleRequest,
		fetchScopeChannels,
		fetchRules
	} from './api';
	import { CHANNEL_TYPE_META } from './channel-types';
	import {
		defaultEventsForScope,
		eventGroupsForScope,
		scopeNoun,
		type ChannelType,
		type NotificationRule,
		type NotificationScopeType,
		type ScopedChannel
	} from './types';

	const NEW_CHANNEL = '__new__';

	let {
		organizationId,
		scopeType,
		scopeId = null,
		canEdit = true
	}: {
		organizationId: string;
		scopeType: NotificationScopeType;
		scopeId?: string | null;
		canEdit?: boolean;
	} = $props();

	let loading = $state(true);
	let rules = $state<NotificationRule[]>([]);
	let channels = $state<ScopedChannel[]>([]);
	let busyId = $state<string | null>(null);
	let formOpen = $state(false);
	let saving = $state(false);
	let formChannelId = $state(NEW_CHANNEL);
	let formEvents = $state<string[]>([]);
	let formMute = $state(false);
	let formType = $state<ChannelType>('discord');
	let formName = $state('');
	let formUrl = $state('');
	let formRecipients = $state('');
	let webhookSecret = $state<string | null>(null);

	const groups = $derived(eventGroupsForScope(scopeType));
	const own = $derived(rules.filter((r) => !r.inherited));
	const inherited = $derived(rules.filter((r) => r.inherited));
	const creatingChannel = $derived(formChannelId === NEW_CHANNEL);
	const typeMeta = $derived(CHANNEL_TYPE_META[formType]);
	const canSubmit = $derived(
		formEvents.length > 0 &&
			(creatingChannel
				? formName.trim().length > 0 &&
					(formType === 'email' ? formRecipients.trim().length > 0 : formUrl.trim().length > 0)
				: formChannelId.length > 0)
	);

	async function load() {
		loading = true;
		try {
			rules = await fetchRules(organizationId, scopeType, scopeId);
			channels = await fetchScopeChannels(organizationId, scopeType, scopeId);
		} catch (e) {
			toasts.add({
				title: 'Could not load notification rules',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (organizationId) void load();
	});

	function openCreate() {
		formChannelId = channels[0]?.id ?? NEW_CHANNEL;
		formEvents = defaultEventsForScope(scopeType);
		formMute = false;
		formType = 'discord';
		formName = '';
		formUrl = '';
		formRecipients = '';
		formOpen = true;
	}

	function toggleEvent(value: string) {
		formEvents = formEvents.includes(value)
			? formEvents.filter((e) => e !== value)
			: [...formEvents, value];
	}

	// Muting an inherited rule writes a mute at this scope for the same channel
	// and events, which is exactly what the resolution order expects.
	function openMute(rule: NotificationRule) {
		formChannelId = rule.channelId;
		formEvents = [...rule.events];
		formMute = true;
		formOpen = true;
	}

	// A destination created here belongs to this scope, so someone who admins one
	// app can wire it to their own Discord without an organization admin adding
	// it first. Existing org and project destinations stay in the same picker.
	async function submit() {
		if (!canSubmit || saving) return;
		saving = true;
		try {
			let channelId = formChannelId;
			if (creatingChannel) {
				const created = await createChannel(organizationId, {
					name: formName.trim(),
					type: formType,
					config:
						formType === 'email'
							? {
									recipients: formRecipients
										.split(',')
										.map((r) => r.trim())
										.filter(Boolean)
								}
							: { url: formUrl.trim() },
					scopeType,
					scopeId
				});
				channelId = created.id;
				webhookSecret = created.webhookSecret ?? null;
			}
			await createRule(organizationId, {
				channelId,
				scopeType,
				scopeId,
				events: formEvents,
				mode: formMute ? 'mute' : 'deliver'
			});
			toasts.add({ title: formMute ? 'Channel muted here' : 'Rule added', color: 'success' });
			formOpen = false;
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not save the rule',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove(rule: NotificationRule) {
		if (busyId) return;
		busyId = rule.id;
		try {
			await deleteRuleRequest(organizationId, rule.id);
			rules = rules.filter((r) => r.id !== rule.id);
		} catch (e) {
			toasts.add({
				title: 'Could not delete the rule',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	function summarize(rule: NotificationRule): string {
		const names = rule.events
			.map((e) => groups.flatMap((g) => g.options).find((o) => o.value === e))
			.filter(Boolean);
		if (names.length === 0) return `${rule.events.length} events`;
		if (names.length <= 3) return names.map((o) => o!.label).join(', ');
		return `${names.length} events`;
	}

	function sourceLabel(rule: NotificationRule): string {
		return rule.scopeType === 'org' ? 'from organization' : `from ${scopeNoun(rule.scopeType)}`;
	}
</script>

<div class="nr">
	<div class="nr-head">
		<div class="nr-head-text">
			<h4 class="nr-title">Team channels</h4>
			<p class="nr-sub">
				Shared with everyone in this {scopeNoun(scopeType)}. Your own notifications are separate and
				live in your account settings.
			</p>
		</div>
		{#if canEdit && !loading && !formOpen}
			<Button variant="secondary" size="sm" onclick={openCreate}>
				<Plus class="h-4 w-4" />
				Add channel
			</Button>
		{/if}
	</div>

	{#if webhookSecret}
		<p class="nr-secret">
			Signing secret, shown once: <code>{webhookSecret}</code>
			<button type="button" class="nr-secret-dismiss" onclick={() => (webhookSecret = null)}>
				Dismiss
			</button>
		</p>
	{/if}

	{#if loading}
		<div class="nr-skeleton"></div>
	{:else if rules.length === 0 && !formOpen}
		<EmptyState
			title="No channels are watching this"
			description="Route deploy failures and crashes to a Slack or Discord channel."
		>
			{#snippet icon()}<BellOff size={22} />{/snippet}
			{#if canEdit}
				<Button variant="secondary" size="sm" onclick={openCreate}>
					<Plus class="h-4 w-4" />
					Add channel
				</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="nr-list">
			{#each [...own, ...inherited] as rule, i (rule.id)}
				<div
					class="nr-item"
					class:nr-item-inherited={rule.inherited}
					class:nr-item-muted={rule.mode === 'mute'}
					{@attach motionStagger({ index: i })}
				>
					<div class="nr-item-meta">
						<div class="nr-item-title">
							{#if rule.mode === 'mute'}
								<VolumeX class="h-3.5 w-3.5" />
							{/if}
							<span class="nr-item-name">{rule.channel.name}</span>
							<Badge>{rule.channel.type}</Badge>
							{#if rule.inherited}
								<Badge>{sourceLabel(rule)}</Badge>
							{/if}
							{#if !rule.enabled || !rule.channel.enabled}
								<Badge>Paused</Badge>
							{/if}
						</div>
						<p class="nr-item-sub">
							{rule.mode === 'mute' ? 'Muted for' : 'Gets'}
							{summarize(rule)}
						</p>
					</div>
					{#if canEdit}
						<div class="nr-item-actions">
							{#if rule.inherited && rule.mode === 'deliver'}
								<Button variant="ghost" size="sm" onclick={() => openMute(rule)}>Mute here</Button>
							{:else if !rule.inherited}
								<Button
									variant="ghost"
									size="sm"
									onclick={() => remove(rule)}
									disabled={busyId === rule.id}
									aria-label="Remove rule"
									title="Remove rule"
								>
									{#if busyId === rule.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Trash2 class="h-4 w-4" />
									{/if}
								</Button>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if formOpen && canEdit}
		<div class="nr-form" {@attach motionStagger({ from: { y: 8 } })}>
			{#if formMute}
				<p class="nr-form-note">
					This stops the channel hearing about these events here, without changing the rule it
					inherits from.
				</p>
			{/if}
			<Field label="Channel" for="nr-channel">
				<Select id="nr-channel" bind:value={formChannelId} disabled={formMute}>
					{#each channels as channel (channel.id)}
						<option value={channel.id}>
							{channel.name} ({CHANNEL_TYPE_META[channel.type].label}){channel.own
								? ''
								: ` from ${scopeNoun(channel.scopeType)}`}
						</option>
					{/each}
					<option value={NEW_CHANNEL}>New destination…</option>
				</Select>
			</Field>

			{#if creatingChannel}
				<div class="nr-new">
					<div class="nr-new-row">
						<Field label="Type" for="nr-type">
							<Select id="nr-type" bind:value={formType}>
								{#each Object.entries(CHANNEL_TYPE_META) as [value, meta] (value)}
									<option {value}>{meta.label}</option>
								{/each}
							</Select>
						</Field>
						<Field label="Name" for="nr-name">
							<Input id="nr-name" bind:value={formName} placeholder="#deploys" maxlength={100} />
						</Field>
					</div>
					{#if formType === 'email'}
						<Field label="Recipients" for="nr-recipients" hint="Members of this project only">
							<Input
								id="nr-recipients"
								bind:value={formRecipients}
								placeholder={typeMeta.placeholder}
							/>
						</Field>
					{:else}
						<Field label="Webhook URL" for="nr-url" hint={typeMeta.hint}>
							<Input id="nr-url" bind:value={formUrl} placeholder={typeMeta.placeholder} />
						</Field>
					{/if}
				</div>
			{/if}
			<div class="nr-form-group">
				<span class="nr-form-label">Events</span>
				<div class="nr-event-groups">
					{#each groups as group (group.label)}
						<div class="nr-event-group">
							<span class="nr-event-group-label">{group.label}</span>
							<div class="nr-chips">
								{#each group.options as opt (opt.value)}
									{@const active = formEvents.includes(opt.value)}
									<button
										type="button"
										class="nr-chip nr-chip-{opt.tone}"
										class:nr-chip-active={active}
										aria-pressed={active}
										onclick={() => toggleEvent(opt.value)}
									>
										<span class="nr-chip-dot"></span>
										{opt.label}
									</button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
			<div class="nr-form-actions">
				<Button variant="ghost" size="sm" onclick={() => (formOpen = false)} disabled={saving}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={!canSubmit}>
					{formMute ? 'Mute here' : creatingChannel ? 'Add destination' : 'Add rule'}
				</Button>
			</div>
		</div>
	{/if}
</div>

<style>
	.nr {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.nr-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.nr-head-text {
		min-width: 0;
	}

	.nr-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-fg);
		margin: 0;
	}

	.nr-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.2rem 0 0;
		max-width: 46ch;
	}

	.nr-skeleton {
		height: 3.25rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		opacity: 0.6;
	}

	.nr-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.nr-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.7rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.nr-item-inherited {
		background: transparent;
		border-style: dashed;
	}

	.nr-item-muted .nr-item-name {
		text-decoration: line-through;
		text-decoration-color: var(--text-faint);
	}

	.nr-item-meta {
		min-width: 0;
		flex: 1;
	}

	.nr-item-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		color: var(--text-muted);
	}

	.nr-item-name {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.nr-item-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.2rem 0 0;
	}

	.nr-item-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.nr-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.nr-form-note {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.nr-new {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.nr-new-row {
		display: grid;
		grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
		gap: 0.75rem;
	}

	@media (max-width: 640px) {
		.nr-new-row {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.nr-secret {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--status-warning) 8%, transparent);
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.nr-secret code {
		font-family: var(--font-mono);
		color: var(--text-fg);
		word-break: break-all;
	}

	.nr-secret-dismiss {
		margin-left: auto;
		background: none;
		border: none;
		padding: 0;
		color: var(--text-muted);
		cursor: pointer;
		text-decoration: underline;
	}

	.nr-form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.nr-form-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.nr-event-groups {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.nr-event-group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.nr-event-group-label {
		font-size: 0.6875rem;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.nr-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.nr-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border-default);
		background: transparent;
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color var(--dur-base) ease,
			color var(--dur-base) ease,
			background-color var(--dur-base) ease;
	}

	.nr-chip:hover {
		color: var(--text-fg);
	}

	.nr-chip-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: var(--text-faint);
	}

	.nr-chip-ok.nr-chip-active .nr-chip-dot {
		background: var(--status-success);
	}

	.nr-chip-fail.nr-chip-active .nr-chip-dot {
		background: var(--status-error);
	}

	.nr-chip-active {
		color: var(--text-fg);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.nr-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
