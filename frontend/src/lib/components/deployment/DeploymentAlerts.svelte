<script lang="ts">
	import { X } from 'lucide-svelte';
	import { ShieldAlert, TriangleAlert, CircleAlert } from '@jis3r/icons';
	import { animate } from 'motion';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { humanizeWarning, type HumanizedWarning, type WarningSeverity } from '$lib/utils/format';

	interface Warning {
		podName: string;
		message: string;
		timestamp?: string;
	}

	interface ResourcePressure {
		cpuRatio: number | null;
		memRatio: number | null;
		cpuNear: boolean;
		memNear: boolean;
		any: boolean;
	}

	let {
		buildFailed = false,
		buildError = '',
		noPodsReady = false,
		podWarnings = [],
		resourcePressure = {
			cpuRatio: null,
			memRatio: null,
			cpuNear: false,
			memNear: false,
			any: false
		},
		dismissedIds,
		sseDisconnected = false,
		onDismiss,
		onViewLogs,
		onGoToResources
	}: {
		buildFailed?: boolean;
		buildError?: string;
		noPodsReady?: boolean;
		podWarnings?: Warning[];
		resourcePressure?: ResourcePressure;
		dismissedIds: Set<string>;
		sseDisconnected?: boolean;
		onDismiss: (id: string) => void;
		onViewLogs?: () => void;
		onGoToResources?: () => void;
	} = $props();

	interface AlertItem {
		id: string;
		severity: WarningSeverity;
		title: string;
		hint: string;
		action?: string;
		onAction?: () => void;
		flash?: boolean;
	}

	const alerts = $derived.by(() => {
		const items: AlertItem[] = [];

		// SSE disconnected
		if (sseDisconnected) {
			items.push({
				id: 'sse-disconnected',
				severity: 'warning',
				title: 'Live updates offline',
				hint: 'Real-time connection lost. Data may be outdated — it will auto-reconnect.'
			});
		}

		// Build failed
		if (buildFailed && !dismissedIds.has('build-failed')) {
			items.push({
				id: 'build-failed',
				severity: 'critical',
				title: 'Build failed',
				hint: buildError
					? buildError.split('\n')[0].slice(0, 200)
					: 'The last build did not complete successfully.',
				action: 'View build logs',
				onAction: onViewLogs,
				flash: true
			});
		}

		// No pods ready
		if (noPodsReady && !dismissedIds.has('no-pods-ready')) {
			items.push({
				id: 'no-pods-ready',
				severity: 'critical',
				title: 'Deployment is down',
				hint: 'No pods are running. Your app is not serving traffic.',
				flash: true
			});
		}

		// Resource pressure
		if (resourcePressure.any && !dismissedIds.has('resource-pressure')) {
			const parts: string[] = [];
			if (resourcePressure.cpuNear && resourcePressure.cpuRatio != null)
				parts.push(`CPU at ${Math.round(resourcePressure.cpuRatio * 100)}%`);
			if (resourcePressure.memNear && resourcePressure.memRatio != null)
				parts.push(`Memory at ${Math.round(resourcePressure.memRatio * 100)}%`);
			items.push({
				id: 'resource-pressure',
				severity: resourcePressure.memNear ? 'error' : 'warning',
				title: 'Near resource limits',
				hint: `${parts.join(' · ')} of allocated limits. ${resourcePressure.memNear ? 'Pods may be killed (OOMKilled) if memory exceeds the limit.' : 'Performance may degrade.'}`,
				action: 'Adjust resources',
				onAction: onGoToResources
			});
		}

		// Pod warnings — group by humanized title to avoid duplicates
		const seenTitles = new Set<string>();
		for (const w of podWarnings) {
			const wId = `pw:${w.podName}:${w.message}`;
			if (dismissedIds.has(wId)) continue;
			const humanized = humanizeWarning(w.message);
			if (humanized) {
				// Skip info-level and dedup by title
				if (humanized.severity === 'info') continue;
				if (seenTitles.has(humanized.title)) continue;
				seenTitles.add(humanized.title);
				items.push({
					id: wId,
					severity: humanized.severity,
					title: humanized.title,
					hint: humanized.hint,
					action: humanized.action,
					onAction:
						humanized.action === 'View logs'
							? onViewLogs
							: humanized.action === 'Increase memory' || humanized.action === 'Check resources'
								? onGoToResources
								: undefined,
					flash: humanized.severity === 'critical'
				});
			} else {
				// Unknown warning — show raw
				items.push({
					id: wId,
					severity: 'warning',
					title: `Pod ${w.podName}`,
					hint: w.message.slice(0, 200)
				});
			}
		}

		// Sort by severity: critical > error > warning > info
		const order: Record<WarningSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
		items.sort((a, b) => order[a.severity] - order[b.severity]);

		return items;
	});

	function severityIcon(s: WarningSeverity) {
		if (s === 'critical') return CircleAlert;
		if (s === 'error') return ShieldAlert;
		return TriangleAlert;
	}

	function dismissWithAnimation(el: HTMLElement, id: string) {
		animate(
			el,
			{ opacity: 0, scale: 0.95, x: 20 },
			{ type: 'spring', stiffness: 400, damping: 28, mass: 0.6 }
		).finished.then(() => {
			animate(
				el,
				{ height: 0, marginBottom: 0 },
				{ duration: 0.15, easing: [0.22, 1, 0.36, 1] }
			).finished.then(() => onDismiss(id));
		});
	}
