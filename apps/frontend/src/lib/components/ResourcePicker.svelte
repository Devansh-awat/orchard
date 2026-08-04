<script lang="ts">
	import { formatCpu, formatMemory } from '$lib/presets';

	interface Props {
		cpuMilli: number | null;
		memoryBytes: number | null;
		defaultCpuMilli?: number | null;
		defaultMemoryBytes?: number | null;
		disabled?: boolean;
		showUnlimited?: boolean;
		currentCpuUsage?: number | null;
		currentMemUsage?: number | null;
		maxCpuMilli?: number | null;
		maxMemoryBytes?: number | null;
		onchange?: (v: { cpuMilli: number | null; memoryBytes: number | null }) => void;
	}

	let {
		cpuMilli = $bindable(),
		memoryBytes = $bindable(),
		defaultCpuMilli = null,
		defaultMemoryBytes = null,
		disabled = false,
		showUnlimited = false,
		currentCpuUsage = null,
		currentMemUsage = null,
		maxCpuMilli = null,
		maxMemoryBytes = null,
		onchange
	}: Props = $props();

	// Display values — convert to user-friendly units
	let cpuInput = $state('');
	let memInput = $state('');
	let cpuUnit = $state<'m' | 'cores'>('m');
	let memUnit = $state<'MiB' | 'GiB'>('MiB');
	// Sync from props on mount / external change
	$effect(() => {
		if (cpuMilli === null && memoryBytes === null) {
			// Show org defaults as placeholder values
			if (defaultCpuMilli != null) {
				if (cpuUnit === 'cores') cpuInput = String(defaultCpuMilli / 1000);
				else cpuInput = String(defaultCpuMilli);
			}
			if (defaultMemoryBytes != null) {
				if (memUnit === 'GiB') memInput = String(+(defaultMemoryBytes / 1024 ** 3).toFixed(2));
				else memInput = String(Math.round(defaultMemoryBytes / (1024 * 1024)));
			}
		} else {
			if (cpuMilli != null) {
				if (cpuUnit === 'cores') cpuInput = String(cpuMilli / 1000);
				else cpuInput = String(cpuMilli);
			}
			if (memoryBytes != null) {
				if (memUnit === 'GiB') memInput = String(+(memoryBytes / 1024 ** 3).toFixed(2));
				else memInput = String(Math.round(memoryBytes / (1024 * 1024)));
			}
		}
	});

	function applyCpu() {
		const v = parseFloat(cpuInput);
		if (!Number.isFinite(v) || v <= 0) return;
		cpuMilli = cpuUnit === 'cores' ? Math.round(v * 1000) : Math.round(v);
		onchange?.({ cpuMilli, memoryBytes });
	}

	function applyMem() {
		const v = parseFloat(memInput);
		if (!Number.isFinite(v) || v <= 0) return;
		memoryBytes = memUnit === 'GiB' ? Math.round(v * 1024 ** 3) : Math.round(v * 1024 * 1024);
		onchange?.({ cpuMilli, memoryBytes });
	}

	// Usage percentages
	function pct(usage: number | null, limit: number | null): number | null {
		if (usage == null || limit == null || limit <= 0) return null;
		return Math.min(100, Math.round((usage / limit) * 100));
	}

	const cpuPct = $derived(pct(currentCpuUsage, cpuMilli ?? defaultCpuMilli));
	const memPct = $derived(pct(currentMemUsage, memoryBytes ?? defaultMemoryBytes));

	// Limit warnings
	const cpuOverLimit = $derived(maxCpuMilli != null && cpuMilli != null && cpuMilli > maxCpuMilli);
	const memOverLimit = $derived(
		maxMemoryBytes != null && memoryBytes != null && memoryBytes > maxMemoryBytes
	);

	function barColor(p: number): string {
		if (p >= 90) return 'var(--error-text-color)';
		if (p >= 70) return 'var(--away-indicator)';
		return 'var(--online-indicator)';
	}
</script>

