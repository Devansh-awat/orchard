<script lang="ts">
	import {
		Copy,
		Ellipsis,
		FileText,
		RotateCcw,
		SquareArrowOutUpRight,
		SquareTerminal,
		Trash2
	} from 'lucide-svelte';
	import { Button, Menu, MenuItem, MenuSeparator } from '$lib/components/ui';

	let {
		label,
		crashed,
		canShell,
		href,
		onLogs,
		onCrashLogs,
		onShell,
		onCopy,
		onDelete
	}: {
		label: string;
		crashed: boolean;
		canShell: boolean;
		href: string;
		onLogs: () => void;
		onCrashLogs: () => void;
		onShell: () => void;
		onCopy: () => void;
		onDelete: () => void;
	} = $props();

	let isOpen = $state(false);

	export function open() {
		isOpen = true;
	}
</script>

<Menu placement="bottom-end" bind:open={isOpen}>
	{#snippet trigger(props)}
		<Button {...props} variant="ghost" size="sm" icon={Ellipsis} label="Actions for {label}" />
	{/snippet}
	<MenuItem icon={FileText} onclick={onLogs}>Logs</MenuItem>
	{#if crashed}
		<MenuItem icon={RotateCcw} onclick={onCrashLogs}>Logs before the crash</MenuItem>
	{/if}
	<MenuItem icon={SquareTerminal} disabled={!canShell} onclick={onShell}>Shell</MenuItem>
	<MenuItem icon={SquareArrowOutUpRight} {href}>Details</MenuItem>
	<MenuItem icon={Copy} onclick={onCopy}>Copy name</MenuItem>
	<MenuSeparator />
	<MenuItem icon={Trash2} danger description="Kubernetes starts a fresh one" onclick={onDelete}
		>Delete pod</MenuItem
	>
</Menu>
