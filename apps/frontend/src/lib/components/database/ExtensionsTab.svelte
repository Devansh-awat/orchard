<script lang="ts">
	import { Loader2, RefreshCw, Plus } from 'lucide-svelte';
	import { Button, Input, StatusBadge, statusMeta, SectionCard, EmptyState } from '$lib/components/ui';
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

<SectionCard title="Extensions">
	{#snippet actions()}
		{#if database.mode === 'cnpg'}
			<Input
				type="search"
				placeholder="Search extensions…"
				class="text-sm"
				style="max-width: 20rem;"
				bind:value={extensionSearch}
			/>
			<Button
				variant="secondary"
				size="sm"
				onclick={onFetchExtensions}
				loading={extensionsLoading}
				aria-label="Refresh"
			>
				{#if !extensionsLoading}<RefreshCw class="h-3.5 w-3.5" />{/if}
			</Button>
		{/if}
	{/snippet}

	{#if database.mode !== 'cnpg'}
		<EmptyState
			title="Extensions need a dedicated database"
			description="Extension management is only available for CNPG-backed databases."
		/>
	{:else if extensionsLoading && filteredExtensions.length === 0}
		<div class="db-empty-box flex items-center gap-2">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span class="text-sm" style="color: var(--surface-muted);">Loading extensions…</span>
		</div>
	{:else if filteredExtensions.length === 0}
		<EmptyState title="No matches" description="No extensions match your search." />
	{:else}
		<div class="space-y-2">
			{#each filteredExtensions as ext (ext.name)}
				<div class="db-list-row">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 flex-wrap">
							<span class="db-list-name">{ext.name}</span>
							{#if ext.installed}
								<StatusBadge
									meta={statusMeta('success', `installed${ext.version ? ` · ${ext.version}` : ''}`)}
								/>
							{:else}
								<StatusBadge
									meta={statusMeta(
										'neutral',
										`available${ext.defaultVersion ? ` · ${ext.defaultVersion}` : ''}`
									)}
								/>
							{/if}
							{#if preloadedExts.includes(ext.name)}
								<StatusBadge meta={statusMeta('warning', 'preloaded')} />
							{/if}
						</div>
						{#if ext.description}
							<div class="db-list-meta">{ext.description}</div>
						{/if}
					</div>
					{#if ext.installed}
						<Button
							variant="secondary"
							size="sm"
							class="shrink-0"
							onclick={() => onUninstallExtension(ext.name, preloadedExts.includes(ext.name))}
							loading={busyExtension === ext.name}
						>
							Uninstall
						</Button>
					{:else}
						<Button
							variant="primary"
							size="sm"
							class="shrink-0"
							onclick={() => onInstallExtension(ext.name, Boolean(ext.requiresPreload))}
							loading={busyExtension === ext.name}
						>
							{#if busyExtension !== ext.name}<Plus class="h-3.5 w-3.5" />{/if}
							Install
						</Button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</SectionCard>
