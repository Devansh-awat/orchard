<script lang="ts">
	import { Image as ImageIcon } from 'lucide-svelte';
	import { Button, Field, Input, Modal } from '$lib/components/ui';
	import type { Project } from './types';

	let {
		project,
		open = $bindable(false),
		onSave,
		onIconUpload,
		onBgUpload
	}: {
		project: Project;
		open?: boolean;
		onSave: (payload: {
			icon?: string | null;
			backgroundImage?: string | null;
			name?: string;
		}) => Promise<void>;
		onIconUpload: (file: File) => Promise<string | null>;
		onBgUpload: (file: File) => Promise<string | null>;
	} = $props();

	let savingCustom = $state(false);
	let uploadingIcon = $state(false);
	let uploadingBg = $state(false);
	let iconValue = $state<string | null>(null);
	let bgValue = $state<string | null>(null);
	let nameValue = $state('');
	let iconInput = $state<HTMLInputElement | undefined>();
	let bgInput = $state<HTMLInputElement | undefined>();

	function isImageUrl(v?: string | null) {
		return !!v && /^https?:\/\//.test(v);
	}

	$effect(() => {
		if (open) {
			iconValue = project?.icon ?? null;
			bgValue = project?.backgroundImage ?? null;
			nameValue = project?.name ?? '';
		}
	});

	async function handleIconFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingIcon = true;
		try {
			const url = await onIconUpload(file);
			if (url) iconValue = url;
		} finally {
			uploadingIcon = false;
			input.value = '';
		}
	}

	async function handleBgFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingBg = true;
		try {
			const url = await onBgUpload(file);
			if (url) bgValue = url;
		} finally {
			uploadingBg = false;
			input.value = '';
		}
	}

	async function save() {
		if (savingCustom) return;
		savingCustom = true;
		try {
			const payload: Record<string, string | null> = {};
			if (iconValue !== (project.icon ?? null)) payload.icon = iconValue;
			if (bgValue !== (project.backgroundImage ?? null)) payload.backgroundImage = bgValue;
			const trimmedName = nameValue.trim();
			if (trimmedName && trimmedName !== project.name) payload.name = trimmedName;
			await onSave(payload);
			open = false;
		} finally {
			savingCustom = false;
		}
	}
</script>

