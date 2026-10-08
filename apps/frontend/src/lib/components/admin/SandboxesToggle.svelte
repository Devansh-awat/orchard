<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { Badge, SectionCard, StatusDot, ToggleRow, statusMeta } from '$lib/components/ui';
	import type { SandboxRunnerInfo } from '$lib/types/sandbox';

	interface State {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
	}

	let state = $state<State | null>(null);
	let saving = $state(false);
	let runners = $state.raw<SandboxRunnerInfo[] | null>(null);
	let defaultRunner = $state<string | null>(null);

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/sandboxes');
			if (!res.ok) return;
			state = await res.json();
		} catch {
			state = null;
		}
		await loadRunners();
	}

	async function loadRunners() {
		if (!state?.enabled) {
			runners = null;
			return;
		}
		try {
			const res = await apiFetch('/apiv1/sandboxes');
			if (!res.ok) {
				runners = null;
				return;
			}
			const body = await res.json();
			runners = Array.isArray(body?.runners) ? body.runners : [];
			defaultRunner = body?.defaultRunner ?? null;
		} catch {
			runners = null;
		}
	}

	async function toggle() {
		if (!state || state.envOverride !== null) return;
		saving = true;
		const next = !state.dbValue;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/sandboxes', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error('Failed to save');
			state = await res.json();
			await instanceFeatures.load(true);
			await loadRunners();
			toasts.add({ title: next ? 'Greenhouse on' : 'Greenhouse off', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard
		title="Greenhouse"
		description="Cloud machines where people run coding agents in their own worktrees, alone or together."
	>
		{#if state.envOverride !== null}
			<div class="locked">
				<Badge tone="neutral">env override</Badge>
				<span>
					Pinned to <span class="font-mono">{state.envOverride ? 'on' : 'off'}</span> by the
					<span class="font-mono">SANDBOX_ENABLED</span> env var.
				</span>
			</div>
		{:else}
			<ToggleRow
				checked={state.dbValue}
				label="Let people create machines"
				hint="Off hides Greenhouse and refuses its API. Existing machines are kept, stopped by the idle reaper."
				disabled={saving}
				onchange={toggle}
			/>
		{/if}

		{#if runners && runners.length > 0}
			<div class="runners" aria-label="Runners">
				{#each runners as runner (runner.id)}
					{@const meta = runner.available
						? statusMeta('success', 'Available')
						: statusMeta('neutral', 'Unavailable')}
					<div class="runner">
						<StatusDot {meta} size={8} />
						<span class="runner-name">
							{runner.label}{runner.id === defaultRunner ? ' (default)' : ''}
						</span>
						<span class="runner-state">
							{runner.available ? meta.label : (runner.reason ?? meta.label)}
						</span>
					</div>
				{/each}
			</div>
		{:else if state.enabled && runners === null}
			<p class="muted">Could not read runner status.</p>
		{/if}
	</SectionCard>
{/if}

<style>
	.locked {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.runners {
		display: flex;
		flex-direction: column;
		margin-top: 1rem;
		border-top: 1px solid var(--border-default);
	}

	.runner {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.5rem;
		border-bottom: 1px solid var(--border-default);
	}

	.runner-name {
		flex: none;
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.runner-state {
		flex: 1;
		min-width: 0;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.muted {
		margin: 1rem 0 0;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
