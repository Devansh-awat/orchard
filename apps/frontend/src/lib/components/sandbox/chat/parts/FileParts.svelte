<script lang="ts">
	import { FileText, X } from 'lucide-svelte';
	import { ocFmtBytes, type OcAttachment } from '../../opencode';

	let {
		files,
		size = 'md',
		onremove = undefined
	}: {
		files: OcAttachment[];
		size?: 'sm' | 'md';
		onremove?: (id: string) => void;
	} = $props();
</script>

<div class="files" class:files--sm={size === 'sm'}>
	{#each files as file (file.id)}
		<div class="file" title={file.size > 0 ? `${file.name} · ${ocFmtBytes(file.size)}` : file.name}>
			{#if file.isImage}
				<img class="file-thumb" src={file.dataUrl} alt={file.name} />
			{:else}
				<span class="file-doc">
					<FileText class="h-3.5 w-3.5 shrink-0" />
					<span class="file-name">{file.name}</span>
				</span>
			{/if}
			{#if onremove}
				<button
					type="button"
					class="file-remove"
					aria-label="Remove {file.name}"
					onclick={() => onremove(file.id)}
				>
					<X class="h-3 w-3" />
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.files {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.file {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.file-thumb {
		width: 3.5rem;
		height: 3.5rem;
		object-fit: cover;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.files--sm .file-thumb {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-xs);
	}

	.file-doc {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		max-width: 14rem;
		height: 2rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.files--sm .file-doc {
		height: 2.5rem;
		border-radius: var(--radius-xs);
	}

	.file-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-remove {
		position: absolute;
		top: -0.3125rem;
		right: -0.3125rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.file-remove:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
</style>