<Modal bind:open size="sm" title="Customize project">
	<div class="cm-preview" class:cm-preview--hasbg={!!bgValue}>
		{#if bgValue}
			<span class="cm-wash" style="--cm-img: url({JSON.stringify(bgValue)});" aria-hidden="true">
				<span class="cm-mesh cm-mesh--1"></span>
				<span class="cm-mesh cm-mesh--2"></span>
				<span class="cm-mesh cm-mesh--3"></span>
			</span>
			<span class="cm-scrim" aria-hidden="true"></span>
		{/if}
		<span class="cm-preview-row">
			<span class="cm-well cm-well--square cm-well--onpreview">
				{#if isImageUrl(iconValue)}
					<img src={iconValue} alt="" />
				{:else if iconValue}
					<span class="cm-glyph">{iconValue}</span>
				{:else}
					<ImageIcon class="h-4 w-4" />
				{/if}
			</span>
			<span class="cm-preview-name">
				{#if project?.owner?.username}<span class="cm-preview-owner">{project.owner.username}@</span
					>{/if}{nameValue.trim() || project?.name || 'Project'}
			</span>
		</span>
	</div>

	<div class="cm-form">
		<Field label="Name" for="cm-name">
			<Input id="cm-name" placeholder="Project name" maxlength={255} bind:value={nameValue} />
		</Field>

		<Field label="Icon" hint="PNG, JPG or SVG, up to 2 MB">
			<div class="cm-media">
				<span class="cm-well cm-well--square">
					{#if isImageUrl(iconValue)}
						<img src={iconValue} alt="" />
					{:else if iconValue}
						<span class="cm-glyph">{iconValue}</span>
					{:else}
						<ImageIcon class="h-4 w-4" />
					{/if}
				</span>
				<div class="cm-actions">
					<Button
						variant="secondary"
						size="sm"
						loading={uploadingIcon}
						onclick={() => iconInput?.click()}
					>
						{iconValue ? 'Replace' : 'Choose'}
					</Button>
					{#if iconValue}
						<Button variant="ghost" size="sm" onclick={() => (iconValue = null)}>Remove</Button>
					{/if}
				</div>
			</div>
			<input
				bind:this={iconInput}
				class="cm-file"
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
				onchange={handleIconFile}
			/>
		</Field>

		<Field label="Background" hint="PNG, JPG or WebP, up to 8 MB">
			<div class="cm-media">
				<span class="cm-well cm-well--wide">
					{#if bgValue}
						<img src={bgValue} alt="" />
					{:else}
						<ImageIcon class="h-4 w-4" />
					{/if}
				</span>
				<div class="cm-actions">
					<Button
						variant="secondary"
						size="sm"
						loading={uploadingBg}
						onclick={() => bgInput?.click()}
					>
						{bgValue ? 'Replace' : 'Choose'}
					</Button>
					{#if bgValue}
						<Button variant="ghost" size="sm" onclick={() => (bgValue = null)}>Remove</Button>
					{/if}
				</div>
			</div>
			<input
				bind:this={bgInput}
				class="cm-file"
				type="file"
				accept="image/png,image/jpeg,image/webp"
				onchange={handleBgFile}
			/>
		</Field>
	</div>

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)} disabled={savingCustom}
			>Cancel</Button
		>
		<Button
			variant="primary"
			loading={savingCustom}
			disabled={uploadingIcon || uploadingBg}
			onclick={save}
		>
			Save
		</Button>
	{/snippet}
</Modal>

<style>
	.cm-preview {
		position: relative;
		display: flex;
		align-items: center;
		overflow: hidden;
		height: 5rem;
		margin-bottom: var(--space-5);
		padding: 0 var(--space-4);
		border-radius: var(--radius-lg);
		background-image: linear-gradient(
			120deg,
			color-mix(in srgb, var(--accent) 16%, transparent),
			transparent 70%
		);
		background-color: var(--bg-sunken);
	}

	.cm-wash {
		position: absolute;
		inset: 0;
		overflow: hidden;
		border-radius: inherit;
	}

	.cm-mesh {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 200%;
		aspect-ratio: 1;
		background-image: var(--cm-img, none);
		background-size: cover;
		background-position: center;
	}

	.cm-mesh--1 {
		opacity: 0.9;
		animation: cm-spin-a 28s linear infinite;
	}

	.cm-mesh--2 {
		opacity: 0.55;
		animation: cm-spin-b 44s linear infinite;
	}

	.cm-mesh--3 {
		opacity: 0.4;
		animation: cm-spin-c 60s linear infinite;
	}

	@keyframes cm-spin-a {
		from {
			transform: translate(-50%, -50%) scale(1.1) rotate(0deg);
		}
		to {
			transform: translate(-50%, -50%) scale(1.1) rotate(360deg);
		}
	}

	@keyframes cm-spin-b {
		from {
			transform: translate(-50%, -50%) scale(1.45) rotate(70deg);
		}
		to {
			transform: translate(-50%, -50%) scale(1.45) rotate(430deg);
		}
	}

	@keyframes cm-spin-c {
		from {
			transform: translate(-50%, -50%) scale(1.8) rotate(140deg);
		}
		to {
			transform: translate(-50%, -50%) scale(1.8) rotate(-220deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.cm-mesh--1,
		.cm-mesh--2,
		.cm-mesh--3 {
			animation: none;
		}
	}

	.cm-scrim {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background-image: linear-gradient(
			90deg,
			color-mix(in srgb, var(--bg-raised) 78%, transparent),
			color-mix(in srgb, var(--bg-raised) 30%, transparent)
		);
	}

	.cm-preview-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.cm-well--onpreview {
		background-color: color-mix(in srgb, var(--bg-raised) 85%, transparent);
	}

	.cm-preview-name {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 650;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cm-preview-owner {
		color: var(--text-faint);
		font-weight: 500;
	}

	.cm-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.cm-media {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.cm-well {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		overflow: hidden;
		border-radius: var(--radius-md);
		background-color: var(--fill-soft);
		color: var(--text-faint);
	}

	.cm-well img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.cm-well--square {
		width: 2.75rem;
		height: 2.75rem;
	}

	.cm-well--wide {
		width: 6.5rem;
		height: 2.75rem;
	}

	.cm-glyph {
		font-size: 1.25rem;
		line-height: 1;
	}

	.cm-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.cm-file {
		display: none;
	}
</style>
