<script lang="ts">
	let {
		values,
		tone = 'accent',
		height = 32,
		label = undefined
	}: {
		values: number[];
		tone?: 'accent' | 'success' | 'warning' | 'error' | 'neutral';
		height?: number;
		label?: string;
	} = $props();

	const id = $props.id();
	const W = 100;
	const H = 40;

	const points = $derived.by(() => {
		if (values.length < 2) return [] as [number, number][];
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		return values.map(
			(v, i) =>
				[(i / (values.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)] as [number, number]
		);
	});
	const line = $derived(points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '));
	const area = $derived(points.length ? `${line} L${W},${H} L0,${H} Z` : '');
</script>

<svg
	class="spark spark--{tone}"
	viewBox="0 0 {W} {H}"
	preserveAspectRatio="none"
	style:height="{height}px"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<defs>
		<linearGradient id="fill-{id}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="currentColor" stop-opacity="0.18" />
			<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
		</linearGradient>
	</defs>
	<path d={area} fill="url(#fill-{id})" />
	<path
		d={line}
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linejoin="round"
		stroke-linecap="round"
		vector-effect="non-scaling-stroke"
	/>
</svg>

<style>
	.spark {
		display: block;
		width: 100%;
		overflow: visible;
	}
	.spark--accent {
		color: var(--accent-7);
	}
	.spark--success {
		color: var(--green-7);
	}
	.spark--warning {
		color: var(--amber-7);
	}
	.spark--error {
		color: var(--red-7);
	}
	.spark--neutral {
		color: var(--neutral-7);
	}
</style>
