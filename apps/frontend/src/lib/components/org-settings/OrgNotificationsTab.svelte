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
	import { Button, Field, Input, Select, Badge } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

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

	const EVENT_OPTIONS = [
		{ value: 'deploy.succeeded', label: 'Deploy succeeded' },
		{ value: 'deploy.failed', label: 'Deploy failed' },
		{ value: 'pod.crashing', label: 'App crashing' },
		{ value: 'pod.recovered', label: 'App recovered' },
		{ value: 'backup.completed', label: 'Backup completed' },
		{ value: 'backup.failed', label: 'Backup failed' }
	];

	const TYPE_META: Record<string, { label: string; icon: typeof Webhook; placeholder: string }> = {
		discord: {
			label: 'Discord',
			icon: MessageSquare,
			placeholder: 'https://discord.com/api/webhooks/…'
		},
		slack: { label: 'Slack', icon: Slack, placeholder: 'https://hooks.slack.com/services/…' },
		webhook: { label: 'Webhook', icon: Webhook, placeholder: 'https://example.com/orchard-hook' },
		email: { label: 'Email', icon: Mail, placeholder: 'alerts@example.com, oncall@example.com' }
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
</script>

<SettingsSection
	title="Notifications"
	description="Send deploy, crash, and backup alerts to Discord, Slack, email, or webhooks"
	iconColor="primary"
	{index}
>
	{#snippet icon(hovered)}<Bell size={18} animate={hovered} />{/snippet}
	{#snippet actions()}
		{#if canEditOrg && !loading}
			<Button variant="secondary" size="sm" onclick={openCreate}>
				<Plus class="h-4 w-4" />
				Add channel
			</Button>
		{/if}
	{/snippet}

	{#if loading}
		<div class="nc-loading">
			<Loader2 class="h-5 w-5 animate-spin" />
		</div>
	{:else}
		{#if createdSecret}
			<div class="nc-secret-reveal">
				<div class="nc-secret-head">
					<TriangleAlert class="h-4 w-4" />
					<span>Webhook signing secret — copy it now, it won't be shown again.</span>
				</div>
				<div class="nc-secret-row">
					<Input class="nc-secret-input" value={createdSecret} readonly />
					<Button variant="secondary" size="sm" onclick={copySecret}>
						{#if copiedSecret}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
						{copiedSecret ? 'Copied' : 'Copy'}
					</Button>
				</div>
				<p class="nc-hint">
					Each delivery is signed: <code>x-orchard-signature: sha256=HMAC(secret, timestamp +
						"." + body)</code> with the timestamp in <code>x-orchard-timestamp</code>.
				</p>
				<Button variant="ghost" size="sm" onclick={onDismissSecret}>Done</Button>
			</div>
		{/if}

		{#if channels.length === 0 && !formOpen}
			<p class="nc-empty">
				No channels yet. Add one to get pinged when a deploy fails, an app starts crashing, or a
				backup finishes.
			</p>
		{/if}

		{#if channels.length > 0}
			<div class="nc-list">
				{#each channels as channel (channel.id)}
					{@const meta = TYPE_META[channel.type]}
					<div class="nc-item" class:nc-item-disabled={!channel.enabled}>
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
										class="nc-delivery nc-delivery-{deliveryTone(channel)}"
										title={channel.lastDelivery.error || undefined}
										>last delivery {channel.lastDelivery.status}</span
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
			<div class="nc-form">
				<div class="nc-form-row">
					<Field label="Type" for="nc-type">
						<Select id="nc-type" bind:value={formType} disabled={editingId !== null}>
							<option value="discord">Discord</option>
							<option value="slack">Slack</option>
							<option value="webhook">Generic webhook</option>
							<option value="email">Email</option>
						</Select>
					</Field>
					<Field label="Name" for="nc-name">
						<Input id="nc-name" bind:value={formName} placeholder="#deploys" maxlength={100} />
					</Field>
				</div>

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
								? `${editingChannel.config.urlPreview ?? 'configured'} — leave blank to keep`
								: TYPE_META[formType].placeholder}
						/>
					</Field>
				{/if}

				<div class="nc-form-group">
					<span class="nc-form-label">Events</span>
					<div class="nc-checks">
						{#each EVENT_OPTIONS as opt (opt.value)}
							<label class="nc-check">
								<input
									type="checkbox"
									checked={formEvents.includes(opt.value)}
									onchange={() => toggleEvent(opt.value)}
								/>
								{opt.label}
							</label>
						{/each}
					</div>
				</div>

				<div class="nc-form-group">
					<span class="nc-form-label">Projects</span>
					<Select bind:value={formScope} class="nc-scope-select">
						<option value="all">All projects</option>
						<option value="custom">Specific projects</option>
					</Select>
					{#if formScope === 'custom'}
						{#if projects.length === 0}
							<p class="nc-hint">No projects in this organization yet.</p>
						{:else}
							<div class="nc-checks">
								{#each projects as project (project.id)}
									<label class="nc-check">
										<input
											type="checkbox"
											checked={formProjectIds.includes(project.id)}
											onchange={() => toggleProject(project.id)}
										/>
										{project.name}
									</label>
								{/each}
							</div>
						{/if}
					{/if}
				</div>

				<div class="nc-form-actions">
					<Button variant="ghost" size="sm" onclick={() => (formOpen = false)} disabled={saving}>
						Cancel
					</Button>
					<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={!formValid}>
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
		justify-content: center;
		padding: 2rem;
		color: var(--surface-muted);
	}

	.nc-empty {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 0;
		padding: 0.5rem 0;
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
		background: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
		color: var(--surface-muted);
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

	.nc-delivery-ok {
		color: var(--online-indicator, #22c55e);
	}

	.nc-delivery-fail {
		color: var(--error-text, #ef4444);
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
		gap: 0.875rem;
		margin-top: 0.5rem;
		padding: 1rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}

	.nc-form-row {
		display: grid;
		grid-template-columns: 12rem 1fr;
		gap: 0.75rem;
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

	.nc-checks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: 0.375rem 0.75rem;
	}

	.nc-check {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.8rem;
		color: var(--center-channel-color);
		cursor: pointer;
		user-select: none;
	}

	.nc-check input {
		accent-color: var(--button-bg, #6366f1);
		width: 0.9rem;
		height: 0.9rem;
	}

	.nc-form :global(.nc-scope-select) {
		max-width: 14rem;
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
		.nc-form-row {
			grid-template-columns: 1fr;
		}

		.nc-item {
			flex-wrap: wrap;
		}

		.nc-item-actions {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
