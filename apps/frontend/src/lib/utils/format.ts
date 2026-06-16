import { AnsiUp } from 'ansi_up';

const ansi = new AnsiUp();
ansi.use_classes = false;

export function formatCpu(millicores: number | null | undefined): string {
	if (millicores == null) return 'N/A';
	if (millicores >= 1000) return `${(millicores / 1000).toFixed(1)} cores`;
	return `${millicores}m`;
}

export function formatMemory(bytes: number | null | undefined): string {
	if (bytes == null) return 'N/A';
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

export function formatRelativeTime(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffS = Math.floor(diffMs / 1000);
	if (diffS < 5) return 'just now';
	if (diffS < 60) return `${diffS}s ago`;
	const diffM = Math.floor(diffS / 60);
	if (diffM < 60) return `${diffM}m ago`;
	const diffH = Math.floor(diffM / 60);
	if (diffH < 24) return `${diffH}h ${diffM % 60}m ago`;
	const diffD = Math.floor(diffH / 24);
	return `${diffD}d ago`;
}

export function formatBuildDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	return `${minutes}m ${remainingSeconds}s`;
}

export function formatBuildElapsed(seconds: number): string {
	const total = Math.round(seconds);
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function formatBuildDurationBetween(
	startedAt?: string,
	completedAt?: string
): string | null {
	if (!startedAt || !completedAt) return null;
	const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
	if (!isFinite(ms) || ms < 0) return null;
	return formatBuildDuration(Math.round(ms / 1000));
}

/** Convert ANSI escape codes to HTML with color spans and formatted timestamps */
export function ansiToHtml(text: string): string {
	if (!text) return '';

	// Strip lines that contain only a timestamp (and optional whitespace/ANSI codes)
	let cleaned = text
		.replace(/\r/g, '')
		.split('\n')
		.filter((line) => {
			const stripped = line
				.replace(/\x1b\[[0-9;]*m/g, '')
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '')
				.trim();
			return stripped.length > 0;
		})
		.join('\n');

	// Convert ANSI to HTML (ansi_up handles escaping and all ANSI codes)
	let result = ansi.ansi_to_html(cleaned);

	// Replace ISO timestamps with compact local-time pills with rich tooltip
	result = result.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (ts) => {
		try {
			const d = new Date(ts);
			const h = d.getHours().toString().padStart(2, '0');
			const m = d.getMinutes().toString().padStart(2, '0');
			const s = d.getSeconds().toString().padStart(2, '0');
			const ms = d.getMilliseconds().toString().padStart(3, '0');

			const fullLocal = d.toLocaleString(undefined, {
				weekday: 'short',
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				fractionalSecondDigits: 3
			});
			const utcStr = d.toLocaleString(undefined, {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				timeZone: 'UTC',
				timeZoneName: 'short'
			});
			const ago = formatRelativeTime(d);
			const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

			return `<span class="log-ts" data-tooltip-local="${fullLocal}" data-tooltip-utc="${utcStr}" data-tooltip-ago="${ago}" data-tooltip-tz="${tz}" data-tooltip-raw="${ts}">${h}:${m}:${s}<span class="log-ts-ms">.${ms}</span></span>`;
		} catch {
			return ts;
		}
	});

	return result;
}

/** Redact sensitive tokens from log output */
export function sanitizeLogs(logs: string): string {
	if (!logs) return logs;

	let sanitized = logs;
	sanitized = sanitized.replace(
		/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi,
		'***REDACTED***'
	);
	sanitized = sanitized.replace(
		/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi,
		'https://***@github.com'
	);
	sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
	sanitized = sanitized.replace(
		/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-\.]+/gi,
		'$1 ***REDACTED***'
	);
	sanitized = sanitized.replace(
		/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
		'$1=***REDACTED***'
	);

	return sanitized;
}

export function getStatusColor(status: string) {
	switch (status?.toLowerCase()) {
		case 'ready':
		case 'running':
			return 'badge-success';
		case 'scheduled':
		case 'scaling':
		case 'restarting':
		case 'pending':
			return 'badge-warning';
		case 'unhealthy':
			return 'badge-warning';
		case 'stopped':
		case 'failed':
		case 'error':
			return 'badge-error';
		default:
			return 'badge-neutral';
	}
}

export function getDeploymentStatusLabel(status: string) {
	switch (status?.toLowerCase()) {
		case 'running':
			return 'Running';
		case 'restarting':
			return 'Restarting';
		case 'scaling':
			return 'Scaling';
		case 'failed':
			return 'Failed';
		case 'stopped':
			return 'Stopped';
		case 'unhealthy':
			return 'Unhealthy';
		case 'pending':
			return 'Pending';
		default:
			return status || 'Unknown';
	}
}

