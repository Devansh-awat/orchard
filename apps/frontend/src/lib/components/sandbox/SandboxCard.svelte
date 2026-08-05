<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { springHover, stateEcho } from '$lib/utils/motion.svelte';
	import { StatusDot, sandboxStatus } from '$lib/components/ui';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import { user } from '$lib/stores';
	import { sandboxBootQueryOptions } from '$lib/queries/sandboxes';
	import { isSandboxTransitional, type Sandbox } from '$lib/types/sandbox';
	import SandboxBootProgress from './SandboxBootProgress.svelte';

	let { sandbox }: { sandbox: Sandbox } = $props();

	const m = $derived(sandboxStatus(sandbox.status));
	const owned = $derived(!sandbox.owner || sandbox.owner.id === $user?.id);
	const ownerName = $derived(sandbox.owner?.username ?? sandbox.owner?.email ?? 'another member');
	const settingUp = $derived(
		isSandboxTransitional(sandbox.status) && sandbox.status !== 'deleting' && owned
	);

	const bootQuery = createQuery(() => sandboxBootQueryOptions(sandbox.id, settingUp));
	const boot = $derived(bootQuery.data ?? null);

	const repo = $derived(
		sandbox.repoUrl
			? sandbox.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')
			: null
	);
	const imageTag = $derived(sandbox.image.split('/').pop() ?? sandbox.image);
</script>

<a
	href="/sandboxes/{sandbox.id}"
	class="sbx-card motion-echo echo--{m.kind}"
	title={sandbox.status === 'error' && sandbox.statusMessage ? sandbox.statusMessage : undefined}
	{@attach springHover({ lift: -3 })}
	{@attach stateEcho(() => m.kind)}
>
	<div class="sbx-card-top">
		<div class="sbx-card-av">{sandbox.name.charAt(0).toUpperCase()}</div>
		<div class="sbx-card-text">
			<span class="sbx-card-name">{sandbox.name}</span>
			<span class="sbx-card-sub">{repo ?? imageTag}</span>
		</div>
		{#if !owned}
			<span class="sbx-card-owner" title={ownerName}>
				<span class="sbx-card-owner-av" aria-hidden="true">
					{ownerName.charAt(0).toUpperCase()}
				</span>
				<span class="sbx-card-owner-name">{ownerName}</span>
			</span>
		{/if}
	</div>

	{#if settingUp}
		<div class="sbx-card-boot">
			<SandboxBootProgress {boot} status={sandbox.status} compact />
		</div>
	{/if}

	<div class="sbx-card-bot">
		<span class="sbx-card-status">
			<StatusDot meta={m} size={7} />
			{m.label}
		</span>
		{#if repo}
			<span class="sbx-card-image">{imageTag}</span>
		{/if}
		<span class="sbx-card-meta">
			{sandbox.lastActiveAt ? `active ${timeAgo(sandbox.lastActiveAt)}` : 'never active'}
		</span>
	</div>
</a>

<style>
	.sbx-card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--bg-raised);
		min-height: 7.5rem;
		text-decoration: none;
		color: var(--text-default);
		box-shadow: var(--elev-1);
		cursor: pointer;
	}

	.sbx-card::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: var(--elev-3);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
		pointer-events: none;
	}

	.sbx-card:hover::after {
		opacity: 1;
	}

	.sbx-card-top {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.sbx-card-av {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 15%, transparent),
			color-mix(in srgb, var(--accent) 5%, transparent)
		);
		color: var(--accent);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 700;
	}

	.sbx-card-text {
		flex: 1;
		min-width: 0;
	}

	.sbx-card-name {
		display: block;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbx-card-sub {
		display: block;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 0.125rem;
	}

	.sbx-card-owner {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
		max-width: 8rem;
		height: 1.5rem;
		padding: 0 var(--space-2) 0 0.1875rem;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}

	.sbx-card-owner-av {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		color: var(--text-muted);
		font-weight: 700;
	}

	.sbx-card-owner-name {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbx-card-boot {
		min-width: 0;
	}

	.sbx-card-bot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: auto;
		padding-top: var(--space-3);
		box-shadow: inset 0 1px 0 var(--rule);
	}

	.sbx-card-status {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		font-weight: 600;
	}

	.sbx-card-image {
		margin-left: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbx-card-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
