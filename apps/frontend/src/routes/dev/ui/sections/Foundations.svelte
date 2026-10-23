<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';

	const SCALES = ['neutral', 'accent', 'red', 'amber', 'green', 'blue'];
	const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const STEP_ROLE = [
		'bg',
		'hover bg',
		'active bg',
		'border',
		'hover border',
		'active border',
		'solid',
		'solid hover',
		'text 2',
		'text 1'
	];
	const RADII = [
		{ name: 'control', token: '--radius-control' },
		{ name: 'card', token: '--radius-card' },
		{ name: 'panel', token: '--radius-panel' },
		{ name: 'pill', token: '--radius-pill' }
	];
	const SHADOWS = ['--shadow-raised', '--shadow-floating', '--shadow-overlay'];
	const SPACE = [0.5, 1, 2, 3, 4, 6, 8, 12, 16];
</script>

<SectionCard
	title="Colour"
	description="Generated from the theme. Steps mean the same thing in every scale."
>
	<div class="grid gap-2">
		<div class="row row--head">
			<span></span>
			{#each STEP_ROLE as role, i (i)}<span class="role">{i + 1}<br />{role}</span>{/each}
		</div>
		{#each SCALES as scale (scale)}
			<div class="row">
				<span class="scale">{scale}</span>
				{#each STEPS as step (step)}
					<span class="swatch" style:background="var(--{scale}-{step})"></span>
				{/each}
			</div>
		{/each}
	</div>
</SectionCard>

<div class="grid grid-cols-3 gap-6">
	<SectionCard title="Radius" description="Inner radius is outer minus inset.">
		<div class="flex items-end gap-4">
			{#each RADII as r (r.name)}
				<div class="flex flex-col items-center gap-2">
					<span class="radius" style:border-radius="var({r.token})"></span>
					<span class="text-caption text-muted">{r.name}</span>
				</div>
			{/each}
		</div>
	</SectionCard>
	<SectionCard title="Elevation" description="Ring plus soft layered shadow.">
		<div class="flex items-center gap-4">
			{#each SHADOWS as s (s)}
				<div class="flex flex-col items-center gap-2">
					<span class="elev" style:box-shadow="var({s})"></span>
					<span class="text-caption text-muted">{s.replace('--shadow-', '')}</span>
				</div>
			{/each}
		</div>
	</SectionCard>
	<SectionCard title="Space" description="4px grid. These steps only.">
		<div class="flex items-end gap-2">
			{#each SPACE as n (n)}
				<div class="flex flex-col items-center gap-2">
					<span class="space" style:height="{n * 4}px" style:width="{n * 4}px"></span>
					<span class="text-micro text-faint">{n}</span>
				</div>
			{/each}
		</div>
	</SectionCard>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: 4.5rem repeat(10, minmax(0, 1fr));
		gap: 0.375rem;
		align-items: center;
	}
	.role {
		color: var(--text-faint);
		font-size: var(--text-micro);
		line-height: 1.2;
	}
	.scale {
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.swatch {
		height: 2rem;
		border-radius: 0.375rem;
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 10%, transparent);
	}
	.radius {
		width: 3.5rem;
		height: 3.5rem;
		background: var(--accent-3);
		box-shadow: inset 0 0 0 1px var(--accent-5);
	}
	.elev {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: var(--radius-card);
		background: var(--bg-surface);
	}
	.space {
		border-radius: 2px;
		background: var(--accent-5);
	}
</style>
