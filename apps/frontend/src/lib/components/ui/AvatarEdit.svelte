<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Camera, Trash2, Upload } from 'lucide-svelte';
	import Menu from './Menu.svelte';
	import MenuItem from './MenuItem.svelte';
	import Spinner from './Spinner.svelte';

	let {
		label,
		size = 64,
		busy = false,
		editable = true,
		removable = false,
		onchange,
		onremove = undefined,
		children
	}: {
		label: string;
		size?: number;
		busy?: boolean;
		editable?: boolean;
		removable?: boolean;
		onchange: (event: Event) => void;
		onremove?: () => void;
		children: Snippet;
	} = $props();

	let input = $state<HTMLInputElement>();
</script>

{#if editable}
	<input
		bind:this={input}
		type="file"
		accept="image/jpeg,image/png,image/gif,image/webp"
		class="file"
		tabindex="-1"
		aria-label={label}
		onchange={(e) => {
			onchange(e);
			e.currentTarget.value = '';
		}}
	/>
	<Menu placement="bottom-start">
		{#snippet trigger(props)}
			<button
				{...props}
				type="button"
				class="avatar avatar--edit"
				class:avatar--busy={busy}
				style:--avatar-size="{size}px"
				aria-label={label}
				disabled={busy}
			>
				{@render children()}
				<span class="veil" aria-hidden="true">
					{#if busy}<Spinner size={16} />{:else}<Camera size={16} />{/if}
				</span>
			</button>
		{/snippet}
		<MenuItem icon={Upload} onclick={() => input?.click()}>Upload a photo</MenuItem>
		{#if removable && onremove}
			<MenuItem icon={Trash2} danger onclick={onremove}>Remove photo</MenuItem>
		{/if}
	</Menu>
{:else}
	<span class="avatar" style:--avatar-size="{size}px">{@render children()}</span>
{/if}

<style>
	.file {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}
	.avatar {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--avatar-size);
		height: var(--avatar-size);
		flex-shrink: 0;
		overflow: hidden;
		border-radius: calc(var(--rh-lead-r, var(--radius-card)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--border-default);
	}
	.avatar > :global(:not(.veil)) {
		width: 100%;
		height: 100%;
		border-radius: 0;
		outline: none;
	}
	.avatar--edit {
		cursor: pointer;
	}
	.veil {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: color-mix(in oklab, var(--neutral-10) 45%, transparent);
		color: var(--on-media);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.avatar--edit:hover .veil,
	.avatar--edit:focus-visible .veil,
	.avatar--busy .veil {
		opacity: 1;
	}
	.avatar--edit:focus-visible {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--border-default),
			0 0 0 3px var(--focus-ring);
	}
</style>
