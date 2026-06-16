<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { isSuperAdmin } from '$lib/stores';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';
	import { springHover } from '$lib/utils/motion.svelte';

	let {
		database,
		resourceCpuMilli = $bindable<number | null>(),
		resourceMemoryBytes = $bindable<number | null>(),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit = null,
		effectiveMemLimit = null,
		resourcesDirty = $bindable<boolean>(),
		savingResources,
		onSaveResources
	}: {
		database: any;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit?: number | null;
		effectiveMemLimit?: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		onSaveResources: () => void;
	} = $props();

	const currentLabel = $derived.by(() => {
		if (resourceCpuMilli === 0 && resourceMemoryBytes === 0) return 'Unlimited';
		if (resourceCpuMilli != null && resourceMemoryBytes != null)
			return `${fmtCpuPreset(resourceCpuMilli)} · ${fmtMemoryPreset(resourceMemoryBytes)}`;
		return 'Organization default';
	});
</script>

<div class="rt-stack">
	<section class="rt-card">
		<div class="rt-card-header">
			<h3 class="rt-card-title">CPU & Memory</h3>
			<div class="rt-current-badge">
				{currentLabel}
			</div>
		</div>

		<div class="rt-card-body">
			<ResourcePicker
				bind:cpuMilli={resourceCpuMilli}
				bind:memoryBytes={resourceMemoryBytes}
				defaultCpuMilli={orgDefaultCpuMilli}
				defaultMemoryBytes={orgDefaultMemoryBytes}
				showUnlimited={$isSuperAdmin}
				maxCpuMilli={effectiveCpuLimit}
				maxMemoryBytes={effectiveMemLimit}
				onchange={() => {
					resourcesDirty = true;
				}}
			/>
			<div class="rt-actions">
				<button
					class="rt-btn rt-btn--ghost"
					disabled={!resourcesDirty || savingResources}
					onclick={() => {
						resourceCpuMilli = database?.cpuRequestMilli ?? null;
						resourceMemoryBytes =
							database?.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null;
						resourcesDirty = false;
					}}>Reset</button
				>
				<button
					class="rt-btn rt-btn--primary"
					disabled={!resourcesDirty || savingResources}
					onclick={onSaveResources}
					{@attach springHover({ lift: -1, stiffness: 400, damping: 24 })}
				>
					{#if savingResources}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					{savingResources ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</section>
</div>

<style>
	.rt-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.rt-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.rt-card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem;
	}
	.rt-card-title {
		font-size: 0.9375rem;
		font-weight: 650;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}
	.rt-current-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.625rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 600;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
		font-family: var(--font-mono);
	}
	.rt-card-body {
		padding: 0 1.5rem 1.5rem;
	}
	.rt-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.rt-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
	}
	.rt-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rt-btn--primary {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.rt-btn--primary:hover:not(:disabled) {
		opacity: 0.9;
	}
	.rt-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.rt-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}
</style>