export function getBuildStatusColor(buildStatus: string) {
	switch (buildStatus?.toLowerCase()) {
		case 'succeeded':
			return 'badge-success';
		case 'building':
			return 'badge-warning';
		case 'failed':
			return 'badge-error';
		default:
			return 'badge-neutral';
	}
}

/** Translate raw kubelet/controller messages into plain-English */
export type WarningSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface HumanizedWarning {
	title: string;
	hint: string;
	severity: WarningSeverity;
	action?: string;
}

export function humanizeWarning(msg: string): HumanizedWarning | null {
	const m = msg ?? '';

	// --- Critical: deployment is down or will be down imminently ---

	if (/oomkilled|out of memory/i.test(m)) {
		return {
			title: 'Out of memory — container killed',
			hint: 'Your app exceeded its memory limit and was terminated. Increase memory in Resources or fix the memory leak.',
			severity: 'critical',
			action: 'Increase memory'
		};
	}
	if (/back-?off.*restarting failed container/i.test(m) || /crashloopbackoff/i.test(m)) {
		return {
			title: 'Crash loop — app keeps crashing',
			hint: 'Your app crashes on startup, Kubernetes restarts it, and it crashes again. Check logs for the error.',
			severity: 'critical',
			action: 'View logs'
		};
	}
	if (/evicted/i.test(m)) {
		return {
			title: 'Pod evicted',
			hint: 'The node ran out of resources and kicked this pod. It should reschedule automatically. If it keeps happening, reduce resource usage.',
			severity: 'critical'
		};
	}
	if (/deadline exceeded/i.test(m) || /progressdeadlineexceeded/i.test(m)) {
		return {
			title: 'Deployment timed out',
			hint: 'Kubernetes gave up waiting for the new version to become healthy. The app may be crashing or taking too long to start.',
			severity: 'critical',
			action: 'View logs'
		};
	}

	// --- Error: something is broken but may self-heal ---

	const restarts = m.match(/has restarted (\d+) time\(s\)/i);
	if (restarts) {
		const count = parseInt(restarts[1]);
		return {
			title: `Restarted ${count} time${count === 1 ? '' : 's'}`,
			hint:
				count >= 5
					? 'Frequent restarts usually mean the app is crashing on startup. Check logs for errors.'
					: 'The container exited and was restarted. One or two restarts can be normal during deploys.',
			severity: count >= 5 ? 'error' : 'warning',
			action: count >= 5 ? 'View logs' : undefined
		};
	}
	if (/imagepullbackoff|errimagepull|failed to pull image/i.test(m)) {
		return {
			title: "Can't pull container image",
			hint: 'The image name or tag may be wrong, or the registry requires authentication.',
			severity: 'error',
			action: 'Check image'
		};
	}
	if (/exec format error/i.test(m) || /exec.*format/i.test(m)) {
		return {
			title: 'Wrong CPU architecture',
			hint: 'The container image was built for a different architecture (e.g. ARM vs x86). Rebuild for the correct platform.',
			severity: 'error',
			action: 'Rebuild'
		};
	}
	if (/permission denied|operation not permitted/i.test(m) && !/pull/i.test(m)) {
		return {
			title: 'Permission denied inside container',
			hint: "The process tried to access something it doesn't have permission for. This can happen with file system operations or privileged syscalls.",
			severity: 'error'
		};
	}
	if (/liveness probe failed/i.test(m)) {
		return {
			title: 'Health check failing — restarting',
			hint: 'Your app stopped responding to its health check and is being restarted. This usually means the app froze or is overloaded.',
			severity: 'error',
			action: 'Check health settings'
		};
	}
	if (/startup probe failed/i.test(m)) {
		return {
			title: 'App taking too long to start',
			hint: 'The startup health check timed out. Your app may need more time to initialize. Increase the startup failure threshold.',
			severity: 'error',
			action: 'Check health settings'
		};
	}
	if (/failedscheduling/i.test(m) || /0\/\d+ nodes are available/i.test(m)) {
		return {
			title: 'No available nodes',
			hint: 'No node has enough free CPU or memory to run this pod. Try reducing resource requests or wait for capacity.',
			severity: 'error',
			action: 'Check resources'
		};
	}
	if (/failedmount|failed to attach volume|unable to attach or mount/i.test(m)) {
		return {
			title: "Can't attach storage",
			hint: "The persistent volume couldn't be mounted. It may be in use by another pod or the storage class is unavailable.",
			severity: 'error'
		};
	}
	if (/containercreating/i.test(m) && /timeout/i.test(m)) {
		return {
			title: 'Container stuck creating',
			hint: 'The container is taking an unusually long time to start. Could be a slow image pull or volume mount.',
			severity: 'error'
		};
	}
	if (
		/init.*container.*(?:error|fail|crash)/i.test(m) ||
		/init:error/i.test(m) ||
		/init:crashloopbackoff/i.test(m)
	) {
		return {
			title: 'Init container failed',
			hint: "A setup step that runs before your app crashed. Your app won't start until this is fixed.",
			severity: 'error',
			action: 'View logs'
		};
	}

	// --- Warning: degraded but not broken ---

	if (/readiness probe failed/i.test(m)) {
		return {
			title: 'Not ready for traffic',
			hint: "The app is running but failing its readiness check. It won't receive traffic until it passes. Usually a slow boot or failing dependency.",
			severity: 'warning'
		};
	}
	if (/configmap.*not found|secret.*not found/i.test(m)) {
		return {
			title: 'Missing config or secret',
			hint: "The pod references a ConfigMap or Secret that doesn't exist. Check your environment variable configuration.",
			severity: 'warning',
			action: 'Check environment'
		};
	}
	if (/dnsconfig|dns/i.test(m) && /fail/i.test(m)) {
		return {
			title: 'DNS resolution failing',
			hint: "The pod can't resolve domain names. External API calls and database connections may fail.",
			severity: 'warning'
		};
	}
	if (/node.*pressure|diskpressure|memorypressure|pidpressure/i.test(m)) {
		return {
			title: 'Node under pressure',
			hint: 'The node running your pod is low on resources. Pods may be evicted if pressure continues.',
			severity: 'warning'
		};
	}
	if (/preempt/i.test(m)) {
		return {
			title: 'Pod preempted',
			hint: "A higher-priority workload needed this pod's resources. It will be rescheduled automatically.",
			severity: 'warning'
		};
	}
	if (/insufficient cpu/i.test(m)) {
		return {
			title: 'Not enough CPU available',
			hint: "The cluster doesn't have enough CPU to schedule this pod. Try lowering the CPU request.",
			severity: 'warning',
			action: 'Check resources'
		};
	}
	if (/insufficient memory/i.test(m)) {
		return {
			title: 'Not enough memory available',
			hint: "The cluster doesn't have enough memory to schedule this pod. Try lowering the memory request.",
			severity: 'warning',
			action: 'Check resources'
		};
	}
	if (/pull.*rate.*limit|too many requests/i.test(m)) {
		return {
			title: 'Registry rate limited',
			hint: 'The container registry is throttling image pulls. This usually resolves on its own. Consider using a private registry.',
			severity: 'warning'
		};
	}
	if (/network.*not ready|cni/i.test(m)) {
		return {
			title: 'Network not ready',
			hint: "The pod's network interface isn't configured yet. Usually transient during node startup.",
			severity: 'warning'
		};
	}

	// --- Info: transient or expected ---

	if (/pulling image/i.test(m)) {
		return {
			title: 'Pulling container image',
			hint: 'Downloading the container image. First pulls take longer.',
			severity: 'info'
		};
	}
	if (/successfully pulled/i.test(m)) {
		return {
			title: 'Image pulled successfully',
			hint: 'The container image was downloaded and is ready to start.',
			severity: 'info'
		};
	}
	if (/created container|started container/i.test(m)) {
		return {
			title: 'Container starting',
			hint: 'The container has been created and is booting up.',
			severity: 'info'
		};
	}
	if (/killing.*container.*with.*signal/i.test(m) || /stopping container/i.test(m)) {
		return {
			title: 'Container shutting down',
			hint: 'The container is being gracefully stopped. This is normal during deploys and restarts.',
			severity: 'info'
		};
	}

	return null;
}

/** Svelte action: portal node to document.body */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}

/** Get the short suffix from a pod name: "backend-cb974cb4c-vjvfb" → "vjvfb" */
export function podLabel(podName: string): string {
	const parts = podName.split('-');
	return parts.length >= 2 ? parts[parts.length - 1] : podName;
}

/** Parse raw .env text into key-value pairs */
export function rawToEnvVars(raw: string): Array<{ key: string; value: string }> {
	const lines = raw.split('\n');
	const parsed: Array<{ key: string; value: string }> = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const equalIndex = trimmed.indexOf('=');
		if (equalIndex === -1) continue;
		const key = trimmed.substring(0, equalIndex).trim();
		const value = trimmed.substring(equalIndex + 1).trim();
		if (key) parsed.push({ key, value });
	}
	return parsed;
}

/** Convert env vars array to raw .env text */
export function envVarsToRaw(vars: Array<{ key: string; value: string }>): string {
	return vars
		.filter((e) => e.key.trim())
		.map((e) => `${e.key}=${e.value}`)
		.join('\n');
}
