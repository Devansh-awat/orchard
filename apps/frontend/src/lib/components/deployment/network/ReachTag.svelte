<script lang="ts">
	import { Globe, Lock, MonitorSmartphone } from 'lucide-svelte';
	import { REACH_LABELS, type Reach } from './network';

	let { reach }: { reach: Reach } = $props();

	const ICONS = { anyone: Globe, devices: MonitorSmartphone, project: Lock };
	const Glyph = $derived(ICONS[reach]);
</script>

<span class="reach reach--{reach}">
	<Glyph size={12} strokeWidth={2.25} aria-hidden="true" />
	<span class="label">{REACH_LABELS[reach]}</span>
</span>

<style>
	.reach {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		height: 1.5rem;
		padding: 0 0.5625rem 0 0.5rem;
		border-radius: 999px;
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}
	.label {
		text-box: trim-both cap alphabetic;
	}
	.reach--anyone {
		background: var(--status-info-bg);
		color: var(--status-info);
	}
	.reach--devices,
	.reach--project {
		background: var(--fill-quiet);
		color: var(--text-muted);
	}
</style>
