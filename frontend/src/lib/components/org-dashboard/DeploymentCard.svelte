<script lang="ts">
	import {
		Star,
		MoreVertical,
		ExternalLink,
		RefreshCw,
		Pin,
		PinOff,
		Copy
	} from 'lucide-svelte';
	import { springHover, cardTilt, motionPopover } from '$lib/utils/motion.svelte';
	import { knownIcon, favUrl, dotClass, statusText, timeAgo, springPop } from './helpers.svelte';
	import type { DeploymentSummary } from './types';

	let {
		dep,
		isFav,
		orgSlug,
		isFavourite,
		failedFav,
		openMenuId,
		renderMenuId,
		onToggleFav,
		onToggleMenu,
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
		openMenuId: string | null;
		renderMenuId: string | null;
		onToggleFav: (dep: DeploymentSummary, e: Event) => void;
		onToggleMenu: (id: string, e: Event) => void;
		onRestart: (dep: DeploymentSummary, e: Event) => void;
		onCopyUrl: (dep: DeploymentSummary, e: Event) => void;
		onVisit: (dep: DeploymentSummary, e: Event) => void;
		onFavErr: (id: string) => void;
	} = $props();

	const icon = $derived(knownIcon(dep.image));
</script>

<a
	href="/{orgSlug}/deployments/{dep.id}"
	class="card"
	class:card--fav={isFav}
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
			<div class="card-av">{dep.name.charAt(0).toUpperCase()}</div>
		{/if}
		<div class="card-text">
			<span class="card-name">{dep.name}</span>
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
			<div class="menu-wrap">
				<button class="abtn" onclick={(e) => onToggleMenu(dep.id, e)} aria-label="More"
					><MoreVertical size={13} /></button
				>
				{#if renderMenuId === dep.id}
					<div
						class="menu"
						{@attach motionPopover({
							from: { y: -6, scale: 0.94 },
							stiffness: 540,
							damping: 28,
							closing: () => openMenuId !== dep.id,
							onClosed: () => {
								// parent handles clearing renderMenuId
							}
						})}
					>
						{#if dep.ingresses.length > 0}
							<button class="menu-item" onclick={(e) => onVisit(dep, e)}
								><ExternalLink size={14} /> Visit</button
							>
							<button class="menu-item" onclick={(e) => onCopyUrl(dep, e)}
								><Copy size={14} /> Copy URL</button
							>
						{/if}
						<button class="menu-item" onclick={(e) => onRestart(dep, e)}
							><RefreshCw size={14} /> Restart</button
						>
						<button class="menu-item" onclick={(e) => onToggleFav(dep, e)}
							>{#if isFavourite}<PinOff size={14} /> Unfavourite{:else}<Pin
									size={14}
								/> Favourite{/if}</button
						>
					</div>
				{/if}
			</div>
		</div>
	</div>
	<div class="card-bot">
		<span class="card-status"
			><span class="dot {dotClass(dep.status, dep.buildStatus)}"></span>
			{statusText(dep.status, dep.buildStatus)}</span
		>
		<span class="card-meta">{timeAgo(dep.updatedAt)}</span>
	</div>
</a>
