<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Image as ImageIcon } from 'lucide-svelte';
	import { uploadsEnabled } from '$lib/stores/instance-features';
	import Button from './Button.svelte';
	import RemoteImg from './RemoteImg.svelte';

	let {
		value = $bindable(null),
		busy = $bindable(false),
		upload,
		accept = 'image/*',
		shape = 'square',
		id = undefined,
		disabled = false,
		removable = true,
		fallback = undefined
	}: {
		value?: string | null;
		busy?: boolean;
		upload: (file: File) => Promise<string | null>;
		accept?: string;
		shape?: 'square' | 'wide';
		id?: string;
		disabled?: boolean;
		removable?: boolean;
		fallback?: Snippet;
	} = $props();

	let input = $state<HTMLInputElement>();
	const shown = $derived(!!value && /^(https?:|data:|blob:|\/)/.test(value));

	async function pick(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		busy = true;
		try {
			const url = await upload(file);
			if (url) value = url;
		} finally {
			busy = false;
			target.value = '';
		}
	}
</script>

<div class="field">
	<span class="well well--{shape}">
		{#if shown && value}
			<RemoteImg src={value} class="well-img" />
		{:else if fallback}
			{@render fallback()}
		{:else}
			<ImageIcon size={16} aria-hidden="true" />
		{/if}
	</span>
	{#if $uploadsEnabled}
		<div class="actions">
			<Button size="sm" loading={busy} {disabled} onclick={() => input?.click()}>
				{value ? 'Replace' : 'Upload'}
			</Button>
			{#if value && removable}
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled || busy}
					onclick={() => (value = null)}
				>
					Remove
				</Button>
			{/if}
		</div>
		<input bind:this={input} {id} class="file" type="file" {accept} {disabled} onchange={pick} />
	{:else}
		<span class="off">Uploads need storage. An instance admin can add it.</span>
	{/if}
</div>

<style>
	.off {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.field {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.well {
		position: relative;
		display: grid;
		flex-shrink: 0;
		place-items: center;
		height: 2.75rem;
		overflow: hidden;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 0.5px var(--border-default);
		color: var(--text-faint);
	}
	.well--square {
		width: 2.75rem;
	}
	.well--wide {
		width: 5.5rem;
	}
	.well :global(.well-img) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.file {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
</style>
