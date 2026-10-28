<script lang="ts">
	import { formatCpu, formatMemory } from '$lib/presets';
	import { Field, Input, SegmentedControl } from '$lib/components/ui';
	import Progress from '$lib/components/ui/Progress.svelte';

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

	const uid = $props.id();

	type CpuUnit = 'm' | 'cores';
	type MemUnit = 'MiB' | 'GiB';

	const CPU_UNITS = [
		{ value: 'm', label: 'Millicores' },
		{ value: 'cores', label: 'Cores' }
	];
	const MEM_UNITS = [
		{ value: 'MiB', label: 'MiB' },
		{ value: 'GiB', label: 'GiB' }
	];

	let cpuInput = $state('');
	let memInput = $state('');
	let cpuUnit = $state<CpuUnit>('m');
	let memUnit = $state<MemUnit>('MiB');

	function cpuText(milli: number, unit: CpuUnit) {
		return unit === 'cores' ? String(milli / 1000) : String(milli);
	}

	function memText(bytes: number, unit: MemUnit) {
		return unit === 'GiB'
			? String(+(bytes / 1024 ** 3).toFixed(2))
			: String(Math.round(bytes / (1024 * 1024)));
	}

	$effect(() => {
		if (cpuMilli === null && memoryBytes === null) {
			if (defaultCpuMilli != null) cpuInput = cpuText(defaultCpuMilli, cpuUnit);
			if (defaultMemoryBytes != null) memInput = memText(defaultMemoryBytes, memUnit);
		} else {
			if (cpuMilli != null) cpuInput = cpuText(cpuMilli, cpuUnit);
			if (memoryBytes != null) memInput = memText(memoryBytes, memUnit);
		}
	});

	function setCpuUnit(next: string) {
		cpuUnit = next as CpuUnit;
		if (cpuMilli != null) cpuInput = cpuText(cpuMilli, cpuUnit);
	}

	function setMemUnit(next: string) {
		memUnit = next as MemUnit;
		if (memoryBytes != null) memInput = memText(memoryBytes, memUnit);
	}

	function applyCpu() {
		const v = parseFloat(String(cpuInput));
		if (!Number.isFinite(v) || v <= 0) return;
		cpuMilli = cpuUnit === 'cores' ? Math.round(v * 1000) : Math.round(v);
		onchange?.({ cpuMilli, memoryBytes });
	}

	function applyMem() {
		const v = parseFloat(String(memInput));
		if (!Number.isFinite(v) || v <= 0) return;
		memoryBytes = memUnit === 'GiB' ? Math.round(v * 1024 ** 3) : Math.round(v * 1024 * 1024);
		onchange?.({ cpuMilli, memoryBytes });
	}

	function pct(usage: number | null, limit: number | null): number | null {
		if (usage == null || limit == null || limit <= 0) return null;
		return Math.min(100, Math.round((usage / limit) * 100));
	}

	const cpuPct = $derived(pct(currentCpuUsage, cpuMilli ?? defaultCpuMilli));
	const memPct = $derived(pct(currentMemUsage, memoryBytes ?? defaultMemoryBytes));

	const cpuOverLimit = $derived(maxCpuMilli != null && cpuMilli != null && cpuMilli > maxCpuMilli);
	const memOverLimit = $derived(
		maxMemoryBytes != null && memoryBytes != null && memoryBytes > maxMemoryBytes
	);

	const cpuError = $derived(
		cpuOverLimit ? `Exceeds your org limit of ${formatCpu(maxCpuMilli!)}` : null
	);
	const memError = $derived(
		memOverLimit ? `Exceeds your org limit of ${formatMemory(maxMemoryBytes!)}` : null
	);
	const cpuHint = $derived(
		maxCpuMilli != null ? `Max allowed: ${formatCpu(maxCpuMilli)}` : undefined
	);
	const memHint = $derived(
		maxMemoryBytes != null ? `Max allowed: ${formatMemory(maxMemoryBytes)}` : undefined
	);

	function usageTone(p: number) {
		if (p >= 90) return 'error' as const;
		if (p >= 70) return 'warning' as const;
		return 'neutral' as const;
	}
</script>

<div class="rp-root">
	<div class="rp-fields">
		<Field label="CPU" for="{uid}-cpu" hint={cpuHint} error={cpuError}>
			<div class="rp-control">
				<span class="rp-input">
					<Input
						id="{uid}-cpu"
						type="number"
						min={cpuUnit === 'cores' ? '0.01' : '1'}
						step={cpuUnit === 'cores' ? '0.01' : '1'}
						bind:value={cpuInput}
						oninput={applyCpu}
						placeholder={cpuUnit === 'cores' ? '0.25' : '250'}
						suffix={cpuUnit === 'cores' ? 'cores' : 'm'}
						error={cpuOverLimit}
						{disabled}
					/>
				</span>
				<span class="rp-units" class:rp-units--off={disabled} inert={disabled}>
					<SegmentedControl
						size="sm"
						label="CPU unit"
						options={CPU_UNITS}
						bind:value={() => cpuUnit, setCpuUnit}
					/>
				</span>
			</div>
			{#if cpuPct != null}
				<Progress size="sm" value={cpuPct} tone={usageTone(cpuPct)} label="CPU in use" showValue />
			{/if}
		</Field>

		<Field label="Memory" for="{uid}-mem" hint={memHint} error={memError}>
			<div class="rp-control">
				<span class="rp-input">
					<Input
						id="{uid}-mem"
						type="number"
						min={memUnit === 'GiB' ? '0.25' : '1'}
						step={memUnit === 'GiB' ? '0.25' : '1'}
						bind:value={memInput}
						oninput={applyMem}
						placeholder={memUnit === 'GiB' ? '0.5' : '512'}
						suffix={memUnit}
						error={memOverLimit}
						{disabled}
					/>
				</span>
				<span class="rp-units" class:rp-units--off={disabled} inert={disabled}>
					<SegmentedControl
						size="sm"
						label="Memory unit"
						options={MEM_UNITS}
						bind:value={() => memUnit, setMemUnit}
					/>
				</span>
			</div>
			{#if memPct != null}
				<Progress
					size="sm"
					value={memPct}
					tone={usageTone(memPct)}
					label="Memory in use"
					showValue
				/>
			{/if}
		</Field>
	</div>
</div>

<style>
	.rp-root {
		container-type: inline-size;
	}
	.rp-fields {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem 1.5rem;
	}
	.rp-control {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.rp-input {
		flex: 1;
		min-width: 0;
	}
	.rp-input :global(input) {
		font-variant-numeric: tabular-nums;
		appearance: textfield;
	}
	.rp-input :global(input::-webkit-outer-spin-button),
	.rp-input :global(input::-webkit-inner-spin-button) {
		appearance: none;
		margin: 0;
	}
	.rp-units {
		flex-shrink: 0;
	}
	.rp-units--off {
		opacity: 0.5;
	}
	@container (max-width: 36rem) {
		.rp-fields {
			grid-template-columns: 1fr;
		}
	}
</style>
