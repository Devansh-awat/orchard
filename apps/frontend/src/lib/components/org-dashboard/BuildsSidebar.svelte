<script lang="ts">
	import { Loader2, CheckCircle2, XCircle } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import BuildTimer from '$lib/components/BuildTimer.svelte';
	import { RemoteImg } from '$lib/components/ui';
	import { buildIcon, timeAgo } from './helpers.svelte';
	import type { ActiveBuild, RecentBuild } from './types';

	let {
		activeBuilds,
		recentBuilds,
		buildsLoading,
		orgSlug,
		failedFav,
		onFavErr
	}: {
		activeBuilds: ActiveBuild[];
		recentBuilds: RecentBuild[];
		buildsLoading: boolean;
		orgSlug: string;
		failedFav: Set<string>;
		onFavErr: (id: string) => void;
	} = $props();
</script>

<aside class="aside">
	<h2 class="label aside-label">Recent deployments</h2>
	{#if buildsLoading}
		{#each Array(3) as _, i (i)}
			<div class="bld bld--skel">
				<div class="sk" style="width:1.5rem;height:1.5rem;border-radius:0.375rem"></div>
				<div class="sk-col" style="flex:1">
					<div class="sk" style="width:5rem;height:0.6rem"></div>
					<div class="sk" style="width:7rem;height:0.45rem"></div>
				</div>
			</div>
		{/each}
	{:else if activeBuilds.length === 0 && recentBuilds.length === 0}
		<p class="aside-empty">No recent deployments</p>
	{:else}
		{#each activeBuilds as b, i (b.id)}
			{@const ic = buildIcon(b.image, b.ingresses, b.id, failedFav, b.faviconUrl)}
			<a
				href="/{orgSlug}/deployments/{b.id}"
				class="bld bld--live"
				{@attach motionStagger({ index: i, from: { y: 6 } })}
			>
				<div class="bld-dot bld-dot--building"><Loader2 size={13} class="animate-spin" /></div>
				<div class="bld-info">
					<span class="bld-row"
						>{#if ic}<RemoteImg
								src={ic}
								class="bld-ic"
								onerror={() => onFavErr('b-' + b.id)}
							/>{/if}<span class="bld-name">{b.displayName || b.name}</span></span
					>
					<span class="bld-sub"
						>{#if b.project?.name}{b.project.name} ·
						{/if}{b.buildStep ?? 'Building'}</span
					>
				</div>
				<span class="bld-time bld-time--live"><BuildTimer startedAt={b.buildStartedAt || b.updatedAt} /></span>
			</a>
		{/each}
		{#each recentBuilds as b, i (b.id)}
			{@const ok = b.deployment.buildStatus !== 'failed'}
			{@const ic = buildIcon(
				b.deployment.image,
				b.deployment.ingresses,
				b.deployment.id,
				failedFav,
				b.deployment.faviconUrl
			)}
			<a
				href="/{orgSlug}/deployments/{b.deployment.id}"
				class="bld"
				{@attach motionStagger({
					index: activeBuilds.length + i,
					from: { y: 6 }
				})}
			>
				<div class="bld-dot" class:bld-dot--ok={ok} class:bld-dot--fail={!ok}>
					{#if ok}<CheckCircle2 size={13} />{:else}<XCircle size={13} />{/if}
				</div>
				<div class="bld-info">
					<span class="bld-row"
						>{#if ic}<RemoteImg
								src={ic}
								class="bld-ic"
								onerror={() => onFavErr('b-' + b.deployment.id)}
							/>{/if}<span class="bld-name">{b.deployment.displayName || b.deployment.name}</span
						></span
					>
					<span class="bld-sub"
						>{#if b.deployment.project?.name}{b.deployment.project
								.name}{/if}{#if b.commitSha}{#if b.deployment.project?.name}
								·
							{/if}{b.commitSha.slice(
								0,
								7
							)}{/if}{#if b.branch}{#if b.deployment.project?.name || b.commitSha}
								·
							{/if}{b.branch}{/if}</span
					>
				</div>
				<span class="bld-time">{timeAgo(b.createdAt)}</span>
			</a>
		{/each}
	{/if}
</aside>
