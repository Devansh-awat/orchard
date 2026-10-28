<script lang="ts" module>
	const MIB = 1024 ** 2;
	const GIB = 1024 ** 3;

	const trim = (n: number) => String(+n.toFixed(2));

	export function formatMemory(bytes: number) {
		return bytes >= GIB ? `${trim(bytes / GIB)} GB` : `${Math.round(bytes / MIB)} MB`;
	}

	export function parseMemory(text: string): number | null {
		const m = text
			.toLowerCase()
			.replace(/\s+/g, '')
			.match(/^(\d*\.?\d+)(g|gb|gib|m|mb|mib)?$/);
		if (!m) return null;
		const n = parseFloat(m[1]);
		const unit = m[2]?.[0] ?? (n < 64 ? 'g' : 'm');
		return Math.round(n * (unit === 'g' ? GIB : MIB));
	}

	export function formatCpu(milli: number) {
		return `${trim(milli / 1000)} CPU`;
	}

	export function parseCpu(text: string): number | null {
		const m = text
			.toLowerCase()
			.replace(/\s+/g, '')
			.match(/^(\d*\.?\d+)(m|millicores?|cpus?|cores?|vcpus?)?$/);
		if (!m) return null;
		const n = parseFloat(m[1]);
		const milli = m[2]?.startsWith('m') || (!m[2] && n >= 64);
		return Math.round(milli ? n : n * 1000);
	}
</script>

<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { apiFetch, selectedOrganization } from '$lib/stores';
	import AmountSlider from '$lib/components/ui/AmountSlider.svelte';

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
		currentCpuUsage = null,
		currentMemUsage = null,
		maxCpuMilli = null,
		maxMemoryBytes = null,
		onchange
	}: Props = $props();

	const MEMORY_STOPS = [
		128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768
	].map((m) => m * MIB);
	const MEMORY_MARKS = [128, 512, 2048, 8192, 32768].map((m) => m * MIB);
	const CPU_STOPS = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
	const CPU_MARKS = [250, 1000, 4000, 16000];

	const orgId = $derived($selectedOrganization?.id ?? null);
	const needsQuota = $derived(
		(defaultCpuMilli == null ||
			defaultMemoryBytes == null ||
			maxCpuMilli == null ||
			maxMemoryBytes == null) &&
			!!orgId
	);

	const quota = createQuery<{
		effectiveLimit?: { cpuMilli: number | null; memoryBytes: number | null };
		org?: { defaultPodCpuMilli: number | null; defaultPodMemoryBytes: number | null };
	}>(() => ({
		queryKey: ['quota-me', orgId],
		enabled: needsQuota,
		staleTime: 60_000,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/me`);
			if (!res.ok) return {};
			return res.json();
		}
	}));

	const cpuDefault = $derived(defaultCpuMilli ?? quota.data?.org?.defaultPodCpuMilli ?? null);
	const memDefault = $derived(defaultMemoryBytes ?? quota.data?.org?.defaultPodMemoryBytes ?? null);
	const cpuLimit = $derived(maxCpuMilli ?? quota.data?.effectiveLimit?.cpuMilli ?? null);
	const memLimit = $derived(maxMemoryBytes ?? quota.data?.effectiveLimit?.memoryBytes ?? null);

	function emit() {
		onchange?.({ cpuMilli, memoryBytes });
	}
</script>

<div class="rp">
	<AmountSlider
		label="Memory"
		bind:value={() => memoryBytes, (v) => (memoryBytes = v)}
		stops={MEMORY_STOPS}
		marks={MEMORY_MARKS}
		format={formatMemory}
		parse={parseMemory}
		fallback={memDefault}
		limit={memLimit}
		usage={currentMemUsage}
		{disabled}
		onchange={emit}
	/>
	<AmountSlider
		label="CPU"
		bind:value={() => cpuMilli, (v) => (cpuMilli = v)}
		stops={CPU_STOPS}
		marks={CPU_MARKS}
		format={formatCpu}
		parse={parseCpu}
		fallback={cpuDefault}
		limit={cpuLimit}
		usage={currentCpuUsage}
		{disabled}
		onchange={emit}
	/>
</div>

<style>
	.rp {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
</style>
