<script lang="ts">
	import { RESOURCE_PRESETS, matchPreset, formatCpu, formatMemory, type ResourcePreset } from '$lib/presets';
	import { Check, Infinity as InfinityIcon } from 'lucide-svelte';

	interface Props {
		cpuMilli: number | null;
		memoryBytes: number | null;
		defaultCpuMilli?: number | null;
		defaultMemoryBytes?: number | null;
		disabled?: boolean;
		showUnlimited?: boolean;
		onchange?: (v: { cpuMilli: number | null; memoryBytes: number | null }) => void;
	}

	let {
		cpuMilli = $bindable(),
		memoryBytes = $bindable(),
		defaultCpuMilli = null,
		defaultMemoryBytes = null,
		disabled = false,
		showUnlimited = false,
		onchange,
	}: Props = $props();

	// User explicitly picked "Custom" — sticks even when their values happen to match a preset.
	let customLocked = $state(false);

	const isUnlimited = $derived(cpuMilli === 0 && memoryBytes === 0);

	const selectedId = $derived(
		isUnlimited
			? 'unlimited'
			: customLocked
				? 'custom'
				: cpuMilli === null && memoryBytes === null
					? 'default'
					: cpuMilli != null && memoryBytes != null
						? (matchPreset(cpuMilli, memoryBytes) ?? 'custom')
						: 'custom',
	);

	let customCpu = $state('');
	let customMem = $state('');

	function pick(preset: ResourcePreset) {
		if (disabled) return;
		customLocked = false;
		cpuMilli = preset.cpuMilli;
		memoryBytes = preset.memoryBytes;
		onchange?.({ cpuMilli, memoryBytes });
	}

	function pickDefault() {
		if (disabled) return;
		customLocked = false;
		cpuMilli = null;
		memoryBytes = null;
		onchange?.({ cpuMilli: null, memoryBytes: null });
	}

	function pickUnlimited() {
		if (disabled) return;
		customLocked = false;
		cpuMilli = 0;
		memoryBytes = 0;
		onchange?.({ cpuMilli: 0, memoryBytes: 0 });
	}

	function pickCustom() {
		if (disabled) return;
		customLocked = true;
		const initCpu = cpuMilli ?? defaultCpuMilli ?? 100;
		const initMem = memoryBytes ?? defaultMemoryBytes ?? 128 * 1024 * 1024;
		cpuMilli = initCpu;
		memoryBytes = initMem;
		customCpu = String(initCpu);
		customMem = String(Math.round(initMem / (1024 * 1024)));
		onchange?.({ cpuMilli, memoryBytes });
	}

	function applyCustom() {
		if (disabled) return;
		const c = parseInt(customCpu, 10);
		const m = parseInt(customMem, 10);
		if (Number.isFinite(c) && c > 0) cpuMilli = c;
		if (Number.isFinite(m) && m > 0) memoryBytes = m * 1024 * 1024;
		onchange?.({ cpuMilli, memoryBytes });
	}
</script>

