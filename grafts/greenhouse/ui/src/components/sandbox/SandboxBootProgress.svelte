<script lang="ts">
	import { Check, Loader2 } from 'lucide-svelte';
	import {
		SANDBOX_BOOT_PHASES,
		sandboxBootIndex,
		type SandboxBoot,
		type SandboxStatus
	} from '../../lib/types/sandbox';

	let {
		boot = null,
		status,
		compact = false
	}: {
		boot?: SandboxBoot | null;
		status: SandboxStatus;
		compact?: boolean;
	} = $props();

	const steps = SANDBOX_BOOT_PHASES.filter((p) => p.id !== 'ready');
	const currentIndex = $derived(boot ? sandboxBootIndex(boot.phase) : 0);
	const done = $derived(boot?.ready === true);
	const label = $derived(
		boot?.label?.trim() ||
			(status === 'creating'
				? 'Creating the sandbox'
				: status === 'stopping'
					? 'Stopping the sandbox'
					: status === 'deleting'
						? 'Deleting the sandbox'
						: 'Starting the sandbox')
	);
	const pct = $derived(done ? 100 : Math.max(6, Math.round((currentIndex / steps.length) * 100)));
</script>

{#if compact}
	<div class="bp-compact">
		<span class="bp-track" aria-hidden="true">
			<span class="bp-fill" style:width="{pct}%"></span>
		</span>
		<span class="bp-compact-label">{label}</span>
	</div>
{:else}
	<div class="bp-root" role="status" aria-live="polite">
		<div class="bp-head">
			<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />
			<span class="bp-label">{label}</span>
		</div>
		<span class="bp-track" aria-hidden="true">
			<span class="bp-fill" style:width="{pct}%"></span>
		</span>
		<ol class="bp-steps">
			{#each steps as step, i (step.id)}
				{@const state = done || i < currentIndex ? 'done' : i === currentIndex ? 'now' : 'next'}
				<li class="bp-step bp-step--{state}">
					<span class="bp-mark" aria-hidden="true">
						{#if state === 'done'}
							<Check class="h-3 w-3" />
						{:else if state === 'now'}
							<span class="bp-pulse"></span>
						{:else}
							<span class="bp-pip"></span>
						{/if}
					</span>
					<span class="bp-step-label">{step.label}</span>
				</li>
			{/each}
		</ol>
		<p class="bp-note">This takes a few minutes the first time. You can leave and come back.</p>
	</div>
{/if}

<style>
	.bp-root {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		width: 100%;
		max-width: 22rem;
		padding: var(--space-4);
		border: 1px solid var(--status-info-border);
		border-radius: var(--radius-lg);
		background: var(--status-info-bg);
		text-align: left;
	}

	.bp-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--status-info);
	}

	.bp-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.bp-track {
		display: block;
		width: 100%;
		height: 3px;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
	}

	.bp-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--status-info);
		transition: width var(--dur-base) ease;
	}

	.bp-steps {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.bp-step {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 1.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.bp-step--done {
		color: var(--text-muted);
	}

	.bp-step--now {
		color: var(--text-default);
		font-weight: 600;
	}

	.bp-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.875rem;
		height: 0.875rem;
		flex-shrink: 0;
		color: var(--status-success);
	}

	.bp-pip {
		width: 0.3125rem;
		height: 0.3125rem;
		border-radius: var(--radius-pill);
		background: var(--border-strong);
	}

	.bp-pulse {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: var(--radius-pill);
		background: var(--status-info);
		animation: bp-breathe 1.6s ease-in-out infinite;
	}

	.bp-step-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bp-note {
		margin: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.bp-compact {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		width: 100%;
		min-width: 0;
	}

	.bp-compact-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@keyframes bp-breathe {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
