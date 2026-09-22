<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { ShieldCheck, MonitorCheck, SmartphoneNfc, LogOut } from '@jis3r/icons';
	import { iconAnimation } from '$lib/utils/motion.svelte';
	import { Alert, Badge, EmptyState, Skeleton } from '$lib/components/ui';
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
		index = 0
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
		return (
			lower.includes('iphone') ||
			lower.includes('android') ||
			lower.includes('mobile') ||
			lower.includes('ipad')
		);
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

<SettingsSection {index} title="Active sessions">
	{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}
	{#snippet badge()}
		{#if !sessionsLoading && sessions.length > 0}
			<span class="se-count">{sessions.length}</span>
		{/if}
	{/snippet}

	{#if sessionsError}
		<div class="se-alert"><Alert tone="error">{sessionsError}</Alert></div>
	{/if}

	{#if sessionsLoading}
		<div class="se-loading">
			{#each [0, 1] as row (row)}
				<div class="se-loading-row">
					<Skeleton width="2rem" height="2rem" rounded="var(--radius-sm)" />
					<div class="se-loading-lines">
						<Skeleton width="9rem" height="0.875rem" rounded="var(--radius-xs)" />
						<Skeleton width="13rem" height="0.6875rem" rounded="var(--radius-xs)" />
					</div>
				</div>
			{/each}
		</div>
	{:else if sessions.length > 0}
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
									<Badge tone="success">This device</Badge>
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
				<LogOut size={14} animate={iconAnimation(revokeAllHovered)} />
				Sign out all other devices
			</button>
		{/if}
	{:else}
		<EmptyState title="No active sessions found.">
			{#snippet icon()}<MonitorCheck size={22} />{/snippet}
		</EmptyState>
	{/if}
</SettingsSection>

<style>
	.se-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.se-alert {
		margin-bottom: var(--space-3);
	}
	.se-loading {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-3) 0;
	}
	.se-loading-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.se-loading-lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.se-list {
		display: flex;
		flex-direction: column;
	}
	.se-item {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.875rem 0;
	}
	.se-item + .se-item {
		border-top: 1px solid var(--rule);
	}
	.se-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
		background-color: var(--fill-soft);
		color: var(--text-muted);
	}
	.se-item--current .se-item-icon {
		background-color: color-mix(in srgb, var(--status-success) 10%, transparent);
		color: var(--status-success);
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
		gap: var(--space-2);
	}
	.se-item-device {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		color: var(--text-default);
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.se-item-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.125rem;
	}
	.se-sep {
		margin: 0 0.125rem;
	}
	.se-revoke-all {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-sm);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: background-color var(--dur-fast);
		background-color: color-mix(in srgb, var(--status-error) 10%, transparent);
		color: var(--status-error);
	}
	.se-revoke-all:hover {
		background-color: color-mix(in srgb, var(--status-error) 16%, transparent);
	}
</style>
