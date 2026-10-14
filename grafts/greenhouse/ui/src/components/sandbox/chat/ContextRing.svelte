<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { PopoverPanel, Skeleton } from '@orchardlabs/graft-ui';
	import { ocFmtTokens } from '../opencode';
	import type { ContextMeter } from './session-store.svelte';
	import { agentUsageQueryOptions, fmtResetTime, usageUnavailableText } from './agent-usage';

	let {
		meter,
		sandboxId = null,
		always = true,
		open = $bindable(false)
	}: {
		meter: ContextMeter;
		sandboxId?: string | null;
		always?: boolean;
		open?: boolean;
	} = $props();

	const NOTICE_PCT = 50;

	const R = 7;
	const C = 2 * Math.PI * R;
	const tone = $derived(meter.pct >= 90 ? 'error' : meter.pct >= 75 ? 'warning' : 'neutral');
	const label = $derived(
		meter.limit ? `${Math.round(meter.pct)}%` : meter.used > 0 ? ocFmtTokens(meter.used) : '0%'
	);
	const title = $derived(
		meter.used > 0
			? `${ocFmtTokens(meter.used)}${meter.limit ? ` of ${ocFmtTokens(meter.limit)}` : ''} context used`
			: 'No context used yet'
	);

	const usageQuery = createQuery(() =>
		agentUsageQueryOptions(sandboxId ?? '', open && !!sandboxId)
	);
	const usage = $derived(usageQuery.data ?? null);
	const account = $derived(usage?.available ? usage : null);
	const missing = $derived(
		usage && !usage.available ? usage.reason : usageQuery.isError ? 'unavailable' : null
	);

	function fmt(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}

	function share(n: number): string {
		if (!meter.limit) return fmt(n);
		const pct = (n / meter.limit) * 100;
		return `${pct >= 10 || pct === 0 ? pct.toFixed(1) : pct.toFixed(2)}%`;
	}

	const breakdown = $derived.by(() => {
		const t = meter.tokens;
		if (!t) return [];
		const rows = [
			{ label: 'Input', value: t.input },
			{ label: 'Cache read', value: t.cache.read },
			{ label: 'Cache write', value: t.cache.write },
			{ label: 'Output', value: t.output },
			{ label: 'Reasoning', value: t.reasoning }
		].filter((row) => row.value > 0);
		rows.sort((a, b) => b.value - a.value);
		if (meter.limit)
			rows.push({ label: 'Free space', value: Math.max(0, meter.limit - meter.used) });
		return rows;
	});
</script>

