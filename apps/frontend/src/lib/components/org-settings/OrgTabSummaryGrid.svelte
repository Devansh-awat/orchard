<script lang="ts">
	import {
		Users,
		Shield,
		Bell,
		Globe,
		Key,
		ScrollText,
		Activity,
		ChevronRight
	} from 'lucide-svelte';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';

	let {
		organizationSlug,
		memberCount,
		pendingInvites,
		backupsConfigured,
		channelCount,
		showNotifications,
		isEnterprise,
		ssoEnabled,
		canEditOrg,
		index = 0
	}: {
		organizationSlug: string;
		memberCount: number;
		pendingInvites: number;
		backupsConfigured: boolean;
		channelCount: number;
		showNotifications: boolean;
		isEnterprise: boolean;
		ssoEnabled: boolean;
		canEditOrg: boolean;
		index?: number;
	} = $props();

	const cards = $derived(
		[
			{
				href: `/${organizationSlug}/settings?tab=members`,
				icon: Users,
				title: 'Members',
				value: `${memberCount} member${memberCount === 1 ? '' : 's'}`,
				detail: pendingInvites > 0 ? `${pendingInvites} pending` : null
			},
			{
				href: `/${organizationSlug}/usage`,
				icon: Activity,
				title: 'Usage',
				value: 'Capacity and allowances',
				detail: null
			},
			canEditOrg && {
				href: `/${organizationSlug}/settings?tab=database`,
				icon: Globe,
				title: 'Database defaults',
				value: 'Extensions and versions',
				detail: null
			},
			canEditOrg && {
				href: `/${organizationSlug}/settings?tab=backups`,
				icon: Shield,
				title: 'Backups',
				value: backupsConfigured ? 'Configured' : 'Not set up',
				detail: null
			},
			canEditOrg &&
				showNotifications && {
					href: `/${organizationSlug}/settings?tab=notifications`,
					icon: Bell,
					title: 'Notifications',
					value: `${channelCount} channel${channelCount === 1 ? '' : 's'}`,
					detail: null
				},
			canEditOrg &&
				isEnterprise && {
					href: `/${organizationSlug}/settings?tab=sso`,
					icon: Key,
					title: 'SSO',
					value: ssoEnabled ? 'Enabled' : 'Off',
					detail: null
				},
			canEditOrg && {
				href: `/${organizationSlug}/settings/audit-logs`,
				icon: ScrollText,
				title: 'Audit log',
				value: 'Recent admin actions',
				detail: null
			}
		].filter(Boolean) as {
			href: string;
			icon: typeof Users;
			title: string;
			value: string;
			detail: string | null;
		}[]
	);
</script>

<div class="otg-grid">
	{#each cards as card, i (card.href)}
		{@const Icon = card.icon}
		<a
			href={card.href}
			class="otg-card"
			{@attach motionStagger({ index: index + i, stride: 0.05, from: { y: 10, opacity: 0 } })}
			{@attach springHover({ lift: -2, stiffness: 360, damping: 23 })}
		>
			<span class="otg-icon"><Icon class="h-4 w-4" /></span>
			<span class="otg-text">
				<span class="otg-title">{card.title}</span>
				<span class="otg-value">
					{card.value}
					{#if card.detail}<span class="otg-detail">{card.detail}</span>{/if}
				</span>
			</span>
			<ChevronRight class="otg-chevron h-4 w-4" />
		</a>
	{/each}
</div>

<style>
	.otg-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.625rem;
	}
	.otg-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--border-default);
		border-radius: 0.875rem;
		background-color: var(--bg-surface);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.02);
		text-decoration: none;
		color: var(--text-default);
	}
	.otg-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--text-default) 7%, transparent);
		color: var(--text-default);
	}
	.otg-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.otg-title {
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.otg-value {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.0625rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.otg-detail {
		display: inline-block;
		margin-left: 0.375rem;
		color: var(--status-warning);
		font-weight: 550;
	}
	.otg-card :global(.otg-chevron) {
		flex-shrink: 0;
		color: var(--text-faint);
		transition:
			color 120ms,
			transform 150ms ease;
	}
	.otg-card:hover :global(.otg-chevron) {
		color: var(--text-muted);
		transform: translateX(2px);
	}
	@media (max-width: 640px) {
		.otg-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