<div class="rp-root">
	<div class="rp-grid">
		<button
			type="button"
			class="rp-card"
			class:is-selected={selectedId === 'default'}
			onclick={pickDefault}
			{disabled}
			aria-pressed={selectedId === 'default'}
		>
			{#if selectedId === 'default'}<span class="rp-check"><Check class="h-2.5 w-2.5" strokeWidth={3} /></span>{/if}
			<div class="rp-title">Default</div>
			<div class="rp-value">
				{#if defaultCpuMilli != null && defaultMemoryBytes != null}
					{formatCpu(defaultCpuMilli)} · {formatMemory(defaultMemoryBytes)}
				{:else}
					From org
				{/if}
			</div>
		</button>

		{#if showUnlimited}
			<button
				type="button"
				class="rp-card rp-card-unlimited"
				class:is-selected={selectedId === 'unlimited'}
				onclick={pickUnlimited}
				{disabled}
				aria-pressed={selectedId === 'unlimited'}
			>
				{#if selectedId === 'unlimited'}<span class="rp-check"><Check class="h-2.5 w-2.5" strokeWidth={3} /></span>{/if}
				<div class="rp-title">Unlimited</div>
				<div class="rp-value">No limits</div>
			</button>
		{/if}

		{#each RESOURCE_PRESETS as preset}
			<button
				type="button"
				class="rp-card"
				class:is-selected={selectedId === preset.id}
				onclick={() => pick(preset)}
				{disabled}
				aria-pressed={selectedId === preset.id}
			>
				{#if selectedId === preset.id}<span class="rp-check"><Check class="h-2.5 w-2.5" strokeWidth={3} /></span>{/if}
				<div class="rp-title">{preset.label}</div>
				<div class="rp-value">{formatCpu(preset.cpuMilli)} · {formatMemory(preset.memoryBytes)}</div>
			</button>
		{/each}

		<button
			type="button"
			class="rp-card"
			class:is-selected={selectedId === 'custom'}
			onclick={pickCustom}
			{disabled}
			aria-pressed={selectedId === 'custom'}
		>
			{#if selectedId === 'custom'}<span class="rp-check"><Check class="h-2.5 w-2.5" strokeWidth={3} /></span>{/if}
			<div class="rp-title">Custom</div>
			<div class="rp-value">
				{#if selectedId === 'custom' && cpuMilli != null && memoryBytes != null}
					{formatCpu(cpuMilli)} · {formatMemory(memoryBytes)}
				{:else}
					Set your own
				{/if}
			</div>
		</button>
	</div>

	{#if selectedId === 'custom'}
		<div class="rp-custom">
			<label class="rp-field">
				<span class="rp-field-label">CPU</span>
				<div class="rp-input-wrap">
					<input type="number" min="1" bind:value={customCpu} oninput={applyCustom} placeholder="500" {disabled} />
					<span class="rp-unit">m</span>
				</div>
			</label>
			<label class="rp-field">
				<span class="rp-field-label">Memory</span>
				<div class="rp-input-wrap">
					<input type="number" min="1" bind:value={customMem} oninput={applyCustom} placeholder="1024" {disabled} />
					<span class="rp-unit">MiB</span>
				</div>
			</label>
		</div>
	{/if}
</div>

<style>
	.rp-root { display: flex; flex-direction: column; gap: 0.75rem; }

	.rp-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 0.375rem;
	}

	.rp-card {
		position: relative;
		text-align: left;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		border-radius: 0.5rem;
		cursor: pointer;
		transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
	}

	.rp-card:hover:not(:disabled):not(.is-selected) {
		border-color: color-mix(in srgb, var(--button-bg) 40%, var(--surface-border));
	}

	.rp-card:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--button-bg) 30%, transparent);
	}

	.rp-card:disabled { opacity: 0.5; cursor: not-allowed; }

	.rp-card.is-selected {
		border-color: var(--button-bg);
		background-color: color-mix(in srgb, var(--button-bg) 8%, var(--center-channel-bg));
		box-shadow: 0 0 0 1px var(--button-bg);
	}

	.rp-check {
		position: absolute;
		top: 0.375rem;
		right: 0.375rem;
		width: 0.875rem;
		height: 0.875rem;
		border-radius: 999px;
		background-color: var(--button-bg);
		color: #fff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.rp-title {
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.1;
		color: var(--center-channel-color);
		padding-right: 1rem;
	}

	.rp-card.is-selected .rp-title {
		color: var(--button-bg);
	}

	.rp-value {
		margin-top: 0.25rem;
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.2;
		font-variant-numeric: tabular-nums;
		color: var(--surface-muted);
	}

	.rp-card.is-selected .rp-value {
		color: var(--center-channel-color);
	}

	.rp-custom {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		padding: 0.75rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
	}

	.rp-field { display: flex; flex-direction: column; gap: 0.25rem; }

	.rp-field-label {
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--surface-muted);
	}

	.rp-input-wrap { position: relative; display: flex; align-items: center; }

	.rp-input-wrap input {
		flex: 1;
		width: 100%;
		padding: 0.375rem 2.25rem 0.375rem 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		border-radius: 0.375rem;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}

	.rp-input-wrap input:focus {
		outline: none;
		border-color: var(--button-bg);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--button-bg) 20%, transparent);
	}

	.rp-unit {
		position: absolute;
		right: 0.625rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		pointer-events: none;
	}

	.rp-card-unlimited.is-selected {
		border-color: #f59e0b;
		background-color: color-mix(in srgb, #f59e0b 8%, var(--center-channel-bg));
		box-shadow: 0 0 0 1px #f59e0b;
	}

	.rp-card-unlimited.is-selected .rp-title {
		color: #f59e0b;
	}

	.rp-card-unlimited.is-selected .rp-check {
		background-color: #f59e0b;
	}

	@media (max-width: 540px) {
		.rp-grid { grid-template-columns: repeat(2, 1fr); }
		.rp-custom { grid-template-columns: 1fr; }
	}
</style>
