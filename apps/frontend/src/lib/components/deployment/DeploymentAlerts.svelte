<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { humanizeWarning, type WarningSeverity } from '$lib/utils/format';
	import type { AlertState } from '$lib/components/notifications/alerts';
	import AlertStack, { type StackAlert } from '$lib/components/patterns/AlertStack.svelte';

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
		applyError = '',
		onRetryApply,
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
		githubRepoUrl = '',
		metricAlerts = [],
		onGoToAlerts
	}: {
		buildFailed?: boolean;
		buildError?: string;
		applyError?: string;
		onRetryApply?: () => void;
		noPodsReady?: boolean;
		podWarnings?: Warning[];
		resourcePressure?: ResourcePressure;
		onViewLogs?: () => void;
		onGoToResources?: () => void;
		onReconnectGithub?: () => void;
		canReconnectGithub?: boolean;
		githubRepoUrl?: string;
		metricAlerts?: AlertState[];
		onGoToAlerts?: () => void;
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

		for (const a of metricAlerts) {
			if (a.status !== 'firing' && a.status !== 'recovering') continue;
			items.push({
				id: `alert:${a.ruleId}`,
				severity: a.status === 'firing' ? 'error' : 'warning',
				title: a.label,
				hint: a.valueLabel ? `Now ${a.valueLabel}` : 'Over the threshold',
				action: 'Alerts',
				onAction: onGoToAlerts,
				animateIcon: a.status === 'firing'
			});
		}

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

		if (applyError) {
			items.push({
				id: 'apply-error',
				severity: 'error',
				title: 'Change not applied to the cluster',
				hint: applyError.split('\n')[0].slice(0, 200),
				action: onRetryApply ? 'Retry' : undefined,
				onAction: onRetryApply,
				animateIcon: true
			});
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

	const TONE: Record<WarningSeverity, 'error' | 'warning' | 'info'> = {
		critical: 'error',
		error: 'error',
		warning: 'warning',
		info: 'info'
	};

	const stackAlerts = $derived<StackAlert[]>(
		alerts.map((alert) => ({
			id: alert.id,
			tone: TONE[alert.severity] ?? 'warning',
			title: alert.title.split(' — ')[0],
			hint: alert.hint,
			dismissible: alert.severity !== 'critical',
			actions: alert.actions?.length
				? alert.actions.map((act) => ({ label: act.label, href: act.href, onclick: act.onAction }))
				: alert.action && alert.onAction
					? [{ label: alert.action, onclick: alert.onAction }]
					: []
		}))
	);
</script>

<AlertStack alerts={stackAlerts} ondismiss={(id) => dismissed.add(id)} />
