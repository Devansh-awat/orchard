<script lang="ts">
	import { Loader2, X as XIcon, Smile, Upload, Image as ImageIcon, Trash2 } from 'lucide-svelte';
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

	let iconMode = $state<'emoji' | 'image'>('emoji');
	let emojiValue = $state('');
	const emojiSuggestions = ['🚀', '⚡', '✨', '🌱', '🔥', '🧪', '📦', '🛠️', '🌊', '🎯', '🧩', '🪐'];
	let savingCustom = $state(false);
	let uploadingIcon = $state(false);
	let uploadingBg = $state(false);
	let iconPreview = $state<string | null>(null);
	let bgPreview = $state<string | null>(null);
	let nameValue = $state('');

	function isImageUrl(v?: string | null) {
		return !!v && /^https?:\/\//.test(v);
	}

	// Reset state when modal opens
	$effect(() => {
		if (open) {
			const icon = project?.icon ?? '';
			if (icon && isImageUrl(icon)) {
				iconMode = 'image';
				iconPreview = icon;
				emojiValue = '';
			} else {
				iconMode = 'emoji';
				emojiValue = icon;
				iconPreview = null;
			}
			bgPreview = project?.backgroundImage ?? null;
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
			if (url) iconPreview = url;
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
			if (url) bgPreview = url;
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
			if (iconMode === 'emoji') {
				payload.icon = emojiValue.trim() || null;
			}
			if (bgPreview === null && project.backgroundImage) {
				payload.backgroundImage = null;
			}
			if (iconMode === 'emoji' && project.icon && isImageUrl(project.icon)) {
				if (!emojiValue.trim()) payload.icon = null;
			}
			const trimmedName = nameValue.trim();
			if (trimmedName && trimmedName !== project.name) {
				payload.name = trimmedName;
			}
			await onSave(payload);
			open = false;
		} finally {
			savingCustom = false;
		}
	}

	function clearBg() {
		bgPreview = null;
	}
</script>

{#if open}
	<div class="cm-overlay" onclick={() => (open = false)} role="presentation">
		<div
			class="cm-modal"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label="Customize project"
		>
			<button class="cm-close" onclick={() => (open = false)} aria-label="Close">
				<XIcon class="h-4 w-4" />
			</button>

			<div
				class="cm-hero"
				style={bgPreview ? `background-image: url(${JSON.stringify(bgPreview)});` : ''}
			>
				{#if bgPreview}
					<div class="cm-hero-scrim"></div>
				{:else}
					<div class="cm-hero-placeholder" aria-hidden="true"></div>
				{/if}
				<span class="cm-hero-eyebrow">Preview</span>
				<div class="cm-hero-content">
					<h2 class="cm-hero-title">
						<span
							class="cm-hero-icon"
							class:cm-hero-icon--empty={!(iconMode === 'emoji' ? emojiValue.trim() : iconPreview)}
						>
							{#if iconMode === 'emoji' && emojiValue.trim()}
								<span class="cm-hero-emoji">{emojiValue.trim()}</span>
							{:else if iconMode === 'image' && iconPreview}
								<img src={iconPreview} alt="" />
							{:else}
								<Smile class="h-4 w-4" />
							{/if}
						</span>
						<span class="cm-hero-label"
							>{#if project?.owner?.username}<span class="cm-hero-owner"
									>{project.owner.username}@</span
								>{/if}{nameValue.trim() || project?.name || 'Project'}</span
						>
					</h2>
				</div>
			</div>

			<div class="cm-body">
				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Name</h3>
					</div>
					<input
						type="text"
						class="cm-input"
						placeholder="Project name"
						maxlength="255"
						bind:value={nameValue}
					/>
				</section>

				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Icon</h3>
						<div class="cm-segmented" role="tablist" aria-label="Icon source">
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'emoji'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'emoji'}
								onclick={() => (iconMode = 'emoji')}>Emoji</button
							>
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'image'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'image'}
								onclick={() => (iconMode = 'image')}>Image</button
							>
						</div>
					</div>

					{#if iconMode === 'emoji'}
						<div class="cm-emoji-grid" role="radiogroup" aria-label="Emoji suggestions">
							{#each emojiSuggestions as emoji (emoji)}
								<button
									type="button"
									role="radio"
									aria-checked={emojiValue.trim() === emoji}
									class="cm-emoji-chip"
									class:cm-emoji-chip--active={emojiValue.trim() === emoji}
									onclick={() => (emojiValue = emoji)}>{emoji}</button
								>
							{/each}
						</div>
						<div class="cm-emoji-custom">
							<input
								type="text"
								class="cm-input"
								placeholder="or paste any emoji…"
								maxlength="8"
								bind:value={emojiValue}
							/>
						</div>
					{:else}
						<label class="cm-drop" class:cm-drop--filled={!!iconPreview}>
							{#if uploadingIcon}
								<div class="cm-drop-state">
									<Loader2 class="h-5 w-5 animate-spin" />
									<span>Uploading…</span>
								</div>
							{:else if iconPreview}
								<div class="cm-drop-filled">
									<img
										src={iconPreview}
										alt="Project icon preview"
										class="cm-drop-thumb cm-drop-thumb--square"
									/>
									<div class="cm-drop-meta">
										<span class="cm-drop-meta-title">Icon uploaded</span>
										<span class="cm-drop-meta-hint">Click to replace</span>
									</div>
								</div>
							{:else}
								<div class="cm-drop-state">
									<div class="cm-drop-icon"><Upload class="h-5 w-5" /></div>
									<div class="cm-drop-text">
										<span class="cm-drop-title">Upload icon</span>
										<span class="cm-drop-hint">PNG, JPG, SVG · up to 2 MB</span>
									</div>
								</div>
							{/if}
							<input
								type="file"
								accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
								onchange={handleIconFile}
								disabled={uploadingIcon}
							/>
						</label>
					{/if}
				</section>

				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Background</h3>
						{#if bgPreview}
							<button type="button" class="cm-text-btn" onclick={clearBg}>
								<Trash2 class="h-3.5 w-3.5" /> Remove
							</button>
						{/if}
					</div>

					<label class="cm-drop" class:cm-drop--filled={!!bgPreview}>
						{#if uploadingBg}
							<div class="cm-drop-state">
								<Loader2 class="h-5 w-5 animate-spin" />
								<span>Uploading…</span>
							</div>
						{:else if bgPreview}
							<div class="cm-drop-filled">
								<img
									src={bgPreview}
									alt="Background preview"
									class="cm-drop-thumb cm-drop-thumb--wide"
								/>
								<div class="cm-drop-meta">
									<span class="cm-drop-meta-title">Background set</span>
									<span class="cm-drop-meta-hint">Click to replace</span>
								</div>
							</div>
						{:else}
							<div class="cm-drop-state">
								<div class="cm-drop-icon"><ImageIcon class="h-5 w-5" /></div>
								<div class="cm-drop-text">
									<span class="cm-drop-title">Upload background</span>
									<span class="cm-drop-hint">PNG, JPG, WebP · up to 8 MB</span>
								</div>
							</div>
						{/if}
						<input
							type="file"
							accept="image/png,image/jpeg,image/webp"
							onchange={handleBgFile}
							disabled={uploadingBg}
						/>
					</label>
				</section>
			</div>

			<div class="cm-footer">
				<button
					class="pj-btn pj-btn-secondary"
					onclick={() => (open = false)}
					disabled={savingCustom}
				>
					Cancel
				</button>
				<button
					class="pj-btn pj-btn-primary"
					onclick={save}
					disabled={savingCustom || uploadingIcon || uploadingBg}
				>
					{#if savingCustom}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Save changes
				</button>
			</div>
		</div>
	</div>
{/if}
