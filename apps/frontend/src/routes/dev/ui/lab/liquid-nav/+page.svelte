<script lang="ts">
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import type { SidebarSection } from '$lib/components/patterns/sidebar';
	import DevBar from '../../DevBar.svelte';
	import { SIDEBAR } from '../../fixtures';

	const base = SIDEBAR.sections('apps');
	const labels = base.flatMap((s) => s.items.map((i) => i.label));

	let liquidActive = $state('Your Apps');
	let plainActive = $state('Your Apps');

	const withActive = (active: string): SidebarSection[] =>
		base.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, active: i.label === active })) }));

	function pick(e: MouseEvent, set: (label: string) => void) {
		const link = (e.target as Element).closest('a');
		const frame = e.currentTarget as HTMLElement;
		if (!link) return;
		e.preventDefault();
		const index = Array.from(frame.querySelectorAll('a')).indexOf(link);
		if (labels[index]) set(labels[index]);
	}
</script>

<div class="lab">
	<section class="slot">
		<h1 class="label">Liquid</h1>
		<div class="frame" onclickcapture={(e) => pick(e, (l) => (liquidActive = l))}>
			<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} sections={withActive(liquidActive)} liquid />
		</div>
	</section>
	<section class="slot">
		<h1 class="label">Default</h1>
		<div class="frame" onclickcapture={(e) => pick(e, (l) => (plainActive = l))}>
			<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} sections={withActive(plainActive)} />
		</div>
	</section>
</div>

<DevBar />

<style>
	.lab {
		display: flex;
		gap: 3rem;
		justify-content: center;
		padding: 2rem 2rem 6rem;
	}
	.slot {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.label {
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.frame {
		width: 16rem;
		height: 40rem;
	}
</style>
