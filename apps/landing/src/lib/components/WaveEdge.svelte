<script lang="ts">
	let {
		fill = '#ffdfe3',
		flip = false,
		scale = 1,
		drift = true,
		period = 9,
		class: className = ''
	}: {
		fill?: string;
		flip?: boolean;
		scale?: number;
		drift?: boolean;
		period?: number;
		class?: string;
	} = $props();

	const width = $derived(213 * scale);
	const height = $derived(35 * scale);
	const tile = $derived(
		`url("data:image/svg+xml,${encodeURIComponent(
			`<svg xmlns='http://www.w3.org/2000/svg' width='213' height='35' viewBox='0 0 213 35' preserveAspectRatio='none'><path d='M0 17.5C35.5-6 71-6 106.5 17.5C142 41 177.5 41 213 17.5V35H0Z' fill='${fill}'/></svg>`
		)}")`
	);
</script>

<div
	aria-hidden="true"
	class="pointer-events-none {drift ? 'wave-drift' : ''} {className}"
	style:height="{height}px"
	style:background-image={tile}
	style:background-size="{width}px {height}px"
	style:background-repeat="repeat-x"
	style:background-position="0 100%"
	style:transform={flip ? 'scaleY(-1)' : undefined}
	style:--wave-length="{width}px"
	style:--wave-period="{period}s"
></div>
