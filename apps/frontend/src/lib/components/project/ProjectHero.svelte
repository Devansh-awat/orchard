<script lang="ts">
	import { Palette, Ellipsis } from 'lucide-svelte';
	import { Menu, MenuItem } from '$lib/components/ui';
	import type { Project } from './types';

	let {
		project,
		canEdit = false,
		heroImgReady = $bindable(false),
		onCustomize
	}: {
		project: Project;
		canEdit?: boolean;
		heroImgReady?: boolean;
		onCustomize?: () => void;
	} = $props();
</script>

{#if heroImgReady}
	<div
		class="pj-hero-bleed"
		style="background-image: url({JSON.stringify(project.backgroundImage)});"
		aria-hidden="true"
	></div>
{/if}
<div class="pj-hero">
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
			<h1 class="pj-title pj-title--onhero">
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
				<p class="pj-description pj-description--onhero">
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
