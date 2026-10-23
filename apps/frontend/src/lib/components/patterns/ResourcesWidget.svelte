<script lang="ts">
	import Widget from '$lib/components/ui/Widget.svelte';

	type Part = { label: string; value: number };
	type Quota = { limit: number; unit?: string; parts: Part[] };

	let {
		cpu,
		memory,
		title = 'Resources'
	}: { cpu: Quota; memory: Quota; title?: string } = $props();

	const HUES = ['one', 'two', 'three'] as const;
	const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

	const share = (q: Quota, label: string) =>
		q.limit > 0 ? (q.parts.find((p) => p.label === label)?.value ?? 0) / q.limit : 0;

	const top = $derived.by(() => {
		const labels = new Set([...cpu.parts, ...memory.parts].map((p) => p.label));
		return [...labels]
			.map((label) => ({ label, weight: share(cpu, label) + share(memory, label) }))
			.filter((p) => p.weight > 0)
			.sort((a, b) => b.weight - a.weight)
			.slice(0, 3)
			.map((p, i) => ({ label: p.label, hue: HUES[i] }));
	});

	function rows(q: Quota) {
		const used = q.parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
		const named = top.map((t) => ({
			key: t.label,
			label: t.label,
			hue: t.hue as string,
			value: q.parts.find((p) => p.label === t.label)?.value ?? 0
		}));
		const other = used - named.reduce((sum, p) => sum + p.value, 0);
		const segments = [...named, { key: '__other', label: 'Other', hue: 'other', value: other }]
			.filter((s) => s.value > 0)
			.map((s) => ({ ...s, width: q.limit > 0 ? (s.value / Math.max(q.limit, used)) * 100 : 0 }));
		return { used, segments };
	}

	const resources = $derived([
		{ key: 'cpu', label: 'CPU', quota: cpu, unit: cpu.unit ?? 'cores', ...rows(cpu) },
		{ key: 'memory', label: 'Memory', quota: memory, unit: memory.unit ?? 'GiB', ...rows(memory) }
	]);

	const hasOther = $derived(
		resources.some((r) => r.segments.some((s) => s.key === '__other' && s.value > 0))
	);
</script>

<Widget {title}>
	<div class="bars">
		{#each resources as r (r.key)}
			{@const over = r.used > r.quota.limit}
			<div class="resource">
				<div class="head">
					<span class="name">{r.label}</span>
					<span class="amount" class:amount--over={over}>
						<span class="used">{fmt.format(r.used)}</span> of {fmt.format(r.quota.limit)}
						{r.unit}
					</span>
				</div>
				<div
					class="capsule"
					role="img"
					aria-label="{r.label}: {r.segments
						.map((s) => `${s.label} ${fmt.format(s.value)} ${r.unit}`)
						.join(', ')}, {fmt.format(Math.max(0, r.quota.limit - r.used))} {r.unit} free"
				>
					{#each r.segments as s (s.key)}
						<span
							class="seg seg--{s.hue}"
							style:width="{s.width}%"
							title="{s.label} · {fmt.format(s.value)} {r.unit}"
						></span>
					{/each}
				</div>
			</div>
		{/each}
	</div>
	{#if top.length}
		<ul class="legend">
			{#each top as t (t.label)}
				<li class="key">
					<span class="dot seg--{t.hue}"></span><span class="key-name">{t.label}</span>
				</li>
			{/each}
			{#if hasOther}
				<li class="key"><span class="dot seg--other"></span><span class="key-name">Other</span></li>
			{/if}
		</ul>
	{/if}
</Widget>

<style>
	.bars {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
	}
	.resource {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.name {
		display: block;
		color: var(--text-default);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.amount {
		display: block;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
	}
	.used {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.amount--over,
	.amount--over .used {
		color: var(--status-error);
	}
	.capsule {
		display: flex;
		height: 0.625rem;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--bg-active);
	}
	.seg {
		flex-shrink: 0;
		height: 100%;
		min-width: 2px;
	}
	.seg + .seg {
		box-shadow: inset 1.5px 0 0 var(--bg-surface);
	}
	.seg--one {
		background: var(--hue-blue);
	}
	.seg--two {
		background: var(--hue-violet);
	}
	.seg--three {
		background: var(--hue-green);
	}
	.seg--other {
		background: var(--neutral-6);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.875rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.key {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}
	.dot {
		width: 0.4375rem;
		height: 0.4375rem;
		flex-shrink: 0;
		border-radius: 50%;
	}
	.key-name {
		display: block;
		overflow: hidden;
		max-width: 8rem;
		padding-block: 0.3em;
		margin-block: -0.3em;
		color: var(--text-muted);
		font-size: var(--text-caption);
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
</style>
