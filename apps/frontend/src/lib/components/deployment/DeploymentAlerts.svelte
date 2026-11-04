<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { WarningSeverity } from '$lib/utils/format';
	import type { AlertState } from '$lib/components/notifications/alerts';
	import { anomalyAge, type Anomaly } from '$lib/components/anomalies/anomalies';
	import AlertStack, { type StackAlert } from '$lib/components/patterns/AlertStack.svelte';
	import type { PodProblem, Problem } from '$health';
	import { parseBuildkitLogs } from '$lib/utils/buildkitParser';
	import { diagnoseBuild } from '$lib/utils/build-failure';

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
		buildLogs = '',
		applyError = '',
		onRetryApply,
		problems = [],
		serving = 0,
		onPodLogs,
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
		anomalies = [],
		onGoToAlerts
	}: {
		buildFailed?: boolean;
		buildError?: string;
		buildLogs?: string | null;
		applyError?: string;
		onRetryApply?: () => void;
		problems?: Problem[];
		serving?: number;
		onPodLogs?: (podName: string, problem?: PodProblem) => void;
		resourcePressure?: ResourcePressure;
		onViewLogs?: () => void;
		onGoToResources?: () => void;
		onReconnectGithub?: () => void;
		canReconnectGithub?: boolean;
		githubRepoUrl?: string;
		metricAlerts?: AlertState[];
		anomalies?: Anomaly[];
		onGoToAlerts?: () => void;
	} = $props();

	interface AlertAction {
		label: string;
		onAction?: () => void;
		href?: string;
		external?: boolean;
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

	const LOGGED: ReadonlySet<PodProblem> = new Set([
		'crash-loop',
		'liveness',
		'exited',
		'not-ready',
		'stuck-terminating'
	]);

	const isGithubAuth = $derived(
		buildFailed &&
			/github authentication failed|could not read username|terminal prompts disabled|repository not found/i.test(
				buildError
			)
	);

	const buildCause = $derived.by(() => {
		if (!buildFailed) return '';
		const failure = diagnoseBuild({
			parsed: parseBuildkitLogs(buildLogs ?? ''),
			error: buildError
		});
		return failure.title.replaceAll('`', '').replace(/\.$/, '').slice(0, 160);
	});

	const healthAlerts = $derived(
		problems
			.filter((p) => p.scope !== 'build' || !isGithubAuth)
			.map((p): AlertItem => {
				const pod = p.pods?.[0];
				const actions: AlertAction[] = [];
				if (p.scope === 'build') {
					if (onViewLogs) actions.push({ label: 'Build logs', onAction: onViewLogs });
				} else if (p.problem === 'out-of-memory') {
					if (onGoToResources) actions.push({ label: 'Raise memory', onAction: onGoToResources });
					if (pod && onPodLogs)
						actions.push({ label: 'Logs', onAction: () => onPodLogs(pod, p.problem ?? undefined) });
				} else if (p.problem === 'unschedulable') {
					if (onGoToResources) actions.push({ label: 'Resources', onAction: onGoToResources });
				} else if (pod && onPodLogs && p.problem && LOGGED.has(p.problem)) {
					actions.push({ label: 'Logs', onAction: () => onPodLogs(pod, p.problem ?? undefined) });
				}
				const cause = p.scope === 'build' ? buildCause : '';
				return {
					id: `health:${p.id}:${p.problem ?? ''}`,
					severity: p.tone === 'error' ? (p.scope === 'app' ? 'critical' : 'error') : 'warning',
					title: p.title,
					hint: cause ? `${cause}. ${p.hint}` : p.hint,
					actions,
					animateIcon: p.tone === 'error'
				};
			})
	);

	const candidates = $derived.by(() => {
		const items: AlertItem[] = [];

		for (const a of anomalies) {
			const age = anomalyAge(a.since);
			items.push({
				id: `anomaly:${a.id}`,
				severity: a.severity === 'warning' ? 'warning' : 'error',
				title: a.title.replace(/^[a-z]/, (c) => c.toUpperCase()),
				hint: age ? `${a.detail} · ${age}` : a.detail,
				actions: a.action ? [{ label: a.action.label, href: a.action.href }] : [],
				animateIcon: a.severity !== 'warning'
			});
		}

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

		if (isGithubAuth) {
			const actions: AlertAction[] = [];
			const repo = githubRepoUrl.replace(/\.git$/, '');
			if (repo) actions.push({ label: 'Check repo access', href: repo, external: true });
			if (canReconnectGithub && onReconnectGithub)
				actions.push({ label: 'Reconnect GitHub', onAction: onReconnectGithub });
			if (onViewLogs) actions.push({ label: 'Build logs', onAction: onViewLogs });
			items.push({
				id: 'build-failed-github-auth',
				severity: serving > 0 ? 'error' : 'critical',
				title: "Build failed: can't read the GitHub repository",
				hint: canReconnectGithub
					? 'Confirm you can open it on GitHub, or reconnect your GitHub account.'
					: 'Confirm you can open it on GitHub, or ask the owner to reconnect their account.',
				actions,
				animateIcon: true
			});
		}

		if (applyError) {
			items.push({
				id: 'apply-error',
				severity: 'error',
				title: 'Change not applied',
				hint: applyError.split('\n')[0].slice(0, 200),
				action: onRetryApply ? 'Retry' : undefined,
				onAction: onRetryApply,
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
				hint: `${parts.join(' · ')} of allocated limits. ${resourcePressure.memNear ? 'Pods restart if they use more than the memory limit.' : 'The app may slow down.'}`,
				action: 'Adjust resources',
				onAction: onGoToResources
			});
		}

		items.push(...healthAlerts);

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
				? alert.actions.map((act) => ({
						label: act.label,
						href: act.href,
						external: act.external,
						onclick: act.onAction
					}))
				: alert.action && alert.onAction
					? [{ label: alert.action, onclick: alert.onAction }]
					: []
		}))
	);
</script>

<AlertStack alerts={stackAlerts} ondismiss={(id) => dismissed.add(id)} />
