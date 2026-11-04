<script lang="ts" module>
	import { apiFetch } from '$lib/stores';

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

	export type PodKind = 'app' | 'database';
	export type QuotaMe = {
		effectiveLimit?: { cpuMilli: number | null; memoryBytes: number | null };
		podDefaults?: Record<PodKind, { cpuMilli: number; memoryBytes: number }>;
	};

	export function quotaMeQuery(orgId: string | null) {
		return {
			queryKey: ['quota-me', orgId],
			enabled: !!orgId,
			staleTime: 60_000,
			queryFn: async (): Promise<QuotaMe> => {
				const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/me`);
				if (!res.ok) return {};
				return res.json();
			}
		};
	}

	export function resourcesNote(
		cpuMilli: number | null,
		memoryBytes: number | null,
		defaults: { cpuMilli: number; memoryBytes: number } | null | undefined
	) {
		const memory = memoryBytes ?? defaults?.memoryBytes ?? null;
		const cpu = cpuMilli ?? defaults?.cpuMilli ?? null;
		const parts = [
			memory != null ? formatMemory(memory) : null,
			cpu != null ? formatCpu(cpu) : null
		].filter(Boolean);
		if (!parts.length) return 'Organization default';
		return cpuMilli == null && memoryBytes == null
			? `Organization default · ${parts.join(', ')}`
			: parts.join(' · ');
	}
</script>

<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { browser } from '$app/environment';
	import { instanceFeatures, selectedOrganization } from '$lib/stores';
	import AmountSlider from '$lib/components/ui/AmountSlider.svelte';

	interface Props {
		cpuMilli: number | null;
		memoryBytes: number | null;
		kind?: PodKind;
		defaultCpuMilli?: number | null;
		defaultMemoryBytes?: number | null;
		defaultLabel?: string;
		disabled?: boolean;
		showUnlimited?: boolean;
		currentCpuUsage?: number | null;
		currentMemUsage?: number | null;
		maxCpuMilli?: number | null;
		maxMemoryBytes?: number | null;
		recommendedCpuMilli?: number | null;
		recommendedMemoryBytes?: number | null;
		onchange?: (v: { cpuMilli: number | null; memoryBytes: number | null }) => void;
	}

	let {
		cpuMilli = $bindable(),
		memoryBytes = $bindable(),
		kind = 'app',
		defaultCpuMilli = null,
		defaultMemoryBytes = null,
		defaultLabel,
		disabled = false,
		currentCpuUsage = null,
		currentMemUsage = null,
		maxCpuMilli = null,
		maxMemoryBytes = null,
		recommendedCpuMilli = null,
		recommendedMemoryBytes = null,
		onchange
	}: Props = $props();

	const MEMORY_STOPS = [
		128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768
	].map((m) => m * MIB);
	const CPU_STOPS = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];

	const orgId = $derived($selectedOrganization?.id ?? null);
	const quota = createQuery<QuotaMe>(() => quotaMeQuery(orgId));

	const podDefaults = $derived(quota.data?.podDefaults?.[kind] ?? null);
	const cpuDefault = $derived(
		defaultLabel ? defaultCpuMilli : (podDefaults?.cpuMilli ?? defaultCpuMilli ?? null)
	);
	const memDefault = $derived(
		defaultLabel ? defaultMemoryBytes : (podDefaults?.memoryBytes ?? defaultMemoryBytes ?? null)
	);
	const cpuLimit = $derived(maxCpuMilli ?? quota.data?.effectiveLimit?.cpuMilli ?? null);
	const memLimit = $derived(maxMemoryBytes ?? quota.data?.effectiveLimit?.memoryBytes ?? null);

	if (browser) instanceFeatures.load().catch(() => undefined);

	function emit() {
		onchange?.({ cpuMilli, memoryBytes });
	}
</script>

{#if $instanceFeatures.resourceLimits === 'off'}
	<p class="rp-off">
		Resource limits are off on this server, so this {kind === 'database' ? 'database' : 'app'} can use
		as much CPU and memory as it needs.
	</p>
{:else}
	<div class="rp">
		<AmountSlider
			label="Memory"
			bind:value={() => memoryBytes, (v) => (memoryBytes = v)}
			stops={MEMORY_STOPS}
			format={formatMemory}
			parse={parseMemory}
			fallback={memDefault}
			fallbackLabel={defaultLabel}
			limit={memLimit}
			usage={currentMemUsage}
			recommended={recommendedMemoryBytes}
			{disabled}
			onchange={emit}
		/>
		<AmountSlider
			label="CPU"
			bind:value={() => cpuMilli, (v) => (cpuMilli = v)}
			stops={CPU_STOPS}
			format={formatCpu}
			parse={parseCpu}
			fallback={cpuDefault}
			fallbackLabel={defaultLabel}
			limit={cpuLimit}
			usage={currentCpuUsage}
			recommended={recommendedCpuMilli}
			{disabled}
			onchange={emit}
		/>
	</div>
{/if}

<style>
	.rp-off {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.rp {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
</style>
