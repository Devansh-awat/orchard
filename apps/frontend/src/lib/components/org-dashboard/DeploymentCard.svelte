<script lang="ts">
	import { Star, MoreVertical, ExternalLink, RefreshCw, Pin, PinOff, Copy } from 'lucide-svelte';
	import { springHover, cardTilt, springPop } from '$lib/utils/motion.svelte';
	import { knownIcon, favUrl, timeAgo } from './helpers.svelte';
	import { Menu, MenuItem, resourceStatus } from '$lib/components/ui';
	import type { DeploymentSummary, LiveMetricsEntry } from './types';

	let {
		dep,
		isFav,
		orgSlug,
		isFavourite,
		failedFav,
		liveMetrics,
		onToggleFav,
		onRestart,
		onCopyUrl,
		onVisit,
		onFavErr
	}: {
		dep: DeploymentSummary;
		isFav: boolean;
		orgSlug: string;
		isFavourite: boolean;
		failedFav: Set<string>;
		liveMetrics?: ReadonlyMap<string, LiveMetricsEntry>;
		onToggleFav: (dep: DeploymentSummary, e: Event) => void;
		onRestart: (dep: DeploymentSummary, e: Event) => void;
		onCopyUrl: (dep: DeploymentSummary, e: Event) => void;
		onVisit: (dep: DeploymentSummary, e: Event) => void;
		onFavErr: (id: string) => void;
	} = $props();

	const icon = $derived(knownIcon(dep.image));
	const metrics = $derived(liveMetrics?.get(dep.id));
	const m = $derived(resourceStatus(dep.status, dep.buildStatus));

	function fmtCpu(milli: number): string {
		if (milli < 1000) return `${Math.round(milli)}m`;
		return `${(milli / 1000).toFixed(1)} cores`;
	}

	function fmtMem(bytes: number): string {
		const mib = bytes / (1024 * 1024);
		if (mib < 1024) return `${Math.round(mib)} MiB`;
		return `${(mib / 1024).toFixed(1)} GiB`;
	}
</script>

<a
	href="/{orgSlug}/deployments/{dep.id}"
	class="dash-card"
	class:dash-card--fav={isFav}
	{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
	{@attach cardTilt({ max: 4 })}
>
	<div class="card-top">
		{#if icon}
			<img src={icon} alt="" class="card-ic" loading="lazy" decoding="async" />
		{:else if (dep.faviconUrl || dep.ingresses.length > 0) && !failedFav.has(dep.id)}
			<img
				src={dep.faviconUrl ?? favUrl(dep.ingresses[0].host.split('/')[0])}
				alt=""
				class="card-ic"
				loading="lazy"
				decoding="async"
				onerror={() => onFavErr(dep.id)}
			/>
		{:else}
			<div class="card-av">{(dep.displayName || dep.name).charAt(0).toUpperCase()}</div>
		{/if}
		<div class="card-text">
			<span class="card-name">{dep.displayName || dep.name}</span>
			{#if dep.ingresses.length > 0}
				<span class="card-sub">{dep.ingresses[0].host.split('/')[0]}</span>
			{:else if dep.githubRepo}
				<span class="card-sub"
					>{dep.githubRepo}{#if dep.githubBranch}
						/ {dep.githubBranch}{/if}</span
				>
			{:else if dep.image}
				<span class="card-sub">{dep.image}</span>
			{/if}
		</div>
		<div class="card-acts">
			<button
				class="abtn fav"
				class:fav--on={isFavourite}
				onclick={(e) => onToggleFav(dep, e)}
				aria-label="Favourite"
				{@attach springPop(() => isFavourite)}><Star size={13} /></button
			>
			<Menu placement="bottom-end">
				{#snippet trigger(attrs, _open)}
					<button
						class="abtn"
						{...attrs}
						aria-label="More"
						onclick={(e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							(attrs as { onclick?: (e: Event) => void }).onclick?.(e);
						}}><MoreVertical size={13} /></button
					>
				{/snippet}
				{#if dep.ingresses.length > 0}
					<MenuItem onclick={(e) => onVisit(dep, e)}><ExternalLink size={14} /> Visit</MenuItem>
					<MenuItem onclick={(e) => onCopyUrl(dep, e)}><Copy size={14} /> Copy URL</MenuItem>
				{/if}
				<MenuItem onclick={(e) => onRestart(dep, e)}><RefreshCw size={14} /> Restart</MenuItem>
				<MenuItem onclick={(e) => onToggleFav(dep, e)}
					>{#if isFavourite}<PinOff size={14} /> Unfavourite{:else}<Pin size={14} /> Favourite{/if}</MenuItem
				>
			</Menu>
		</div>
	</div>
	<div class="card-bot">
		<span class="card-status"
			><span class="dot status--{m.kind}"></span>
			{m.label}</span
		>
		{#if metrics}
			<span class="card-metrics">{fmtCpu(metrics.cpuMilli)} · {fmtMem(metrics.memoryBytes)}</span>
		{/if}
		<span class="card-meta">{timeAgo(dep.updatedAt)}</span>
	</div>
</a>
