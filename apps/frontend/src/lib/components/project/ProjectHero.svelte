<script lang="ts">
	import { animate } from 'motion';
	import { motionEnabled, transition } from '$lib/utils/motion.svelte';
	import { tick } from 'svelte';
	import { Palette, Ellipsis } from 'lucide-svelte';
	import { Menu, MenuItem } from '$lib/components/ui';
	import type { Project } from './types';

	let {
		project,
		activeTab,
		canEdit = false,
		heroImgReady = $bindable(false),
		onCustomize
	}: {
		project: Project;
		activeTab: string;
		canEdit?: boolean;
		heroImgReady?: boolean;
		onCustomize?: () => void;
	} = $props();

	let heroEl = $state<HTMLElement | null>(null);
	let heroTitleEl = $state<HTMLElement | null>(null);
	let heroDescEl = $state<HTMLElement | null>(null);
	let firstRun = true;

	// Tabs that don't need the big banner collapse the hero to a compact strip.
	const heroCompact = $derived(
		activeTab === 'members' || activeTab === 'variables' || activeTab === 'compose'
	);

	$effect(() => {
		const compact = heroCompact;
		const heroPx = compact ? 7.5 * 16 : 18 * 16;
		const titlePx = compact ? 1.375 * 16 : 1.75 * 16;
		const descOp = compact ? 0 : 1;

		if (!motionEnabled()) {
			if (heroEl) heroEl.style.height = `${heroPx}px`;
			if (heroTitleEl) heroTitleEl.style.fontSize = `${titlePx}px`;
			if (heroDescEl) heroDescEl.style.opacity = `${descOp}`;
			firstRun = false;
			return;
		}

		if (heroEl) {
			animate(heroEl, { height: `${heroPx}px` }, transition('smooth'));
		}
		if (heroTitleEl) {
			animate(heroTitleEl, { fontSize: `${titlePx}px` }, transition('smooth'));
		}
		if (heroDescEl) {
			animate(heroDescEl, { opacity: descOp }, transition('smooth'));
		}
		if (firstRun) {
			firstRun = false;
		}
	});
</script>

{#if heroImgReady}
	<div
		class="pj-hero-bleed"
		style="background-image: url({JSON.stringify(project.backgroundImage)});"
		aria-hidden="true"
	></div>
{/if}
<div class="pj-hero" class:pj-hero--compact={heroCompact} bind:this={heroEl}>
	<img
		class="pj-hero-img"
		src={project.backgroundImage}
		alt=""
		fetchpriority="high"
		decoding="async"
		onload={() => (heroImgReady = true)}
	/>
	<div class="pj-hero-fade"></div>
	<div class="pj-hero-content">
		<div class="pj-header-info">
			<h1 class="pj-title pj-title--onhero" bind:this={heroTitleEl}>
				{#if project.icon}
					<span class="pj-title-icon">
						{#if /^https?:\/\//.test(project.icon)}
							<img src={project.icon} alt="" />
						{:else}
							{project.icon}
						{/if}
					</span>
				{/if}
				{#if project.owner?.username}<span class="pj-title-owner">{project.owner.username}@</span
					>{/if}{project.name}
			</h1>
			{#if project.description}
				<p class="pj-description pj-description--onhero" bind:this={heroDescEl}>
					{project.description}
				</p>
			{/if}
		</div>
		<div class="pj-header-actions">
			{#if canEdit}
				<Menu placement="bottom-end">
					{#snippet trigger(attrs, open)}
						<button
							type="button"
							class="pj-icon-btn pj-icon-btn--onhero"
							aria-label="Project options"
							aria-haspopup="menu"
							aria-expanded={open}
							{...attrs}
						>
							<Ellipsis class="h-4 w-4" />
						</button>
					{/snippet}
					<MenuItem onclick={() => onCustomize?.()}>
						<Palette size={14} />
						Customize appearance
					</MenuItem>
				</Menu>
			{/if}
		</div>
	</div>
</div>
