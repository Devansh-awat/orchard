<script lang="ts">
	import { ArrowUp, Folder, FolderGit2, LoaderCircle } from 'lucide-svelte';
	import { Button, Input } from '@orchardlabs/graft-ui';
	import * as api from './api';

	let {
		sandboxId,
		value = $bindable(''),
		id,
		placeholder = '~',
		autofocus = false,
		onpicked
	}: {
		sandboxId: string;
		value?: string;
		id?: string;
		placeholder?: string;
		autofocus?: boolean;
		onpicked?: (path: string, git: boolean) => void;
	} = $props();

	let browsing = $state(false);
	let listing = $state<api.GhDirListing | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let request = 0;

	async function show(path: string) {
		const mine = ++request;
		loading = true;
		error = null;
		const res = await api.listDirs(sandboxId, path);
		if (mine !== request) return;
		loading = false;
		if (res.ok) listing = res.data;
		else error = res.message;
	}

	function toggle() {
		browsing = !browsing;
		if (browsing) void show(value.trim() || '~');
	}

	function use(path: string, git: boolean) {
		value = api.displayPath(path);
		browsing = false;
		onpicked?.(path, git);
	}
</script>

<div class="picker">
	<div class="row">
		<Input
			{id}
			bind:value
			{placeholder}
			{autofocus}
			class="path"
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
		/>
		<Button variant="secondary" aria-expanded={browsing} onclick={toggle}>
			{browsing ? 'Close' : 'Browse'}
		</Button>
	</div>
	{#if browsing}
		<div class="browser">
			<div class="bar">
				<button
					type="button"
					class="up"
					aria-label="Up one folder"
					disabled={!listing?.parent || loading}
					onclick={() => listing?.parent && show(listing.parent)}
				>
					<ArrowUp size={14} />
				</button>
				<span class="here" title={listing?.path}>
					{listing ? api.displayPath(listing.path) : ' '}
				</span>
				{#if loading}
					<span class="spin animate-spin" data-motion="progress" aria-label="Loading">
						<LoaderCircle size={14} />
					</span>
				{/if}
				<Button
					size="sm"
					variant="primary"
					disabled={!listing || loading}
					onclick={() => listing && use(listing.path, listing.git)}
				>
					Use this folder
				</Button>
			</div>
			{#if error}
				<p class="note error">{error}</p>
			{:else if listing && listing.entries.length === 0}
				<p class="note">No folders in here</p>
			{:else if listing}
				<ul class="list">
					{#each listing.entries as entry (entry.path)}
						<li>
							<button type="button" class="entry" onclick={() => show(entry.path)}>
								{#if entry.git}
									<FolderGit2 size={14} />
								{:else}
									<Folder size={14} />
								{/if}
								<span class="name">{entry.name}</span>
								{#if entry.git}<span class="tag">git</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
				{#if listing.truncated}
					<p class="note">Showing the first {listing.entries.length} folders</p>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.row {
		display: flex;
		gap: 0.5rem;
	}

	.row :global(.path) {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
	}

	.browser {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-row);
		overflow: hidden;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.375rem 0.375rem 0.5rem;
		border-bottom: 1px solid var(--gh-line);
		background: var(--bg-sunken);
	}

	.up {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
	}

	.up:hover:not(:disabled) {
		background: var(--gh-hover);
		color: var(--text-default);
	}

	.up:disabled {
		opacity: 0.4;
	}

	.here {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.spin {
		display: inline-flex;
		color: var(--text-faint);
	}

	.list {
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		max-height: 14rem;
		overflow-y: auto;
	}

	.entry {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		text-align: left;
	}

	.entry:hover,
	.entry:focus-visible {
		background: var(--gh-hover);
		color: var(--text-default);
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-default);
	}

	.tag {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}

	.note {
		margin: 0;
		padding: 0.75rem;
		font-size: var(--text-caption);
		color: var(--text-faint);
	}

	.note.error {
		color: var(--status-error);
	}
</style>
