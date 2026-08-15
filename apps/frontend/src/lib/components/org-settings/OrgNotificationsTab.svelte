<script lang="ts">
	import { Check, Copy, History, Loader2, Pencil, Plus, Send, Trash2, TriangleAlert } from 'lucide-svelte';
	import { Bell } from '@jis3r/icons';
	import { Button, Field, Input, Badge, EmptyState } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';
	import { CHANNEL_TYPE_META, NotificationRules, replayChannel } from '$lib/components/notifications';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { toasts } from '$lib/stores';

	import type { NotificationChannel, ChannelPayload } from './notification-types';

	let {
		canEditOrg,
		organizationId,
		loading,
		channels = [],
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
		organizationId: string;
		loading: boolean;
		channels: NotificationChannel[];
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

	let formOpen = $state(false);
	let editingId = $state<string | null>(null);
	let formType = $state('discord');
	let formName = $state('');
	let formUrl = $state('');
	let formRecipients = $state('');
	let replayingId = $state<string | null>(null);

	function openCreate() {
		editingId = null;
		formType = 'discord';
		formName = '';
		formUrl = '';
		formRecipients = '';
		formOpen = true;
	}

	function openEdit(channel: NotificationChannel) {
		editingId = channel.id;
		formType = channel.type;
		formName = channel.name;
		formUrl = '';
		formRecipients = (channel.config.recipients || []).join(', ');
		formOpen = true;
	}

	const formValid = $derived(
		formName.trim().length > 0 &&
			(formType === 'email'
				? formRecipients.trim().length > 0
				: formUrl.trim().length > 0 || editingId !== null)
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
					: { url: formUrl.trim() || undefined }
		};
		const ok = await onSaveChannel(payload, editingId);
		if (ok) formOpen = false;
	}

	// The events were stored even while delivery was failing, so a channel that
	// was pointed at a dead webhook can be handed everything it missed.
	async function replay(channel: NotificationChannel) {
		if (replayingId) return;
		replayingId = channel.id;
		try {
			const result = await replayChannel(organizationId, channel.id, 24);
			toasts.add({
				title:
					result.queued > 0
						? `Queued ${result.queued} ${result.queued === 1 ? 'notification' : 'notifications'}`
						: 'Nothing to replay from the last 24 hours',
				description: result.message,
				color: result.queued > 0 ? 'success' : 'info'
			});
		} catch (e) {
			toasts.add({
				title: 'Could not replay',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			replayingId = null;
		}
	}

	function healthSummary(channel: NotificationChannel): string | null {
		const health = channel.health;
		if (!health) return null;
		if (health.state === 'auto_disabled') {
			return 'turned off after a day of failures';
		}
		if (health.state === 'paused' && health.until) {
			return `paused until ${formatRelativeTime(new Date(health.until))}`;
		}
		if (health.state === 'failing') {
			return health.since
				? `failing since ${formatRelativeTime(new Date(health.since))}`
				: 'failing';
		}
		if (channel.lastDelivery) {
			const verb = channel.lastDelivery.status === 'sent' ? 'delivered' : 'failed';
			return `${verb} ${formatRelativeTime(new Date(channel.lastDelivery.createdAt))}`;
		}
		return null;
	}

	function healthTone(channel: NotificationChannel): 'ok' | 'fail' | 'warn' | 'none' {
		const state = channel.health?.state;
		if (state === 'auto_disabled' || state === 'failing') return 'fail';
		if (state === 'paused') return 'warn';
		if (channel.lastDelivery) return channel.lastDelivery.status === 'sent' ? 'ok' : 'fail';
		return 'none';
	}
</script>

<SettingsSection
	title="Notifications"
	description="Destinations for deploy, crash, and backup alerts. Rules decide what each one receives"
	{index}
>
	{#snippet icon(hovered)}<Bell size={18} animate={hovered} />{/snippet}
	{#snippet actions()}
		{#if canEditOrg && !loading && (channels.length > 0 || formOpen)}
			<Button variant="secondary" size="sm" onclick={openCreate}>
				<Plus class="h-4 w-4" />
				Add destination
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
				title="No destinations yet"
				description="Add a Slack or Discord channel, then write a rule to say what it should receive."
			>
				{#snippet icon()}<Bell size={22} />{/snippet}
				{#if canEditOrg}
					<Button variant="secondary" size="sm" onclick={openCreate}>
						<Plus class="h-4 w-4" />
						Add destination
					</Button>
				{/if}
			</EmptyState>
		{/if}

		{#if channels.length > 0}
			<div class="nc-list">
				{#each channels as channel, i (channel.id)}
					{@const meta = CHANNEL_TYPE_META[channel.type]}
					{@const tone = healthTone(channel)}
					{@const summary = healthSummary(channel)}
					<div
						class="nc-item"
						class:nc-item-disabled={!channel.enabled}
						style="--nc-hue: {meta.hue}"
						{@attach motionStagger({ index: i })}
					>
						<div class="nc-item-icon">
							<meta.icon size={15} />
						</div>
						<div class="nc-item-meta">
							<div class="nc-item-title">
								<span class="nc-item-name">{channel.name}</span>
								<Badge>{meta.label}</Badge>
								{#if channel.scopeLabel}
									<Badge>{channel.scopeLabel}</Badge>
								{/if}
								{#if channel.health?.state === 'auto_disabled'}
									<Badge>Turned off</Badge>
								{:else if !channel.enabled}
									<Badge>Paused</Badge>
								{/if}
							</div>
							<p class="nc-item-sub">
								{channel.ruleCount}
								{channel.ruleCount === 1 ? 'rule' : 'rules'}
								{#if channel.config.urlPreview}
									· <span class="nc-url-preview">{channel.config.urlPreview}</span>
								{/if}
								{#if summary}
									· <span
										class="nc-delivery nc-delivery-{tone}"
										title={channel.lastDelivery?.error || undefined}
										><span class="nc-dot"></span>{summary}</span
									>
								{/if}
							</p>
							{#if channel.ruleCount === 0}
								<p class="nc-item-warn">
									Nothing routes here yet. Add a rule below or on an app to start sending.
								</p>
							{/if}
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
									onclick={() => replay(channel)}
									disabled={replayingId === channel.id || !channel.enabled}
									aria-label="Replay the last 24 hours"
									title="Replay the last 24 hours"
								>
									{#if replayingId === channel.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<History class="h-4 w-4" />
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
									aria-label="Edit destination"
									title="Edit destination"
								>
									<Pencil class="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => onDeleteChannel(channel)}
									disabled={deletingId === channel.id}
									aria-label="Delete destination"
									title="Delete destination"
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
					<div class="nc-type-grid" role="radiogroup" aria-label="Destination type">
						{#each Object.entries(CHANNEL_TYPE_META) as [value, meta] (value)}
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
							placeholder={CHANNEL_TYPE_META.email.placeholder}
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
								: CHANNEL_TYPE_META[formType].placeholder}
						/>
					</Field>
				{/if}

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
						{editingId ? 'Save destination' : 'Add destination'}
					</Button>
				</div>
			</div>
		{/if}

		{#if channels.length > 0}
			<div class="nc-rules">
				<NotificationRules {organizationId} scopeType="org" canEdit={canEditOrg} />
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
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		opacity: 0.6;
		animation: nc-shimmer 1.4s ease infinite;
	}

	@keyframes nc-shimmer {
		50% {
			opacity: 0.35;
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
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
		transition:
			border-color var(--dur-base) ease,
			background-color var(--dur-base) ease;
	}

	.nc-item:hover {
		border-color: color-mix(in srgb, var(--nc-hue) 30%, var(--border-default));
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
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--nc-hue) 12%, transparent);
		color: color-mix(in srgb, var(--nc-hue) 80%, var(--text-fg));
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
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.nc-item-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.2rem 0 0;
	}

	.nc-item-warn {
		font-size: 0.6875rem;
		color: var(--status-warning);
		margin: 0.25rem 0 0;
	}

	.nc-url-preview {
		font-family: var(--font-mono, ui-monospace, monospace);
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
		background: var(--text-faint);
	}

	.nc-delivery-ok .nc-dot {
		background: var(--status-success);
	}

	.nc-delivery-fail .nc-dot {
		background: var(--status-error);
	}

	.nc-delivery-warn .nc-dot {
		background: var(--status-warning);
	}

	.nc-item-actions {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		flex-shrink: 0;
	}

	.nc-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.nc-form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.nc-form-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.nc-type-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.5rem;
	}

	.nc-type-tile {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.6rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition:
			border-color var(--dur-base) ease,
			background-color var(--dur-base) ease;
	}

	.nc-type-tile:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.nc-type-tile-active {
		border-color: color-mix(in srgb, var(--nc-hue) 45%, var(--border-default));
		background: color-mix(in srgb, var(--nc-hue) 8%, transparent);
	}

	.nc-type-tile-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--nc-hue) 12%, transparent);
		color: color-mix(in srgb, var(--nc-hue) 80%, var(--text-fg));
		flex-shrink: 0;
	}

	.nc-type-tile-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.nc-type-tile-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.nc-type-tile-hint {
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	.nc-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.nc-hint code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.6875rem;
	}

	.nc-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.nc-secret-reveal {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--status-warning-border);
		background: var(--status-warning-bg);
	}

	.nc-secret-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.nc-secret-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nc-rules {
		padding-top: 0.75rem;
		margin-top: 0.25rem;
		border-top: 1px solid var(--border-default);
	}
</style>
