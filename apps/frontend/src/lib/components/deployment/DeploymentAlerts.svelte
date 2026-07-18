<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { X } from 'lucide-svelte';
	import { ShieldAlert, TriangleAlert, CircleAlert } from '@jis3r/icons';
	import { animate } from 'motion';
	import { motionStagger, functionalMotion } from '$lib/utils/motion.svelte';
	import { humanizeWarning, type WarningSeverity } from '$lib/utils/format';

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
		onViewLogs,
		onGoToResources,
		onReconnectGithub,
		canReconnectGithub = false,
		githubRepoUrl = ''
	}: {
		buildFailed?: boolean;
		buildError?: string;
		noPodsReady?: boolean;
		podWarnings?: Warning[];
		resourcePressure?: ResourcePressure;
		onViewLogs?: () => void;
		onGoToResources?: () => void;
		onReconnectGithub?: () => void;
		canReconnectGithub?: boolean;
		githubRepoUrl?: string;
	} = $props();

	interface AlertAction {
		label: string;
		onAction?: () => void;
		href?: string;
	}

	interface AlertItem {
		id: string;
		severity: WarningSeverity;
		title: string;
		hint: string;
		action?: string;
		onAction?: () => void;
		actions?: AlertAction[];
		animateIcon?: boolean;
	}

	// Pod warnings are keyed by condition kind (humanized title), not by pod
	// instance. A crash-looping pod that gets recreated keeps the same alert row
	// instead of flapping. Each kind lingers for a short grace window after the
	// underlying events disappear, smoothing the gap while a replacement pod
	// spins up; once the grace expires the alert clears for real.
	const POD_KIND_GRACE_MS = 60_000;
	const podKindCache = new Map<string, { item: AlertItem; lastSeen: number }>();
	let graceTick = $state(0);

	$effect(() => {
		const interval = setInterval(() => {
			if (podKindCache.size > 0) graceTick += 1;
		}, 15_000);
		return () => clearInterval(interval);
	});

	const podAlerts = $derived.by(() => {
		void graceTick;
		const now = Date.now();
		const seen = new Set<string>();
		for (const w of podWarnings) {
			const humanized = humanizeWarning(w.message);
			if (humanized?.severity === 'info') continue;
			const id = humanized ? `pw:${humanized.title}` : `pw:raw:${w.message.slice(0, 120)}`;
			if (seen.has(id)) continue;
			seen.add(id);
			podKindCache.set(id, {
				lastSeen: now,
				item: humanized
					? {
							id,
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
							animateIcon: humanized.severity === 'critical'
						}
					: {
							id,
							severity: 'warning',
							title: `Pod ${w.podName}`,
							hint: w.message.slice(0, 200)
						}
			});
		}
		for (const [id, entry] of podKindCache) {
			if (!seen.has(id) && now - entry.lastSeen > POD_KIND_GRACE_MS) podKindCache.delete(id);
		}
		return [...podKindCache.values()].map((e) => e.item);
	});

	const candidates = $derived.by(() => {
		const items: AlertItem[] = [];

		if (buildFailed) {
			const isGithubAuth =
				/github authentication failed|could not read username|terminal prompts disabled|repository not found/i.test(
					buildError
				);
			if (isGithubAuth) {
				const actions: AlertAction[] = [];
				const repo = githubRepoUrl.replace(/\.git$/, '');
				if (repo) actions.push({ label: 'Check repo access', href: repo });
				if (canReconnectGithub && onReconnectGithub)
					actions.push({ label: 'Reconnect GitHub', onAction: onReconnectGithub });
				if (onViewLogs) actions.push({ label: 'View logs', onAction: onViewLogs });
				items.push({
					id: 'build-failed-github-auth',
					severity: 'critical',
					title: 'Cannot access the GitHub repository',
					hint: canReconnectGithub
						? 'The build could not read this repository. Confirm you can open it on GitHub, or reconnect your GitHub account if your access changed.'
						: 'The build could not read this repository. Confirm you can open it on GitHub, or ask the deployment owner to reconnect their GitHub account.',
					actions,
					animateIcon: true
				});
			} else {
				items.push({
					id: `build-failed:${buildError.slice(0, 80)}`,
					severity: 'critical',
					title: 'Deployment failed',
					hint: buildError
						? buildError.split('\n')[0].slice(0, 200)
						: 'The last deployment did not complete successfully.',
					action: 'View deployment logs',
					onAction: onViewLogs,
					animateIcon: true
				});
			}
		}

		if (noPodsReady) {
			items.push({
				id: 'app-down',
				severity: 'critical',
				title: 'App is down',
				hint: 'No pod has been ready for over a minute. Your app is not serving traffic.',
				action: 'View logs',
				onAction: onViewLogs,
				animateIcon: true
			});
		}

		if (resourcePressure.any) {
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

		items.push(...podAlerts);

		const order: Record<WarningSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
		items.sort((a, b) => order[a.severity] - order[b.severity]);
		return items;
	});

	// Dismissals are session-local and evaporate the moment the underlying
	// condition resolves, so a recurring problem always re-alerts and nothing
	// stale survives a fix.
	const dismissed = new SvelteSet<string>();

	$effect(() => {
		const active = new Set(candidates.map((a) => a.id));
		untrack(() => {
			for (const id of [...dismissed]) {
				if (!active.has(id)) dismissed.delete(id);
			}
		});
	});

	const alerts = $derived(candidates.filter((a) => !dismissed.has(a.id)));

	function severityIcon(s: WarningSeverity) {
		if (s === 'critical') return CircleAlert;
		if (s === 'error') return ShieldAlert;
		return TriangleAlert;
	}

	function dismissWithAnimation(el: HTMLElement, id: string) {
		if (!functionalMotion()) {
			dismissed.add(id);
			return;
		}
		animate(
			el,
			{ opacity: 0, scale: 0.95, x: 20 },
			{ type: 'spring', stiffness: 400, damping: 28, mass: 0.6 }
		).finished.then(() => {
			animate(
				el,
				{ height: 0, marginBottom: 0 },
				{ duration: 0.15, easing: [0.22, 1, 0.36, 1] }
			).finished.then(() => dismissed.add(id));
		});
	}
</script>

{#if alerts.length > 0}
	<div class="da-stack">
		{#each alerts as alert, i (alert.id)}
			{@const Icon = severityIcon(alert.severity)}
			<div
				class="da-alert da-alert--{alert.severity}"
				{@attach motionStagger({
					index: i,
					stride: 0.04,
					from: { y: -8, opacity: 0, scale: 0.98 }
				})}
			>
				<div class="da-alert-icon">
					<Icon size={16} animate={alert.animateIcon ?? false} />
				</div>
				<div class="da-alert-body">
					<span class="da-alert-title">{alert.title}</span>
					<span class="da-alert-hint">{alert.hint}</span>
				</div>
				{#if alert.actions && alert.actions.length > 0}
					<div class="da-alert-actions">
						{#each alert.actions as act (act.label)}
							{#if act.href}
								<a
									class="da-alert-action"
									href={act.href}
									target="_blank"
									rel="noopener noreferrer"
								>
									{act.label}
								</a>
							{:else}
								<button class="da-alert-action" onclick={act.onAction}>
									{act.label}
								</button>
							{/if}
						{/each}
					</div>
				{:else if alert.action && alert.onAction}
					<button class="da-alert-action" onclick={alert.onAction}>
						{alert.action}
					</button>
				{/if}
				<button
					class="da-alert-dismiss"
					onclick={(e) => {
						const row = (e.currentTarget as HTMLElement).closest('.da-alert') as HTMLElement;
						if (row) dismissWithAnimation(row, alert.id);
						else dismissed.add(alert.id);
					}}
					title="Dismiss"
				>
					<X class="h-3.5 w-3.5" />
				</button>
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
		--da-tone: var(--warning-text);
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		border-radius: 0.625rem;
		border: 1px solid color-mix(in srgb, var(--da-tone) 22%, var(--surface-border));
		background-color: color-mix(in srgb, var(--da-tone) 6%, var(--surface-bg));
		color: var(--center-channel-color);
	}
	.da-alert--critical,
	.da-alert--error {
		--da-tone: var(--error-text-color);
	}
	.da-alert--critical {
		border-color: color-mix(in srgb, var(--da-tone) 32%, var(--surface-border));
		background-color: color-mix(in srgb, var(--da-tone) 9%, var(--surface-bg));
	}
	.da-alert-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-top: 0.0625rem;
		color: color-mix(in srgb, var(--da-tone) 80%, var(--center-channel-color));
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
		color: var(--da-tone);
	}
	.da-alert-hint {
		font-size: 0.75rem;
		line-height: 1.4;
		opacity: 0.75;
	}
	.da-alert-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		align-self: center;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.da-alert-action {
		display: inline-flex;
		align-items: center;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid color-mix(in srgb, var(--da-tone) 35%, var(--surface-border));
		background-color: var(--surface-bg);
		color: var(--da-tone);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition: background-color 120ms;
		align-self: center;
		text-decoration: none;
	}
	.da-alert-action:hover {
		background-color: color-mix(in srgb, var(--da-tone) 10%, var(--surface-bg));
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
		opacity: 0.45;
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
		.da-alert-actions {
			width: 100%;
			margin-top: 0.25rem;
		}
		.da-alert-action {
			flex: 1;
			justify-content: center;
			margin-top: 0.25rem;
		}
	}
</style>
