<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { ShieldCheck, MonitorCheck, SmartphoneNfc, LogOut } from '@jis3r/icons';
	import SettingsSection from './SettingsSection.svelte';
	import IconButton from './IconButton.svelte';

	interface SessionRecord {
		id: string;
		ipAddress?: string | null;
		deviceName?: string | null;
		location?: string | null;
		authMethod?: string | null;
		lastActiveAt: string;
		createdAt: string;
		isCurrent: boolean;
	}

	let {
		sessions,
		sessionsLoading,
		sessionsError,
		revokingSessionId,
		onConfirmRevokeSession,
		onShowRevokeAll,
		index = 0,
	}: {
		sessions: SessionRecord[];
		sessionsLoading: boolean;
		sessionsError: string | null;
		revokingSessionId: string | null;
		onConfirmRevokeSession: (session: SessionRecord) => void;
		onShowRevokeAll: () => void;
		index?: number;
	} = $props();

	let revokeAllHovered = $state(false);

	function isMobile(deviceName?: string | null): boolean {
		if (!deviceName) return false;
		const lower = deviceName.toLowerCase();
		return lower.includes('iphone') || lower.includes('android') || lower.includes('mobile') || lower.includes('ipad');
	}

	function formatRelativeTime(dateStr: string): string {
		const now = Date.now();
		const date = new Date(dateStr).getTime();
		const diffMs = now - date;
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return 'Just now';
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr}h ago`;
		const diffDay = Math.floor(diffHr / 24);
		if (diffDay < 7) return `${diffDay}d ago`;
		return new Date(dateStr).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}
</script>

<SettingsSection {index} title="Active Sessions" description="Devices where you're currently signed in" iconColor="green">
	{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}
	{#snippet badge()}
		{#if !sessionsLoading && sessions.length > 0}
			<span class="se-count">{sessions.length}</span>
		{/if}
	{/snippet}

	{#if sessionsError}
		<div class="se-error">{sessionsError}</div>
	{/if}

	{#if sessionsLoading}
		<div class="se-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else}
		{#if sessions.length > 0}
			<div class="se-list">
				{#each sessions as session (session.id)}
					<div class="se-item" class:se-item--current={session.isCurrent}>
						<div class="se-item-icon">
							{#if isMobile(session.deviceName)}
								<SmartphoneNfc size={16} />
							{:else}
								<MonitorCheck size={16} />
							{/if}
						</div>
						<div class="se-item-body">
							<div class="se-item-top">
								<span class="se-item-device">
									{session.deviceName || 'Unknown Device'}
									{#if session.isCurrent}
										<span class="se-current-badge">This device</span>
									{/if}
								</span>
							</div>
							<div class="se-item-meta">
								{#if session.location}
									<span>{session.location}</span>
									<span class="se-sep">·</span>
								{/if}
								{#if session.ipAddress}
									<span>{session.ipAddress}</span>
									<span class="se-sep">·</span>
								{/if}
								<span>Active {formatRelativeTime(session.lastActiveAt)}</span>
							</div>
						</div>
						{#if !session.isCurrent}
							<IconButton
								variant="danger"
								onclick={() => onConfirmRevokeSession(session)}
								disabled={revokingSessionId === session.id}
								title="Sign out this device"
							>
								{#snippet children(hovered)}
									{#if revokingSessionId === session.id}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<LogOut size={13} animate={hovered} />
									{/if}
								{/snippet}
							</IconButton>
						{/if}
					</div>
				{/each}
			</div>

			{#if sessions.length > 1}
				<button
					class="se-revoke-all"
					onclick={onShowRevokeAll}
					onmouseenter={() => (revokeAllHovered = true)}
					onmouseleave={() => (revokeAllHovered = false)}
				>
					<LogOut size={14} animate={revokeAllHovered} />
					Sign out all other devices
				</button>
			{/if}
		{:else}
			<p class="se-empty">No active sessions found.</p>
		{/if}
	{/if}
</SettingsSection>

<style>
	.se-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 650;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.se-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.se-error {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}
	.se-list {
		display: flex;
		flex-direction: column;
	}
	.se-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 0;
	}
	.se-item + .se-item {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.se-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
		color: var(--surface-muted);
	}
	.se-item--current .se-item-icon {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.se-item-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.se-item-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.se-item-device {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.se-current-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.0625rem 0.4375rem;
		border-radius: 2rem;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background-color: color-mix(in srgb, var(--online-indicator) 12%, transparent);
		color: var(--online-indicator);
	}
	.se-item-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.125rem;
	}
	.se-sep { margin: 0 0.125rem; }
	.se-revoke-all {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		width: 100%;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}
	.se-revoke-all:hover {
		background-color: color-mix(in srgb, var(--error-text-color) 16%, transparent);
	}
	.se-empty {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		padding: 0.5rem 0;
		margin: 0;
	}
</style>
