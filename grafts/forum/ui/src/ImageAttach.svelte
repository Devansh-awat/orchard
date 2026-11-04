<script lang="ts">
	import { ImagePlus, X, Loader2 } from 'lucide-svelte';
	import type { HostApi } from '@orchardlabs/graft-sdk/client';
	import { toastError, uploadGroveImage } from './grove';

	let {
		host,
		images = $bindable([]),
		disabled = false
	}: {
		host: HostApi;
		images?: string[];
		disabled?: boolean;
	} = $props();

	let uploading = $state(false);
	let inputRef = $state<HTMLInputElement | undefined>(undefined);

	async function onPick(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []).slice(0, 4 - images.length);
		input.value = '';
		if (files.length === 0) return;
		uploading = true;
		for (const file of files) {
			try {
				const url = await uploadGroveImage(host, file);
				images = [...images, url];
			} catch (err) {
				toastError(host, 'Upload failed', err instanceof Error ? err.message : "Couldn't upload image");
			}
		}
		uploading = false;
	}

	function remove(url: string) {
		images = images.filter((u) => u !== url);
	}
</script>

<input
	bind:this={inputRef}
	type="file"
	name="grove-images"
	accept="image/jpeg,image/png,image/gif,image/webp"
	multiple
	class="sr-only"
	aria-label="Attach images"
	onchange={onPick}
/>

<div class="ia">
	{#each images as url (url)}
		<span class="ia-thumb">
			<img src={url} alt="" class="ia-img" loading="lazy" decoding="async" />
			<button type="button" class="ia-remove" aria-label="Remove image" onclick={() => remove(url)}>
				<X size={10} />
			</button>
		</span>
	{/each}
	{#if images.length < 4}
		<button
			type="button"
			class="ia-add"
			disabled={disabled || uploading}
			aria-label="Attach images"
			onclick={() => inputRef?.click()}
		>
			{#if uploading}<Loader2 size={14} class="animate-spin" />{:else}<ImagePlus size={14} />{/if}
		</button>
	{/if}
</div>

<style>
	.ia {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.ia-thumb {
		position: relative;
		width: 2.5rem;
		height: 2.5rem;
	}

	.ia-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: var(--radius-xs);
		outline: 1px solid var(--border-default);
		outline-offset: -1px;
	}

	.ia-remove {
		position: absolute;
		top: -0.3125rem;
		right: -0.3125rem;
		width: 1rem;
		height: 1rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-pill);
		border: none;
		background: var(--text-default);
		color: var(--bg-surface);
		cursor: pointer;
	}

	.ia-add {
		width: 2.5rem;
		height: 2.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-xs);
		border: 1px dashed var(--border-strong);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			border-color var(--dur-fast) ease;
	}

	.ia-add:hover {
		color: var(--text-default);
		border-color: var(--text-muted);
	}

	.ia-add:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