</script>

{#if alerts.length > 0}
	<div class="da-stack">
		{#each alerts as alert, i (alert.id)}
			{@const Icon = severityIcon(alert.severity)}
			<div
				class="da-alert da-alert--{alert.severity}"
				class:da-alert--flash={alert.flash}
				{@attach motionStagger({
					index: i,
					stride: 0.04,
					from: { y: -8, opacity: 0, scale: 0.98 }
				})}
			>
				<div class="da-alert-icon">
					<Icon size={16} animate={alert.flash} />
				</div>
				<div class="da-alert-body">
					<span class="da-alert-title">{alert.title}</span>
					<span class="da-alert-hint">{alert.hint}</span>
				</div>
				{#if alert.action && alert.onAction}
					<button class="da-alert-action" onclick={alert.onAction}>
						{alert.action}
					</button>
				{/if}
				{#if alert.id !== 'sse-disconnected'}
					<button
						class="da-alert-dismiss"
						onclick={(e) => {
							const row = (e.currentTarget as HTMLElement).closest('.da-alert') as HTMLElement;
							if (row) dismissWithAnimation(row, alert.id);
							else onDismiss(alert.id);
						}}
						title="Dismiss"
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.da-stack {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.da-alert {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		border: 1px solid;
	}
	.da-alert--critical {
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
		border-color: color-mix(in srgb, var(--error-text-color) 25%, transparent);
		color: var(--error-text-color);
	}
	.da-alert--error {
		background-color: color-mix(in srgb, var(--error-text-color) 6%, transparent);
		border-color: color-mix(in srgb, var(--error-text-color) 18%, transparent);
		color: var(--error-text-color);
	}
	.da-alert--warning {
		background-color: color-mix(in srgb, var(--warning-text) 6%, transparent);
		border-color: color-mix(in srgb, var(--warning-text) 18%, transparent);
		color: var(--warning-text);
	}
	.da-alert--info {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 6%, transparent);
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 18%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.da-alert--flash {
		animation: da-pulse 2s ease-in-out infinite;
	}
	@keyframes da-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.7;
		}
	}
	.da-alert-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-top: 0.0625rem;
	}
	.da-alert-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.da-alert-title {
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.da-alert-hint {
		font-size: 0.75rem;
		opacity: 0.85;
		line-height: 1.4;
	}
	.da-alert-action {
		display: inline-flex;
		align-items: center;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid currentColor;
		background: none;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		opacity: 0.9;
		transition: opacity 120ms;
		align-self: center;
	}
	.da-alert-action:hover {
		opacity: 1;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
	}
	.da-alert-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		border: none;
		background: none;
		color: inherit;
		cursor: pointer;
		opacity: 0.5;
		flex-shrink: 0;
		transition: opacity 120ms;
		align-self: flex-start;
	}
	.da-alert-dismiss:hover {
		opacity: 1;
	}
	@media (max-width: 640px) {
		.da-alert {
			flex-wrap: wrap;
		}
		.da-alert-action {
			width: 100%;
			justify-content: center;
			margin-top: 0.25rem;
		}
	}
</style>
