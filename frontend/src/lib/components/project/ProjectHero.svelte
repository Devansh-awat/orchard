<script lang="ts">
	import { animate } from 'motion';
	import { tick } from 'svelte';
	import { Palette, Trash2, Loader2 } from 'lucide-svelte';
	import type { Project } from './types';

	let {
		project,
		activeTab,
		canEdit = false,
		canDelete = false,
		deleting = false,
		heroImgReady = $bindable(false),
		onCustomize,
		onDelete,
	}: {
		project: Project;
		activeTab: string;
		canEdit?: boolean;
		canDelete?: boolean;
		deleting?: boolean;
		heroImgReady?: boolean;
		onCustomize?: () => void;
		onDelete?: () => void;
	} = $props();

	let heroEl = $state<HTMLElement | null>(null);
	let heroTitleEl = $state<HTMLElement | null>(null);
	let heroDescEl = $state<HTMLElement | null>(null);
	let firstRun = true;

	$effect(() => {
		const compact = activeTab === 'members';
		const heroPx = compact ? 7.5 * 16 : 18 * 16;
		const titlePx = compact ? 1.0625 * 16 : 1.25 * 16;
		const descOp = compact ? 0 : 1;

		if (heroEl) {
			animate(heroEl, { height: `${heroPx}px` }, { type: 'spring', stiffness: 180, damping: 19, mass: 1.3 });
		}
		if (heroTitleEl) {
			animate(heroTitleEl, { fontSize: `${titlePx}px` }, { type: 'spring', stiffness: 220, damping: 22, mass: 1 });
		}
		if (heroDescEl) {
			animate(heroDescEl, { opacity: descOp }, { type: 'spring', stiffness: 260, damping: 26, mass: 0.7 });
		}
		if (firstRun) { firstRun = false; }
	});
</script>

{#if heroImgReady}
	<div
		class="pj-hero-bleed"
		style="background-image: url({JSON.stringify(project.backgroundImage)});"
		aria-hidden="true"
	></div>
{/if}
<div
	class="pj-hero"
	class:pj-hero--compact={activeTab === 'members'}
	bind:this={heroEl}
>
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
			<h1
				class="pj-title pj-title--onhero"
				bind:this={heroTitleEl}
			>
				{#if project.icon}
					<span class="pj-title-icon">
						{#if /^https?:\/\//.test(project.icon)}
							<img src={project.icon} alt="" />
						{:else}
							{project.icon}
						{/if}
					</span>
				{/if}
				{project.name}
			</h1>
			{#if project.description}
				<p
					class="pj-description pj-description--onhero"
					bind:this={heroDescEl}
				>{project.description}</p>
			{/if}
		</div>
		<div class="pj-header-actions">
			{#if canEdit}
			<button
				onclick={onCustomize}
				class="pj-icon-btn pj-icon-btn--onhero"
				aria-label="Customize project"
				title="Customize"
			>
				<Palette class="h-4 w-4" />
			</button>
			{/if}
			{#if canDelete}
			<button
				onclick={onDelete}
				disabled={deleting}
				class="pj-icon-btn pj-icon-btn--danger pj-icon-btn--onhero"
				aria-label="Delete project"
				title="Delete"
			>
				{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2 class="h-4 w-4" />{/if}
			</button>
			{/if}
		</div>
	</div>
</div>