{#snippet bar(fraction: number, kind: string)}
	<span class="ctxp-bar" aria-hidden="true">
		<span
			class="ctxp-fill ctxp-fill--{kind}"
			style="width: {Math.min(100, Math.max(0, fraction * 100))}%"
		></span>
	</span>
{/snippet}

{#snippet limit(name: string, window: { leftPercent: number; resetsAt: string | null })}
	{@const reset = fmtResetTime(window.resetsAt)}
	<div class="ctxp-limit">
		<div class="ctxp-row">
			<span>{name}</span>
			<span class="ctxp-strong">{Math.round(window.leftPercent)}% left</span>
		</div>
		{@render bar(
			window.leftPercent / 100,
			window.leftPercent <= 10 ? 'error' : window.leftPercent <= 25 ? 'warning' : 'neutral'
		)}
		{#if reset}<div class="ctxp-meta">Resets {reset}</div>{/if}
	</div>
{/snippet}

<PopoverPanel bind:open placement="top-end" class="ctxp-panel">
	{#snippet trigger(props, isOpen)}
		<button
			type="button"
			class="ctx ctx--{tone}"
			class:ctx--open={isOpen}
			{title}
			aria-label="Context used: {label}"
			{...props}
		>
			<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
				<circle class="ctx-track" cx="9" cy="9" r={R} />
				<circle
					class="ctx-fill"
					cx="9"
					cy="9"
					r={R}
					stroke-dasharray={C}
					stroke-dashoffset={C * (1 - meter.pct / 100)}
				/>
			</svg>
			{#if always || meter.pct >= NOTICE_PCT}
				<span class="ctx-label">{label}</span>
			{/if}
		</button>
	{/snippet}
	{#snippet children()}
		<div class="ctxp">
			<section class="ctxp-section">
				<div class="ctxp-row ctxp-head">
					<h3>Context</h3>
					<span class="ctxp-meta ctxp-num">
						{fmt(meter.used)}{meter.limit ? `/${fmt(meter.limit)}` : ''}
					</span>
				</div>
				{#if meter.limit}
					{@render bar(meter.pct / 100, tone)}
				{/if}
				{#if breakdown.length > 0}
					<ul class="ctxp-list">
						{#each breakdown as row (row.label)}
							<li class="ctxp-row" title="{row.value.toLocaleString()} tokens">
								<span>{row.label}</span>
								<span class="ctxp-value ctxp-num">{share(row.value)}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="ctxp-meta">No context used yet</p>
				{/if}
			</section>
			{#if sandboxId && missing !== 'forbidden'}
				<section class="ctxp-section">
					<h3>Claude usage</h3>
					{#if missing}
						<p class="ctxp-meta">{usageUnavailableText(missing)}</p>
					{:else if !account}
						<div class="ctxp-skel" aria-hidden="true">
							<Skeleton height="0.75rem" width="70%" />
							<Skeleton height="0.5rem" width="100%" />
							<Skeleton height="0.75rem" width="55%" />
						</div>
					{:else}
						{#if account.fiveHour}{@render limit('5h limit', account.fiveHour)}{/if}
						{#if account.sevenDay}{@render limit('7d limit', account.sevenDay)}{/if}
						{#if !account.fiveHour && !account.sevenDay}
							<p class="ctxp-meta">Usage is unavailable right now</p>
						{/if}
					{/if}
				</section>
				{#if account}
					<section class="ctxp-section">
						<ul class="ctxp-list">
							<li class="ctxp-row">
								<span>Provider</span><span class="ctxp-value">{account.provider}</span>
							</li>
							{#if account.plan}
								<li class="ctxp-row">
									<span>Plan</span><span class="ctxp-value">{account.plan}</span>
								</li>
							{/if}
							<li class="ctxp-row">
								<span>Login method</span><span class="ctxp-value">{account.loginMethod}</span>
							</li>
							{#if account.email}
								<li class="ctxp-row">
									<span>Email</span>
									<span
										class="ctxp-value ctxp-email"
										title={account.emailMasked ? "The host's account" : account.email}
										>{account.email}</span
									>
								</li>
							{/if}
						</ul>
					</section>
				{/if}
			{/if}
		</div>
	{/snippet}
</PopoverPanel>

<style>
	:global(.ui-popover.ctxp-panel) {
		width: 20rem;
		padding: var(--space-4);
	}

	.ctx {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding: 0 var(--space-1);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.ctx:hover,
	.ctx--open {
		background: var(--bg-hover);
	}

	.ctx-track {
		fill: none;
		stroke: var(--fill-medium);
		stroke-width: 2.25;
	}

	.ctx-fill {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 2.25;
		stroke-linecap: round;
		transform: rotate(-90deg);
		transform-origin: 50% 50%;
	}

	.ctx--warning .ctx-fill {
		stroke: var(--status-warning);
	}

	.ctx--error .ctx-fill {
		stroke: var(--status-error);
	}

	.ctx--warning {
		color: var(--status-warning);
	}

	.ctx--error {
		color: var(--status-error);
	}

	.ctx-label {
		font-size: var(--text-caption);
		line-height: 1rem;
		font-variant-numeric: tabular-nums;
	}

	.ctxp {
		display: flex;
		flex-direction: column;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 400;
		color: var(--text-default);
	}

	.ctxp-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.ctxp-section + .ctxp-section {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-default);
	}

	.ctxp h3 {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.ctxp-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		min-width: 0;
	}

	.ctxp-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ctxp-value {
		min-width: 0;
		color: var(--text-muted);
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ctxp-num {
		font-variant-numeric: tabular-nums;
	}

	.ctxp-strong {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.ctxp-meta {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.ctxp-limit {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.ctxp-limit + .ctxp-limit {
		margin-top: var(--space-2);
	}

	.ctxp-bar {
		display: block;
		height: 0.375rem;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--fill-medium);
	}

	.ctxp-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--text-default);
	}

	.ctxp-fill--warning {
		background: var(--status-warning);
	}

	.ctxp-fill--error {
		background: var(--status-error);
	}

	.ctxp-skel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.ctxp-email {
		user-select: text;
	}
</style>
