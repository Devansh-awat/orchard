<script lang="ts">
	import { KeyRound, Plus, Trash2, VolumeX, Webhook } from 'lucide-svelte';
	import {
		Badge,
		Button,
		Dropdown,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SecretString,
		SectionCard,
		SegmentedControl,
		Skeleton,
		Stack,
		StatusBadge,
		ToneTile,
		statusMeta
	} from '$lib/components/ui';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import { emailEnabled, toasts } from '$lib/stores';
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

	const uid = $props.id();

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

	const isOrg = $derived(scopeType === 'org');
	const addLabel = $derived(isOrg ? 'Add rule' : 'Add channel');
	const groups = $derived(eventGroupsForScope(scopeType));
	const ordered = $derived([
		...rules.filter((r) => !r.inherited),
		...rules.filter((r) => r.inherited)
	]);
	const creatingChannel = $derived(formChannelId === NEW_CHANNEL);
	const typeMeta = $derived(CHANNEL_TYPE_META[formType]);
	const muteTarget = $derived(channels.find((c) => c.id === formChannelId)?.name ?? 'channel');
	const canSubmit = $derived(
		formEvents.length > 0 &&
			(creatingChannel
				? formName.trim().length > 0 &&
					(formType === 'email' ? formRecipients.trim().length > 0 : formUrl.trim().length > 0)
				: formChannelId.length > 0)
	);

	const TYPE_OPTIONS = $derived(
		Object.entries(CHANNEL_TYPE_META).map(([value, meta]) => ({
			value,
			label: meta.label,
			icon: meta.icon,
			disabled: value === 'email' && !$emailEnabled
		}))
	);

	const channelOptions = $derived([
		...channels.map((channel) => ({
			value: channel.id,
			label: channel.name,
			icon: CHANNEL_TYPE_META[channel.type]?.icon,
			description: channel.own
				? CHANNEL_TYPE_META[channel.type]?.label
				: `${CHANNEL_TYPE_META[channel.type]?.label}, from ${scopeNoun(channel.scopeType)}`
		})),
		{ value: NEW_CHANNEL, label: 'New destination', icon: Plus }
	]);

	async function load() {
		loading = true;
		try {
			rules = await fetchRules(organizationId, scopeType, scopeId);
			channels = await fetchScopeChannels(organizationId, scopeType, scopeId);
		} catch (e) {
			toasts.add({
				title: "Couldn't load notification rules",
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

	function toggleEvent(value: string, on: boolean) {
		formEvents = on ? [...formEvents, value] : formEvents.filter((e) => e !== value);
	}

	function openMute(rule: NotificationRule) {
		formChannelId = rule.channelId;
		formEvents = [...rule.events];
		formMute = true;
		formOpen = true;
	}

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
				title: "Couldn't save the rule",
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
				title: "Couldn't delete the rule",
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
		return rule.scopeType === 'org' ? 'From organization' : `From ${scopeNoun(rule.scopeType)}`;
	}

	function typeIcon(type: string) {
		return CHANNEL_TYPE_META[type as ChannelType]?.icon ?? Webhook;
	}
</script>

<SectionCard title={isOrg ? 'Rules' : 'Team channels'}>
	{#snippet actions()}
		{#if canEdit && !loading}
			<Button size="sm" icon={Plus} onclick={openCreate}>{addLabel}</Button>
		{/if}
	{/snippet}
	{#if loading}
		<div class="placeholder">
			<Skeleton height="2.75rem" />
			<Skeleton height="2.75rem" />
		</div>
	{:else if rules.length === 0}
		<p class="quiet">
			{isOrg
				? 'No rules yet, so destinations receive nothing.'
				: `No team channel gets notified about this ${scopeNoun(scopeType)}.`}
		</p>
	{:else}
		<List inset={false} label={isOrg ? 'Rules' : 'Team channels'}>
			{#each ordered as rule (rule.id)}
				{@const Glyph = rule.mode === 'mute' ? VolumeX : typeIcon(rule.channel.type)}
				<ListRow
					flush
					presence
					title={rule.channel.name}
					subtitle={`${rule.mode === 'mute' ? 'Muted for' : 'Gets'} ${summarize(rule)}`}
				>
					{#snippet leading()}<ToneTile size={32}><Glyph size={16} /></ToneTile>{/snippet}
					{#snippet titleSuffix()}
						{#if rule.inherited}<Badge>{sourceLabel(rule)}</Badge>{/if}
						{#if !rule.enabled || !rule.channel.enabled}
							<StatusBadge meta={statusMeta('neutral', 'Paused')} />
						{/if}
					{/snippet}
					{#snippet actions()}
						{#if canEdit && rule.inherited && rule.mode === 'deliver'}
							<Button variant="ghost" size="sm" icon={VolumeX} onclick={() => openMute(rule)}
								>Mute here</Button
							>
						{:else if canEdit && !rule.inherited}
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove rule"
								loading={busyId === rule.id}
								onclick={() => remove(rule)}
							/>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</SectionCard>

{#if canEdit}
	<Modal bind:open={formOpen} title={formMute ? `Mute ${muteTarget} here` : addLabel}>
		<form
			id="{uid}-form"
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<Stack>
				<Field
					label="Channel"
					for="{uid}-channel"
					hint={formMute ? 'The rule it inherits stays as it is.' : undefined}
				>
					<Dropdown
						id="{uid}-channel"
						size="lg"
						bind:value={formChannelId}
						disabled={formMute}
						options={channelOptions}
					/>
				</Field>
				{#if creatingChannel}
					<Field label="Type" hint={$emailEnabled ? undefined : "This instance can't send email"}>
						<SegmentedControl
							label="Destination type"
							options={TYPE_OPTIONS}
							bind:value={formType}
							grow
						/>
					</Field>
					<Field label="Name" for="{uid}-name">
						<Input
							id="{uid}-name"
							size="lg"
							bind:value={formName}
							placeholder="#deploys"
							maxlength={100}
						/>
					</Field>
					{#if formType === 'email'}
						<Field
							label="Recipients"
							for="{uid}-recipients"
							hint="Members of this {scopeNoun(scopeType)} only"
						>
							<Input
								id="{uid}-recipients"
								size="lg"
								bind:value={formRecipients}
								placeholder={typeMeta.placeholder}
							/>
						</Field>
					{:else}
						<Field label="Webhook URL" for="{uid}-url" hint={typeMeta.hint}>
							<Input
								id="{uid}-url"
								size="lg"
								mono
								bind:value={formUrl}
								placeholder={typeMeta.placeholder}
								autocomplete="off"
								spellcheck="false"
							/>
						</Field>
					{/if}
				{/if}
				{#each groups as group (group.label)}
					<Field label={group.label}>
						<div class="events">
							{#each group.options as opt (opt.value)}
								<Checkbox
									label={opt.label}
									checked={formEvents.includes(opt.value)}
									onchange={(on) => toggleEvent(opt.value, on)}
								/>
							{/each}
						</div>
					</Field>
				{/each}
			</Stack>
		</form>
		{#snippet footer()}
			<Button variant="ghost" shape="capsule" onclick={() => (formOpen = false)} disabled={saving}>
				Cancel
			</Button>
			<Button
				type="submit"
				form="{uid}-form"
				variant="primary"
				shape="capsule"
				loading={saving}
				disabled={!canSubmit}
			>
				{formMute ? 'Mute here' : creatingChannel ? 'Add destination' : 'Add rule'}
			</Button>
		{/snippet}
	</Modal>
{/if}

<Modal
	bind:open={
		() => !!webhookSecret,
		(v) => {
			if (!v) webhookSecret = null;
		}
	}
	closable={false}
	labelledby="{uid}-secret"
>
	<Stack>
		<ModalIntro
			id="{uid}-secret"
			icon={KeyRound}
			tone="success"
			solid
			title="Copy the signing secret"
			description="It isn't shown again."
		/>
		<Field label="Signing secret">
			<SecretString
				masked={'•'.repeat(24)}
				resolve={async () => webhookSecret}
				label="Signing secret"
			/>
		</Field>
	</Stack>
	{#snippet footer()}
		<Button variant="primary" shape="capsule" onclick={() => (webhookSecret = null)}>Done</Button>
	{/snippet}
</Modal>

<style>
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.events {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: var(--space-2) var(--space-4);
	}
</style>
