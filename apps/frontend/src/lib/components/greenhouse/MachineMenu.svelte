<script lang="ts">
	import {
		ArrowLeft,
		Check,
		ChevronDown,
		Play,
		Plus,
		Settings2,
		Square,
		Users
	} from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { sandboxStatus } from '$lib/components/ui/status';
	import { getGreenhouseApp } from './app.svelte';
	import { runnerLabel } from './format';
	import { hostOnly } from './workspace.svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const meta = $derived(machine ? machineStatus(machine) : null);
	const stopped = $derived(machine?.status === 'stopped' || machine?.status === 'error');
	const transitional = $derived(
		machine ? ['creating', 'starting', 'stopping', 'deleting'].includes(machine.status) : false
	);

	let open = $state(false);

	function machineStatus(m: Sandbox) {
		return sandboxStatus(m.status, {
			applying: m.applying,
			applyError: m.applyError,
			desiredState: m.desiredState
		});
	}
</script>

<Menu bind:open placement="bottom-start">
	{#snippet trigger(props, isOpen)}
		<button
			{...props}
			type="button"
			class="switch"
			aria-expanded={isOpen}
			title={machine ? `${machine.name} · ${runnerLabel(machine.runner)} · ${meta?.label}` : ''}
		>
			<span class="ico" data-align="sidebar-icon">
				{#if meta}<StatusDot {meta} size={8} />{/if}
			</span>
			<span class="name" data-align="sidebar-label">{machine?.name ?? 'No machine'}</span>
			<span class="chev"><ChevronDown size={16} strokeWidth={1.75} /></span>
		</button>
	{/snippet}
	{#if app.machines.length > 0}
		<div class="gh-menu-head">Machines</div>
		{#each app.machines as m (m.id)}
			{@const mm = machineStatus(m)}
			<MenuItem onclick={() => app.openMachine(m.id)}>
				<StatusDot meta={mm} size={7} />
				<span class="item-name">{m.name}</span>
				<span class="item-cap">{runnerLabel(m.runner)} · {mm.label}</span>
				{#if m.id === machine?.id}<Check size={14} />{/if}
			</MenuItem>
		{/each}
		<div class="gh-menu-sep"></div>
	{/if}
	{#if machine && ws}
		{#if stopped}
			<MenuItem
				onclick={() => ws.lifecycle('start')}
				disabled={!ws.canStart || !!ws.busy}
				title={ws.canStart ? undefined : 'Read-only guests cannot start this machine'}
			>
				<Play size={14} /> Start machine
			</MenuItem>
		{:else}
			<MenuItem
				onclick={() => ws.lifecycle('stop')}
				disabled={!ws.canLifecycle || !!ws.busy || transitional}
				title={ws.canLifecycle ? undefined : hostOnly('stop the machine')}
			>
				<Square size={14} /> Stop machine
			</MenuItem>
		{/if}
		<MenuItem
			onclick={() => (app.sheet = 'settings')}
			disabled={!ws.isOwner}
			title={ws.isOwner ? undefined : hostOnly('change machine settings')}
		>
			<Settings2 size={14} /> Machine settings
		</MenuItem>
		<MenuItem onclick={() => (app.sheet = 'share')}>
			<Users size={14} />
			{ws.isOwner ? 'Share' : 'People'}
		</MenuItem>
	{/if}
	<MenuItem onclick={() => (app.sheet = 'new-machine')}>
		<Plus size={14} /> New machine…
	</MenuItem>
	<div class="gh-menu-sep"></div>
	<MenuItem href="/"><ArrowLeft size={14} /> Back to Orchard</MenuItem>
</Menu>

<style>
	.switch {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-width: 0;
		height: var(--gh-row);
		padding: 0 var(--row-pad, 0.5rem);
		border-radius: var(--gh-r-row);
		color: var(--gh-text);
		font-weight: 600;
		text-align: left;
		transition: background-color var(--dur-fast) ease;
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.switch:hover,
	.switch[aria-expanded='true'] {
		background: var(--gh-hover);
	}

	.chev {
		display: inline-grid;
		flex: none;
		color: var(--gh-muted);
	}

	.name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.item-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.item-cap {
		margin-left: auto;
		padding-left: 0.75rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		white-space: nowrap;
	}
</style>
