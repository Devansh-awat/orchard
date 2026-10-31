<script lang="ts">
	import { LogOut, Monitor, Smartphone } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		List,
		ListRow,
		SectionCard,
		Skeleton,
		ToneTile
	} from '$lib/components/ui';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';

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
		onShowRevokeAll
	}: {
		sessions: SessionRecord[];
		sessionsLoading: boolean;
		sessionsError: string | null;
		revokingSessionId: string | null;
		onConfirmRevokeSession: (session: SessionRecord) => void;
		onShowRevokeAll: () => void;
		index?: number;
	} = $props();

	const ordered = $derived([...sessions].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)));

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
</script>

<SectionCard title="Devices">
	{#snippet actions()}
		{#if !sessionsLoading && sessions.length > 1}
			<Button size="sm" icon={LogOut} onclick={onShowRevokeAll}>Sign out others</Button>
		{/if}
	{/snippet}
	<div class="body">
		{#if sessionsError}
			<Alert tone="error">{sessionsError}</Alert>
		{/if}
		{#if sessionsLoading}
			<div class="placeholder">
				<Skeleton height="2.5rem" />
				<Skeleton height="2.5rem" />
			</div>
		{:else if sessions.length === 0}
			{#if !sessionsError}
				<p class="quiet">No signed-in devices.</p>
			{/if}
		{:else}
			<List inset={false} label="Signed-in devices">
				{#each ordered as session (session.id)}
					<ListRow flush presence title={session.deviceName || 'Unknown device'}>
						{#snippet leading()}
							<ToneTile size={32}>
								{#if isMobile(session.deviceName)}<Smartphone size={16} />{:else}<Monitor
										size={16}
									/>{/if}
							</ToneTile>
						{/snippet}
						{#snippet titleSuffix()}
							{#if session.isCurrent}<Badge>This device</Badge>{/if}
						{/snippet}
						{#snippet subtitle()}
							{@const where = [session.location, session.ipAddress].filter(Boolean).join(' · ')}
							<span>
								{where ? `${where} · ` : ''}{#if session.isCurrent}Active now{:else}Active
									<RelativeTime date={session.lastActiveAt} />{/if}
							</span>
						{/snippet}
						{#snippet actions()}
							{#if !session.isCurrent}
								<Button
									size="sm"
									variant="ghost"
									icon={LogOut}
									label={`Sign out ${session.deviceName || 'this device'}`}
									loading={revokingSessionId === session.id}
									onclick={() => onConfirmRevokeSession(session)}
								/>
							{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</div>
</SectionCard>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.quiet {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
