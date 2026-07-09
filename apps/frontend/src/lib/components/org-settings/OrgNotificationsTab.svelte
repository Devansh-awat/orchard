<script lang="ts">
	import {
		Check,
		Copy,
		Loader2,
		Mail,
		MessageSquare,
		Pencil,
		Plus,
		Send,
		Slack,
		Trash2,
		TriangleAlert,
		Webhook
	} from 'lucide-svelte';
	import { Bell } from '@jis3r/icons';
	import { Button, Field, Input, Badge, EmptyState } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';

	import type { NotificationChannel, ChannelPayload } from './notification-types';

	let {
		canEditOrg,
		loading,
		channels = [],
		projects = [],
		saving,
		deletingId,
		testingId,
		togglingId,
		createdSecret,
		onSaveChannel,
		onDeleteChannel,
		onTestChannel,
		onToggleChannel,
		onDismissSecret,
		index = 0
	}: {
		canEditOrg: boolean;
		loading: boolean;
		channels: NotificationChannel[];
		projects: { id: string; name: string }[];
		saving: boolean;
		deletingId: string | null;
		testingId: string | null;
		togglingId: string | null;
		createdSecret: string | null;
		onSaveChannel: (payload: ChannelPayload, channelId: string | null) => Promise<boolean>;
		onDeleteChannel: (channel: NotificationChannel) => void;
		onTestChannel: (id: string) => void;
		onToggleChannel: (id: string, enabled: boolean) => void;
		onDismissSecret: () => void;
		index?: number;
	} = $props();

	const EVENT_GROUPS: { label: string; options: { value: string; label: string; tone: 'ok' | 'fail' }[] }[] = [
		{
			label: 'Deploys',
			options: [
				{ value: 'deploy.succeeded', label: 'Succeeded', tone: 'ok' },
				{ value: 'deploy.failed', label: 'Failed', tone: 'fail' }
			]
		},
		{
			label: 'App health',
			options: [
				{ value: 'pod.crashing', label: 'Crashing', tone: 'fail' },
				{ value: 'pod.recovered', label: 'Recovered', tone: 'ok' }
			]
		},
		{
			label: 'Backups',
			options: [
				{ value: 'backup.completed', label: 'Completed', tone: 'ok' },
				{ value: 'backup.failed', label: 'Failed', tone: 'fail' }
			]
		}
	];

	const TYPE_META: Record<
		string,
		{ label: string; icon: typeof Webhook; placeholder: string; hue: string; hint: string }
	> = {
		discord: {
			label: 'Discord',
			icon: MessageSquare,
			placeholder: 'https://discord.com/api/webhooks/…',
			hue: '#5865f2',
			hint: 'Channel settings → Integrations → Webhooks'
		},
		slack: {
			label: 'Slack',
			icon: Slack,
			placeholder: 'https://hooks.slack.com/services/…',
			hue: '#2eb67d',
			hint: 'Slack app → Incoming Webhooks'
		},
		webhook: {
			label: 'Webhook',
			icon: Webhook,
			placeholder: 'https://example.com/orchard-hook',
			hue: '#8b8ea3',
			hint: 'Signed JSON POST to any HTTPS endpoint'
		},
		email: {
			label: 'Email',
			icon: Mail,
			placeholder: 'alerts@example.com, oncall@example.com',
			hue: '#d99a2b',
			hint: 'Sent to org members only'
		}
	};

	let formOpen = $state(false);
	let editingId = $state<string | null>(null);
	let formType = $state('discord');
	let formName = $state('');
	let formUrl = $state('');
	let formRecipients = $state('');
	let formEvents = $state<string[]>(['deploy.failed', 'pod.crashing', 'backup.failed']);
	let formScope = $state<'all' | 'custom'>('all');
	let formProjectIds = $state<string[]>([]);

	function openCreate() {
		editingId = null;
		formType = 'discord';
		formName = '';
		formUrl = '';
		formRecipients = '';
		formEvents = ['deploy.failed', 'pod.crashing', 'backup.failed'];
		formScope = 'all';
		formProjectIds = [];
		formOpen = true;
	}

	function openEdit(channel: NotificationChannel) {
		editingId = channel.id;
		formType = channel.type;
		formName = channel.name;
		formUrl = '';
		formRecipients = (channel.config.recipients || []).join(', ');
		formEvents = [...channel.events];
		formScope = channel.projectIds && channel.projectIds.length > 0 ? 'custom' : 'all';
		formProjectIds = channel.projectIds ? [...channel.projectIds] : [];
		formOpen = true;
	}

	function toggleEvent(value: string) {
		formEvents = formEvents.includes(value)
			? formEvents.filter((e) => e !== value)
			: [...formEvents, value];
	}

	function toggleProject(id: string) {
		formProjectIds = formProjectIds.includes(id)
			? formProjectIds.filter((p) => p !== id)
			: [...formProjectIds, id];
	}

	const formValid = $derived(
		formName.trim().length > 0 &&
			formEvents.length > 0 &&
			(formType === 'email'
				? formRecipients.trim().length > 0
				: formUrl.trim().length > 0 || editingId !== null) &&
			(formScope === 'all' || formProjectIds.length > 0)
	);

	const editingChannel = $derived(channels.find((c) => c.id === editingId) ?? null);

	let copiedSecret = $state(false);

	async function copySecret() {
		if (!createdSecret) return;
		try {
			await navigator.clipboard.writeText(createdSecret);
			copiedSecret = true;
			setTimeout(() => (copiedSecret = false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	async function submit() {
		if (!formValid || saving) return;
		const payload: ChannelPayload = {
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
					: { url: formUrl.trim() || undefined },
			events: formEvents,
			projectIds: formScope === 'all' ? null : formProjectIds
		};
		const ok = await onSaveChannel(payload, editingId);
		if (ok) formOpen = false;
	}

	function scopeSummary(channel: NotificationChannel): string {
		if (!channel.projectIds || channel.projectIds.length === 0) return 'All projects';
		const names = channel.projectIds
			.map((id) => projects.find((p) => p.id === id)?.name)
			.filter(Boolean);
		if (names.length === 0) return `${channel.projectIds.length} projects`;
		if (names.length <= 2) return names.join(', ');
		return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
	}

	function deliveryTone(channel: NotificationChannel): 'ok' | 'fail' | 'none' {
		if (!channel.lastDelivery) return 'none';
		return channel.lastDelivery.status === 'sent' ? 'ok' : 'fail';
	}

	function deliverySummary(channel: NotificationChannel): string {
		if (!channel.lastDelivery) return '';
		const verb = channel.lastDelivery.status === 'sent' ? 'delivered' : 'failed';
		return `${verb} ${formatRelativeTime(new Date(channel.lastDelivery.createdAt))}`;
	}
</script>

<SettingsSection
	title="Notifications"
	description="Send deploy, crash, and backup alerts to Discord, Slack, email, or webhooks"
	iconColor="primary"
	{index}
>
	{#snippet icon(hovered)}<Bell size={18} animate={hovered} />{/snippet}
	{#snippet actions()}
		{#if canEditOrg && !loading && (channels.length > 0 || formOpen)}
			<Button variant="secondary" size="sm" onclick={openCreate}>
				<Plus class="h-4 w-4" />
				Add channel
			</Button>
		{/if}
	{/snippet}

	{#if loading}
		<div class="nc-loading">
			<div class="nc-skeleton"></div>
			<div class="nc-skeleton"></div>
		</div>
	{:else}
		{#if createdSecret}
			<div class="nc-secret-reveal" {@attach motionStagger({ from: { y: 6 } })}>
				<div class="nc-secret-head">
					<TriangleAlert class="h-4 w-4" />
				<span>Webhook signing secret. Copy it now, it won't be shown again.</span>
				</div>
				<div class="nc-secret-row">
					<Input class="nc-secret-input" value={createdSecret} readonly />
					<Button variant="secondary" size="sm" onclick={copySecret}>
						{#if copiedSecret}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
						{copiedSecret ? 'Copied' : 'Copy'}
					</Button>
				</div>
				<p class="nc-hint">
					Each delivery is signed: <code
						>x-orchard-signature: sha256=HMAC(secret, timestamp + "." + body)</code
					>
					with the timestamp in <code>x-orchard-timestamp</code>.
				</p>
				<Button variant="ghost" size="sm" onclick={onDismissSecret}>Done</Button>
			</div>
		{/if}

		{#if channels.length === 0 && !formOpen}
			<EmptyState
				title="No channels yet"
				description="Get pinged when a deploy fails, an app starts crashing, or a backup finishes."
			>
				{#snippet icon()}<Bell size={22} />{/snippet}
				{#if canEditOrg}
					<Button variant="secondary" size="sm" onclick={openCreate}>
						<Plus class="h-4 w-4" />
						Add channel
					</Button>
				{/if}
			</EmptyState>
		{/if}

		{#if channels.length > 0}
			<div class="nc-list">
				{#each channels as channel, i (channel.id)}
					{@const meta = TYPE_META[channel.type]}
					{@const tone = deliveryTone(channel)}
					<div
						class="nc-item"
						class:nc-item-disabled={!channel.enabled}
						style="--nc-hue: {meta.hue}"
						{@attach motionStagger({ index: i, stride: 0.05 })}
					>
						<div class="nc-item-icon">
							<meta.icon size={15} />
						</div>
						<div class="nc-item-meta">
							<div class="nc-item-title">
								<span class="nc-item-name">{channel.name}</span>
								<Badge>{meta.label}</Badge>
								{#if !channel.enabled}
									<Badge>Paused</Badge>
								{/if}
							</div>
							<p class="nc-item-sub">
								{channel.events.length}
								{channel.events.length === 1 ? 'event' : 'events'} · {scopeSummary(channel)}
								{#if channel.config.urlPreview}
									· <span class="nc-url-preview">{channel.config.urlPreview}</span>
								{/if}
								{#if channel.lastDelivery}
									· <span
										class="nc-delivery nc-delivery-{tone}"
										title={channel.lastDelivery.error || undefined}
										><span class="nc-dot"></span>{deliverySummary(channel)}</span
									>
								{/if}
							</p>
						</div>
						{#if canEditOrg}
							<div class="nc-item-actions">
								<Button
									variant="ghost"
									size="sm"
									onclick={() => onTestChannel(channel.id)}
									disabled={testingId === channel.id}
									aria-label="Send test notification"
									title="Send test notification"
								>
									{#if testingId === channel.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Send class="h-4 w-4" />
									{/if}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => onToggleChannel(channel.id, !channel.enabled)}
									disabled={togglingId === channel.id}
								>
									{channel.enabled ? 'Pause' : 'Resume'}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => openEdit(channel)}
									aria-label="Edit channel"
									title="Edit channel"
								>
									<Pencil class="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => onDeleteChannel(channel)}
									disabled={deletingId === channel.id}
									aria-label="Delete channel"
									title="Delete channel"
								>
									{#if deletingId === channel.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Trash2 class="h-4 w-4" />
									{/if}
								</Button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if formOpen && canEditOrg}
			<div class="nc-form" {@attach motionStagger({ from: { y: 10 } })}>
				<div class="nc-form-group">
					<span class="nc-form-label">Send to</span>
					<div class="nc-type-grid" role="radiogroup" aria-label="Channel type">
						{#each Object.entries(TYPE_META) as [value, meta] (value)}
							<button
								type="button"
								role="radio"
								aria-checked={formType === value}
								class="nc-type-tile"
								class:nc-type-tile-active={formType === value}
								style="--nc-hue: {meta.hue}"
								disabled={editingId !== null && formType !== value}
								onclick={() => (formType = value)}
							>
								<span class="nc-type-tile-icon"><meta.icon size={16} /></span>
								<span class="nc-type-tile-text">
									<span class="nc-type-tile-label">{meta.label}</span>
									<span class="nc-type-tile-hint">{meta.hint}</span>
								</span>
							</button>
						{/each}
					</div>
				</div>

				<Field label="Name" for="nc-name">
					<Input id="nc-name" bind:value={formName} placeholder="#deploys" maxlength={100} />
				</Field>

				{#if formType === 'email'}
					<Field label="Recipients (comma-separated)" for="nc-recipients">
						<Input
							id="nc-recipients"
							bind:value={formRecipients}
							placeholder={TYPE_META.email.placeholder}
						/>
					</Field>
					<p class="nc-hint">Recipients must be members of this organization.</p>
				{:else}
					<Field label="Webhook URL" for="nc-url">
						<Input
							id="nc-url"
							bind:value={formUrl}
							placeholder={editingId && editingChannel?.config.urlConfigured
								? `${editingChannel.config.urlPreview ?? 'configured'} (leave blank to keep)`
								: TYPE_META[formType].placeholder}
						/>
					</Field>
				{/if}

				<div class="nc-form-group">
					<span class="nc-form-label">Events</span>
					<div class="nc-event-groups">
						{#each EVENT_GROUPS as group (group.label)}
							<div class="nc-event-group">
								<span class="nc-event-group-label">{group.label}</span>
								<div class="nc-chips">
									{#each group.options as opt (opt.value)}
										{@const active = formEvents.includes(opt.value)}
										<button
											type="button"
											class="nc-chip nc-chip-{opt.tone}"
											class:nc-chip-active={active}
											aria-pressed={active}
											onclick={() => toggleEvent(opt.value)}
										>
											<span class="nc-chip-dot"></span>
											{opt.label}
										</button>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>

				<div class="nc-form-group">
					<span class="nc-form-label">Projects</span>
					<div class="nc-seg" role="radiogroup" aria-label="Project scope">
						<button
							type="button"
							role="radio"
							aria-checked={formScope === 'all'}
							class="nc-seg-btn"
							class:nc-seg-btn-active={formScope === 'all'}
							onclick={() => (formScope = 'all')}
						>
							All projects
						</button>
						<button
							type="button"
							role="radio"
							aria-checked={formScope === 'custom'}
							class="nc-seg-btn"
							class:nc-seg-btn-active={formScope === 'custom'}
							onclick={() => (formScope = 'custom')}
						>
							Specific projects
						</button>
					</div>
					{#if formScope === 'custom'}
						{#if projects.length === 0}
							<p class="nc-hint">No projects in this organization yet.</p>
						{:else}
							<div class="nc-chips">
								{#each projects as project (project.id)}
									{@const active = formProjectIds.includes(project.id)}
									<button
										type="button"
										class="nc-chip"
										class:nc-chip-active={active}
										aria-pressed={active}
										onclick={() => toggleProject(project.id)}
									>
										{#if active}<Check size={12} />{/if}
										{project.name}
									</button>
								{/each}
							</div>
						{/if}
					{/if}
				</div>

				<div class="nc-form-actions">
					<Button variant="ghost" size="sm" onclick={() => (formOpen = false)} disabled={saving}>
						Cancel
					</Button>
					<Button
						variant="primary"
						size="sm"
						onclick={submit}
						loading={saving}
						disabled={!formValid}
					>
						{editingId ? 'Save channel' : 'Add channel'}
					</Button>
				</div>
			</div>
		{/if}
	{/if}
</SettingsSection>

<style>
	.nc-loading {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.5rem 0;
	}

	.nc-skeleton {
		height: 3.25rem;
		border-radius: 0.625rem;
		background: linear-gradient(
			100deg,
			color-mix(in srgb, var(--center-channel-color) 3%, transparent) 40%,
			color-mix(in srgb, var(--center-channel-color) 7%, transparent) 50%,
			color-mix(in srgb, var(--center-channel-color) 3%, transparent) 60%
		);
		background-size: 200% 100%;
		animation: nc-shimmer 1.4s ease infinite;
	}

	@keyframes nc-shimmer {
		to {
			background-position: -200% 0;
		}
	}

	.nc-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.5rem 0;
	}

	.nc-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.nc-item:hover {
		border-color: color-mix(in srgb, var(--nc-hue) 30%, var(--surface-border));
		background: color-mix(in srgb, var(--center-channel-color) 3.5%, transparent);
	}

	.nc-item-disabled {
		opacity: 0.6;
	}

	.nc-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--nc-hue) 12%, transparent);
		color: color-mix(in srgb, var(--nc-hue) 80%, var(--center-channel-color));
		flex-shrink: 0;
	}

	.nc-item-meta {
		min-width: 0;
		flex: 1;
	}

	.nc-item-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.nc-item-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nc-item-sub {
		font-size: 0.7rem;
		color: var(--surface-muted);
		margin: 0.15rem 0 0;
	}

	.nc-url-preview {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.68rem;
	}

	.nc-delivery {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.nc-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: currentColor;
	}

	.nc-delivery-ok {
		color: var(--online-indicator, #22c55e);
	}

	.nc-delivery-fail {
		color: var(--error-text, #ef4444);
	}

	.nc-secret-reveal {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		margin: 0.5rem 0;
		padding: 0.875rem 1rem;
		border-radius: 0.625rem;
		background: color-mix(in srgb, var(--away-indicator) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--away-indicator) 25%, transparent);
	}

	.nc-secret-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--away-indicator);
	}

	.nc-secret-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nc-secret-row :global(.nc-secret-input) {
		flex: 1;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.78rem;
	}

	.nc-secret-reveal :global(.btn) {
		align-self: flex-start;
	}

	.nc-secret-reveal code {
		font-size: 0.7rem;
	}

	.nc-item-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
	}

	.nc-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 0.5rem;
		padding: 1rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}

	.nc-form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.nc-form-label {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.nc-type-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
	}

	.nc-type-tile {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: transparent;
		cursor: pointer;
		text-align: left;
		font: inherit;
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.nc-type-tile:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--nc-hue) 40%, var(--surface-border));
		background: color-mix(in srgb, var(--nc-hue) 4%, transparent);
	}

	.nc-type-tile:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--button-bg, #6366f1) 60%, transparent);
		outline-offset: 2px;
	}

	.nc-type-tile:active:not(:disabled) {
		transform: scale(0.98);
	}

	.nc-type-tile:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.nc-type-tile-active {
		border-color: color-mix(in srgb, var(--nc-hue) 55%, transparent);
		background: color-mix(in srgb, var(--nc-hue) 8%, transparent);
	}

	.nc-type-tile-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--nc-hue) 14%, transparent);
		color: color-mix(in srgb, var(--nc-hue) 85%, var(--center-channel-color));
		flex-shrink: 0;
	}

	.nc-type-tile-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.nc-type-tile-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nc-type-tile-hint {
		font-size: 0.68rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nc-event-groups {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.75rem;
	}

	.nc-event-group {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.nc-event-group-label {
		font-size: 0.72rem;
		font-weight: 500;
		color: var(--surface-muted);
	}

	.nc-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.nc-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.65rem;
		border-radius: 999px;
		border: 1px solid var(--surface-border);
		background: transparent;
		font: inherit;
		font-size: 0.75rem;
		color: var(--surface-muted);
		cursor: pointer;
		user-select: none;
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease,
			color 0.2s ease;
	}

	.nc-chip:hover {
		border-color: color-mix(in srgb, var(--center-channel-color) 25%, transparent);
		color: var(--center-channel-color);
	}

	.nc-chip:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--button-bg, #6366f1) 60%, transparent);
		outline-offset: 2px;
	}

	.nc-chip:active {
		transform: scale(0.97);
	}

	.nc-chip-active {
		border-color: color-mix(in srgb, var(--button-bg, #6366f1) 45%, transparent);
		background: color-mix(in srgb, var(--button-bg, #6366f1) 10%, transparent);
		color: var(--center-channel-color);
	}

	.nc-chip-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--center-channel-color) 25%, transparent);
		transition: background-color 0.2s ease;
	}

	.nc-chip-ok.nc-chip-active .nc-chip-dot {
		background: var(--online-indicator, #22c55e);
	}

	.nc-chip-fail.nc-chip-active .nc-chip-dot {
		background: var(--error-text, #ef4444);
	}

	.nc-chip-ok.nc-chip-active {
		border-color: color-mix(in srgb, var(--online-indicator, #22c55e) 40%, transparent);
		background: color-mix(in srgb, var(--online-indicator, #22c55e) 8%, transparent);
	}

	.nc-chip-fail.nc-chip-active {
		border-color: color-mix(in srgb, var(--error-text, #ef4444) 40%, transparent);
		background: color-mix(in srgb, var(--error-text, #ef4444) 8%, transparent);
	}

	.nc-seg {
		display: inline-flex;
		align-self: flex-start;
		padding: 0.125rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--center-channel-color) 3%, transparent);
	}

	.nc-seg-btn {
		padding: 0.3rem 0.75rem;
		border: none;
		border-radius: 0.375rem;
		background: transparent;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}

	.nc-seg-btn:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--button-bg, #6366f1) 60%, transparent);
		outline-offset: 1px;
	}

	.nc-seg-btn-active {
		background: var(--center-channel-bg, #fff);
		color: var(--center-channel-color);
		box-shadow: 0 1px 2px color-mix(in srgb, var(--center-channel-color) 12%, transparent);
	}

	.nc-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.nc-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	@media (max-width: 640px) {
		.nc-item {
			flex-wrap: wrap;
		}

		.nc-item-actions {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