<div class="rp-root">
	<div class="rp-fields">
		<!-- CPU -->
		<div class="rp-field">
			<div class="rp-field-header">
				<span class="rp-field-label">CPU</span>
				<div class="rp-unit-toggle">
					<button
						type="button"
						class="rp-unit-btn"
						class:rp-unit-btn--active={cpuUnit === 'm'}
						onclick={() => {
							cpuUnit = 'm';
							if (cpuMilli != null) cpuInput = String(cpuMilli);
						}}
						{disabled}>millicores</button
					>
					<button
						type="button"
						class="rp-unit-btn"
						class:rp-unit-btn--active={cpuUnit === 'cores'}
						onclick={() => {
							cpuUnit = 'cores';
							if (cpuMilli != null) cpuInput = String(cpuMilli / 1000);
						}}
						{disabled}>cores</button
					>
				</div>
			</div>
			<div class="rp-input-row">
				<div class="rp-input-wrap">
					<input
						type="number"
						min="1"
						step={cpuUnit === 'cores' ? '0.1' : '1'}
						bind:value={cpuInput}
						oninput={applyCpu}
						placeholder={cpuUnit === 'cores' ? '0.25' : '250'}
						{disabled}
					/>
					<span class="rp-input-unit">{cpuUnit === 'cores' ? 'cores' : 'm'}</span>
				</div>
			</div>
			{#if cpuPct != null}
				<div class="rp-bar-row">
					<div class="rp-bar-track">
						<div
							class="rp-bar-fill"
							style="width: {cpuPct}%; background-color: {barColor(cpuPct)};"
						></div>
					</div>
					<span class="rp-bar-label" style="color: {barColor(cpuPct)};">{cpuPct}% used</span>
				</div>
			{/if}
			{#if cpuOverLimit}
				<p class="rp-limit-warn">Exceeds your org limit of {formatCpu(maxCpuMilli!)}</p>
			{:else if maxCpuMilli != null}
				<p class="rp-limit-hint">Max allowed: {formatCpu(maxCpuMilli)}</p>
			{/if}
		</div>

		<!-- Memory -->
		<div class="rp-field">
			<div class="rp-field-header">
				<span class="rp-field-label">Memory</span>
				<div class="rp-unit-toggle">
					<button
						type="button"
						class="rp-unit-btn"
						class:rp-unit-btn--active={memUnit === 'MiB'}
						onclick={() => {
							memUnit = 'MiB';
							if (memoryBytes != null) memInput = String(Math.round(memoryBytes / (1024 * 1024)));
						}}
						{disabled}>MiB</button
					>
					<button
						type="button"
						class="rp-unit-btn"
						class:rp-unit-btn--active={memUnit === 'GiB'}
						onclick={() => {
							memUnit = 'GiB';
							if (memoryBytes != null) memInput = String(+(memoryBytes / 1024 ** 3).toFixed(2));
						}}
						{disabled}>GiB</button
					>
				</div>
			</div>
			<div class="rp-input-row">
				<div class="rp-input-wrap">
					<input
						type="number"
						min="1"
						step={memUnit === 'GiB' ? '0.25' : '1'}
						bind:value={memInput}
						oninput={applyMem}
						placeholder={memUnit === 'GiB' ? '0.5' : '512'}
						{disabled}
					/>
					<span class="rp-input-unit">{memUnit}</span>
				</div>
			</div>
			{#if memPct != null}
				<div class="rp-bar-row">
					<div class="rp-bar-track">
						<div
							class="rp-bar-fill"
							style="width: {memPct}%; background-color: {barColor(memPct)};"
						></div>
					</div>
					<span class="rp-bar-label" style="color: {barColor(memPct)};">{memPct}% used</span>
				</div>
			{/if}
			{#if memOverLimit}
				<p class="rp-limit-warn">Exceeds your org limit of {formatMemory(maxMemoryBytes!)}</p>
			{:else if maxMemoryBytes != null}
				<p class="rp-limit-hint">Max allowed: {formatMemory(maxMemoryBytes)}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.rp-root {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	/* Fields */
	.rp-fields {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.25rem;
	}
	.rp-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rp-field-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.rp-field-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--center-channel-color);
	}
	.rp-unit-toggle {
		display: flex;
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-xs);
		overflow: hidden;
	}
	.rp-unit-btn {
		padding: 0.25rem 0.5rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all var(--dur-fast);
	}
	.rp-unit-btn:not(:last-child) {
		border-right: 1px solid var(--surface-border);
	}
	.rp-unit-btn--active {
		background-color: var(--button-bg);
		color: var(--button-color);
	}

	/* Input */
	.rp-input-row {
		display: flex;
		gap: 0.5rem;
	}
	.rp-input-wrap {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
	}
	.rp-input-wrap input {
		flex: 1;
		width: 100%;
		padding: 0.5rem 3rem 0.5rem 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		border-radius: var(--radius-sm);
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-variant-numeric: tabular-nums;
		font-family: var(--font-mono);
	}
	.rp-input-wrap input:focus {
		outline: none;
		border-color: var(--button-bg);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--button-bg) 15%, transparent);
	}
	.rp-input-wrap input:disabled {
		opacity: 0.5;
	}
	.rp-input-unit {
		position: absolute;
		right: 0.75rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--surface-muted);
		pointer-events: none;
	}

	/* Usage bar */
	.rp-bar-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.rp-bar-track {
		flex: 1;
		height: 0.375rem;
		border-radius: var(--radius-lg);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		overflow: hidden;
	}
	.rp-bar-fill {
		height: 100%;
		border-radius: var(--radius-lg);
		transition:
			width var(--dur-base) cubic-bezier(0.22, 1, 0.36, 1),
			background-color var(--dur-base);
		min-width: 2px;
	}
	.rp-bar-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		font-family: var(--font-mono);
		white-space: nowrap;
		flex-shrink: 0;
	}

	/* Limit warnings */
	.rp-limit-warn {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--error-text-color);
		margin: 0;
		font-weight: 600;
	}
	.rp-limit-hint {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		margin: 0;
	}

	@media (max-width: 540px) {
		.rp-fields {
			grid-template-columns: 1fr;
		}
	}
</style>
