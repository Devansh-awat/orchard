<script lang="ts">
	import {
		AudioLines,
		Bot,
		FolderCog,
		Gauge,
		Keyboard,
		Paintbrush,
		ServerCog,
		SlidersHorizontal,
		SquareTerminal,
		TriangleAlert
	} from '@jis3r/icons';
	import { GitBranch, Link2 } from 'lucide-svelte';
	import type { SettingsSectionId } from './sections';

	let {
		id,
		size = 16,
		animate = false
	}: { id: SettingsSectionId; size?: number; animate?: boolean } = $props();

	const MOVING = {
		general: ServerCog,
		setup: SquareTerminal,
		projects: FolderCog,
		usage: Gauge,
		danger: TriangleAlert,
		preferences: SlidersHorizontal,
		sounds: AudioLines,
		appearance: Paintbrush,
		agents: Bot,
		shortcuts: Keyboard
	} as const;

	const Moving = $derived(id in MOVING ? MOVING[id as keyof typeof MOVING] : null);
</script>

<span class="icon" aria-hidden="true">
	{#if Moving}
		<Moving {size} strokeWidth={1.75} {animate} />
	{:else if id === 'git'}
		<GitBranch {size} strokeWidth={1.75} />
	{:else}
		<Link2 {size} strokeWidth={1.75} />
	{/if}
</span>

<style>
	.icon {
		display: inline-grid;
		place-items: center;
		flex: none;
		line-height: 0;
		pointer-events: none;
	}
</style>
