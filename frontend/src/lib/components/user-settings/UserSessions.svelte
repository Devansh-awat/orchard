<script lang="ts">
	import { Loader2, Globe, Monitor, Smartphone, LogOut } from 'lucide-svelte';

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
	}: {
		sessions: SessionRecord[];
		sessionsLoading: boolean;
		sessionsError: string | null;
		revokingSessionId: string | null;
		onConfirmRevokeSession: (session: SessionRecord) => void;
		onShowRevokeAll: () => void;
	} = $props();

	function getDeviceIcon(deviceName?: string | null): 'monitor' | 'smartphone' {
		if (!deviceName) return 'monitor';
		const lower = deviceName.toLowerCase();
		if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile') || lower.includes('ipad')) return 'smartphone';
		return 'monitor';
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

<div class="us-card-section">
	<div class="us-section-head">
		<div class="us-section-icon us-section-icon--sessions">
			<Globe class="h-4 w-4" />
		</div>
		<div class="us-section-title-group">
			<h2 class="us-section-title">Active Sessions</h2>
			<p class="us-section-desc">Devices where you're currently signed in</p>
		</div>
		{#if !sessionsLoading && sessions.length > 0}
			<span class="us-count">{sessions.length}</span>
		{/if}
	</div>

	{#if sessionsError}
		<div class="us-error">{sessionsError}</div>
	{/if}

	{#if sessionsLoading}
		<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else}
		{#if sessions.length > 0}
			<div class="us-session-list">
				{#each sessions as session (session.id)}
					<div class="us-session" class:us-session--current={session.isCurrent}>
						<div class="us-session-icon">
							{#if getDeviceIcon(session.deviceName) === 'smartphone'}
								<Smartphone class="h-4 w-4" />
							{:else}
								<Monitor class="h-4 w-4" />
							{/if}
						</div>
						<div class="us-session-body">
							<div class="us-session-top">
								<span class="us-session-device">
									{session.deviceName || 'Unknown Device'}
									{#if session.isCurrent}
										<span class="us-session-current-badge">This device</span>
									{/if}
								</span>
							</div>
							<div class="us-session-meta">
								{#if session.location}
									<span>{session.location}</span>
									<span class="us-session-sep">·</span>
								{/if}
								{#if session.ipAddress}
									<span>{session.ipAddress}</span>
									<span class="us-session-sep">·</span>
								{/if}
								<span>Active {formatRelativeTime(session.lastActiveAt)}</span>
							</div>
						</div>
						{#if !session.isCurrent}
							<button
								class="us-icon-btn us-icon-btn--danger"
								type="button"
								onclick={() => onConfirmRevokeSession(session)}
								disabled={revokingSessionId === session.id}
								title="Sign out this device"
							>
								{#if revokingSessionId === session.id}
									<Loader2 class="h-3 w-3 animate-spin" />
								{:else}
									<LogOut class="h-3 w-3" />
								{/if}
							</button>
						{/if}
					</div>
				{/each}
			</div>

			{#if sessions.length > 1}
				<button class="us-btn us-btn-danger us-btn--full" onclick={onShowRevokeAll}>
					<LogOut class="h-3.5 w-3.5" />
					Sign out all other devices
				</button>
			{/if}
		{:else}
			<p class="us-empty-hint">No active sessions found.</p>
		{/if}
	{/if}
</div>
