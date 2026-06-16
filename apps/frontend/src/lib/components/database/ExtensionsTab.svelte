<script lang="ts">
	import { Loader2, RefreshCw, Plus } from 'lucide-svelte';
	import type { DatabaseDetail, ExtInfo } from './types';

	let {
		database,
		filteredExtensions,
		preloadedExts,
		extensionsLoading,
		extensionSearch = $bindable(),
		busyExtension,
		onFetchExtensions,
		onInstallExtension,
		onUninstallExtension
	}: {
		database: DatabaseDetail;
		filteredExtensions: Array<
			ExtInfo & { description?: string; requiresPreload?: boolean; featured?: boolean }
		>;
		preloadedExts: string[];
		extensionsLoading: boolean;
		extensionSearch: string;
		busyExtension: string | null;
		onFetchExtensions: () => void;
		onInstallExtension: (name: string, addToPreload: boolean) => void;
		onUninstallExtension: (name: string, removeFromPreload: boolean) => void;
	} = $props();
</script>

<div class="card rounded-2xl p-5">
	<div class="flex items-center justify-between gap-3 mb-4 flex-wrap">
		<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Extensions</p>
		{#if database.mode === 'cnpg'}
			<div class="flex items-center gap-2 flex-1 justify-end" style="min-width: 200px;">
				<input
					type="search"
					placeholder="Search extensions…"
					class="input text-sm"
					style="max-width: 20rem;"
					bind:value={extensionSearch}
				/>
				<button
					class="btn btn-secondary btn-sm"
					onclick={onFetchExtensions}
					disabled={extensionsLoading}
					aria-label="Refresh"
				>
					{#if extensionsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>
		{/if}
	</div>

	{#if database.mode !== 'cnpg'}
		<div class="db-empty-box">
			<p class="text-sm" style="color: var(--surface-muted);">
				Extension management is only available for CNPG-backed databases. Recreate this database to
				enable it.
			</p>
		</div>
	{:else if extensionsLoading && filteredExtensions.length === 0}
		<div class="db-empty-box flex items-center gap-2">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span class="text-sm" style="color: var(--surface-muted);">Loading extensions…</span>
		</div>
	{:else if filteredExtensions.length === 0}
		<div class="db-empty-box">
			<p class="text-sm" style="color: var(--surface-muted);">No extensions match your search.</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each filteredExtensions as ext (ext.name)}
				<div class="db-list-row">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 flex-wrap">
							<span class="db-list-name">{ext.name}</span>
							{#if ext.installed}
								<span class="db-status-pill db-status-pill-completed"
									>installed{ext.version ? ` · ${ext.version}` : ''}</span
								>
							{:else}
								<span class="db-status-pill db-status-pill-muted"
									>available{ext.defaultVersion ? ` · ${ext.defaultVersion}` : ''}</span
								>
							{/if}
							{#if preloadedExts.includes(ext.name)}
								<span class="db-status-pill db-status-pill-warn">preloaded</span>
							{/if}
						</div>
						{#if ext.description}
							<div class="db-list-meta">{ext.description}</div>
						{/if}
					</div>
					{#if ext.installed}
						<button
							class="btn btn-secondary btn-sm shrink-0"
							onclick={() => onUninstallExtension(ext.name, preloadedExts.includes(ext.name))}
							disabled={busyExtension === ext.name}
						>
							{#if busyExtension === ext.name}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							<span>Uninstall</span>
						</button>
					{:else}
						<button
							class="btn btn-primary btn-sm shrink-0"
							onclick={() => onInstallExtension(ext.name, Boolean(ext.requiresPreload))}
							disabled={busyExtension === ext.name}
						>
							{#if busyExtension === ext.name}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{:else}<Plus class="h-3.5 w-3.5" />{/if}
							<span>Install</span>
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
