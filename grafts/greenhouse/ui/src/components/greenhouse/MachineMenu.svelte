<script lang="ts">
	import {
		ArrowLeft,
		Check,
		ChevronDown,
		CircleAlert,
		CircleHelp,
		GitFork,
		Play,
		RotateCw,
		Plus,
		Settings2,
		Square
	} from 'lucide-svelte';
	import Menu from '@orchardlabs/graft-ui/components/ui/Menu.svelte';
	import MenuItem from '@orchardlabs/graft-ui/components/ui/MenuItem.svelte';
	import StatusDot from '@orchardlabs/graft-ui/components/ui/StatusDot.svelte';
	import MachineUsage from './MachineUsage.svelte';
	import RunnerTile from './RunnerTile.svelte';
	import { sandboxStatus } from '../../lib/status';
	import { springRotate } from '@orchardlabs/graft-ui/utils/motion.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { ago, runnerLabel } from './format';
	import { hostOnly } from './workspace.svelte';
	import type { Sandbox } from '../../lib/types/sandbox';

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const meta = $derived(machine ? machineStatus(machine) : null);
	const stopped = $derived(machine?.status === 'stopped' || machine?.status === 'error');
	const transitional = $derived(
		machine ? ['creating', 'starting', 'stopping', 'deleting'].includes(machine.status) : false
	);

	const runner = $derived(app.runners.find((r) => r.id === machine?.runner) ?? null);
	const canFork = $derived(runner?.capabilities.fork === true);
	const forkBlocked = $derived(
		!ws?.isOwner
			? hostOnly('fork the machine')
			: !canFork
				? `${runnerLabel(machine?.runner)} machines can't be forked on this server`
				: undefined
	);

	let open = $state(false);

	const idle = $derived(
		machine?.lastActiveAt
			? `Last active ${ago(machine.lastActiveAt)}. Idle machines stop on their own.`
			: 'Idle machines stop on their own.'
	);

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
			data-tour="machine"
			aria-expanded={isOpen}
			aria-label={machine
				? `${machine.name}, ${meta?.label ?? ''} on ${runnerLabel(machine.runner)}, switch machine`
				: 'Choose a machine'}
			title={machine ? idle : undefined}
		>
			<RunnerTile runner={machine ? (machine.runner ?? 'kubernetes') : null} />
			<span class="text">
				<span class="name">{machine?.name ?? 'No machine'}</span>
				<span class="cap">
					{#if machine && meta}
						<StatusDot {meta} size={6} />
						<span class="cap-text">{meta.label} · {runnerLabel(machine.runner)}</span>
					{:else}
						<span class="cap-text">Create one to start</span>
					{/if}
				</span>
			</span>
			<span class="chev" {@attach springRotate(() => isOpen, { rest: 0, on: 180 })}>
				<ChevronDown size={14} strokeWidth={1.75} />
			</span>
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
		<MachineUsage {machine} {open} owner={ws.isOwner} />
		{#if machine.applyError}
			<div class="apply" role="status">
				<p class="apply-title">
					<span class="apply-glyph"><CircleAlert size={14} strokeWidth={1.75} /></span>
					The last change failed to apply
				</p>
				<p class="apply-text">{machine.applyError}</p>
			</div>
			<MenuItem
				onclick={() => ws.retryApply()}
				disabled={!ws.canLifecycle || !!ws.busy}
				title={ws.canLifecycle ? 'Apply the desired state again' : hostOnly('retry the change')}
			>
				<RotateCw size={14} /> Retry
			</MenuItem>
			<div class="gh-menu-sep"></div>
		{:else if machine.applying}
			<div class="gh-menu-head">Applying changes…</div>
		{/if}
		{#if stopped}
			<MenuItem
				onclick={() => ws.lifecycle('start')}
				disabled={!ws.canStart || !!ws.busy}
				title={ws.canStart ? undefined : "Read-only guests can't start this machine"}
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
		{#if !ws.lifecycleOnly}
			<MenuItem
				onclick={() => app.openSettings('general')}
				disabled={!ws.isOwner}
				title={ws.isOwner ? undefined : hostOnly('change machine settings')}
			>
				<Settings2 size={14} /> Machine settings
			</MenuItem>
			<MenuItem onclick={() => (app.sheet = 'fork')} disabled={!!forkBlocked} title={forkBlocked}>
				<GitFork size={14} /> Fork machine…
			</MenuItem>
		{/if}
	{/if}
	<MenuItem onclick={() => (app.sheet = 'new-machine')}>
		<Plus size={14} /> New machine…
	</MenuItem>
	<div class="gh-menu-sep"></div>
	<MenuItem href="https://docs.orchard.my/greenhouse/" target="_blank" rel="noopener">
		<CircleHelp size={14} /> Help
	</MenuItem>
	<MenuItem href="/"><ArrowLeft size={14} /> Back to Orchard</MenuItem>
</Menu>

<style>
	.switch {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-width: 0;
		height: var(--gh-session-row);
		padding: 0 var(--gh-side-pad) 0 calc(var(--gh-side-pad) - 0.25rem);
		border-radius: var(--gh-r-control);
		color: var(--gh-text);
		text-align: left;
		transition: background-color var(--dur-fast) ease;
	}

	.switch:hover,
	.switch[aria-expanded='true'] {
		background: var(--gh-hover);
	}

	.switch:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
		line-height: var(--gh-lh-ui);
	}

	.cap {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.cap-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--text-micro);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.chev {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		color: var(--gh-faint);
	}

	.item-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.apply {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-width: 20rem;
		padding: 0.5rem;
	}

	.apply-title,
	.apply-text {
		margin: 0;
	}

	.apply-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
		color: var(--gh-text);
	}

	.apply-glyph {
		display: inline-grid;
		color: var(--status-error);
	}

	.apply-text {
		padding-left: 1.375rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
		overflow-wrap: anywhere;
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
