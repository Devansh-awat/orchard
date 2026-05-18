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

export function formatBuildDurationBetween(startedAt?: string, completedAt?: string): string | null {
	if (!startedAt || !completedAt) return null;
	const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
	if (!isFinite(ms) || ms < 0) return null;
	return formatBuildDuration(Math.round(ms / 1000));
}

/** Convert ANSI escape codes to HTML with color spans and formatted timestamps */
export function ansiToHtml(text: string): string {
	if (!text) return '';

	// Strip lines that contain only a timestamp (and optional whitespace/ANSI codes)
	let cleaned = text.replace(/\r/g, '').split('\n').filter(line => {
		const stripped = line
			.replace(/\x1b\[[0-9;]*m/g, '')
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '')
			.trim();
		return stripped.length > 0;
	}).join('\n');

	// Convert ANSI to HTML (ansi_up handles escaping and all ANSI codes)
	let result = ansi.ansi_to_html(cleaned);

	// Replace ISO timestamps with compact local-time pills with rich tooltip
	result = result.replace(
		/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
		(ts) => {
			try {
				const d = new Date(ts);
				const h = d.getHours().toString().padStart(2, '0');
				const m = d.getMinutes().toString().padStart(2, '0');
				const s = d.getSeconds().toString().padStart(2, '0');
				const ms = d.getMilliseconds().toString().padStart(3, '0');

				const fullLocal = d.toLocaleString(undefined, {
					weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
					hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
				});
				const utcStr = d.toLocaleString(undefined, {
					hour: '2-digit', minute: '2-digit', second: '2-digit',
					timeZone: 'UTC', timeZoneName: 'short'
				});
				const ago = formatRelativeTime(d);
				const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

				return `<span class="log-ts" data-tooltip-local="${fullLocal}" data-tooltip-utc="${utcStr}" data-tooltip-ago="${ago}" data-tooltip-tz="${tz}" data-tooltip-raw="${ts}">${h}:${m}:${s}<span class="log-ts-ms">.${ms}</span></span>`;
			} catch {
				return ts;
			}
		}
	);

	return result;
}

/** Redact sensitive tokens from log output */
export function sanitizeLogs(logs: string): string {
	if (!logs) return logs;

	let sanitized = logs;
	sanitized = sanitized.replace(/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi, '***REDACTED***');
	sanitized = sanitized.replace(/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi, 'https://***@github.com');
	sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
	sanitized = sanitized.replace(/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-\.]+/gi, '$1 ***REDACTED***');
	sanitized = sanitized.replace(/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi, '$1=***REDACTED***');

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
		case 'running': return 'Running';
		case 'restarting': return 'Restarting';
		case 'scaling': return 'Scaling';
		case 'failed': return 'Failed';
		case 'stopped': return 'Stopped';
		case 'unhealthy': return 'Unhealthy';
		case 'pending': return 'Pending';
		default: return status || 'Unknown';
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
export function humanizeWarning(msg: string): { title: string; hint: string } | null {
	const m = msg ?? '';
	const restarts = m.match(/has restarted (\d+) time\(s\)/i);
	if (restarts) {
		return {
			title: `Container restarted ${restarts[1]} time${restarts[1] === '1' ? '' : 's'}`,
			hint: 'Kubernetes is restarting it after it exited. Frequent restarts usually mean the app is crashing on startup or being killed.'
		};
	}
	if (/back-?off.*restarting failed container/i.test(m) || /crashloopbackoff/i.test(m)) {
		return {
			title: 'Container keeps crashing on startup',
			hint: 'Kubernetes is waiting longer between retries (back-off). Check the pod logs for the crash reason.'
		};
	}
	if (/imagepullbackoff|errimagepull|failed to pull image/i.test(m)) {
		return {
			title: "Couldn't pull the container image",
			hint: 'The image name may be wrong, the tag missing, or the registry needs credentials.'
		};
	}
	if (/oomkilled|out of memory/i.test(m)) {
		return {
			title: 'Container ran out of memory',
			hint: 'The pod was killed for exceeding its memory limit. Raise the memory request or fix the leak.'
		};
	}
	if (/liveness probe failed/i.test(m)) {
		return {
			title: 'Liveness check is failing',
			hint: "Kubernetes is restarting the container because it stopped responding to its health check."
		};
	}
	if (/readiness probe failed/i.test(m)) {
		return {
			title: 'Readiness check is failing',
			hint: "The container is up but not ready to serve traffic yet — usually a slow boot or a failing dependency."
		};
	}
	if (/failedscheduling/i.test(m) || /0\/\d+ nodes are available/i.test(m)) {
		return {
			title: "Couldn't place the pod on any node",
			hint: 'No node has enough free CPU/memory, or the node selectors/taints exclude every node.'
		};
	}
	if (/failedmount|failed to attach volume/i.test(m)) {
		return {
			title: "Couldn't mount a storage volume",
			hint: 'The PVC may be missing, not yet bound, or attached to another node.'
		};
	}
	if (/configmap.*not found|secret.*not found/i.test(m)) {
		return {
			title: 'A referenced config or secret is missing',
			hint: 'The pod references a ConfigMap or Secret that does not exist in this namespace.'
		};
	}
	if (/dnsconfig|dns/i.test(m) && /fail/i.test(m)) {
		return {
			title: 'DNS lookups inside the pod are failing',
			hint: 'Cluster DNS is unreachable or misconfigured.'
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
	return vars.filter((e) => e.key.trim()).map((e) => `${e.key}=${e.value}`).join('\n');
}
