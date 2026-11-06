import { AnsiUp } from 'ansi_up';
import { clockOptions, logDisplay, logDisplaySignature } from '$lib/stores/log-display.svelte';
import { elapsedSince } from './clock.svelte';

const ansi = new AnsiUp();
ansi.use_classes = true;

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

export function formatPlan(plan: string | null | undefined): string | undefined {
	if (!plan) return undefined;
	return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
}

export function formatRelativeTime(date: Date): string {
	const diffMs = elapsedSince(date.getTime());
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
	if (!Number.isFinite(ms) || ms < 0) return null;
	return formatBuildDuration(Math.round(ms / 1000));
}

// oxlint-disable-next-line no-control-regex
const ANSI_CODE_RE = /\x1b\[[0-9;]*m/g;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: 'time' | 'date' | 'day', sig: string): Intl.DateTimeFormat {
	const key = `${kind}:${sig}`;
	const hit = formatters.get(key);
	if (hit) return hit;
	const timeZone = logDisplay.zone === 'utc' ? 'UTC' : undefined;
	const shapes: Record<typeof kind, Intl.DateTimeFormatOptions> = {
		time: {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			timeZone,
			...clockOptions()
		},
		date: { month: 'short', day: 'numeric', timeZone },
		day: { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }
	};
	const made = new Intl.DateTimeFormat(undefined, shapes[kind]);
	formatters.set(key, made);
	return made;
}

let todayKey = { sig: '', minute: -1, value: '' };

function today(sig: string): string {
	const now = Date.now();
	const minute = Math.floor(now / 60_000);
	if (todayKey.sig !== sig || todayKey.minute !== minute) {
		todayKey = { sig, minute, value: formatter('day', sig).format(new Date(now)) };
	}
	return todayKey.value;
}

function timeWithMillis(d: Date, sig: string): string {
	const parts = formatter('time', sig).formatToParts(d);
	const ms = logDisplay.milliseconds
		? `<span class="log-ts-ms">.${d.getMilliseconds().toString().padStart(3, '0')}</span>`
		: '';
	let out = '';
	for (const part of parts) {
		out += part.value;
		if (part.type === 'second') out += ms;
	}
	return out;
}

function timestampPill(ts: string): string {
	try {
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return ts;
		const sig = logDisplaySignature();

		const showDate =
			logDisplay.date === 'always' ||
			(logDisplay.date === 'auto' && formatter('day', sig).format(d) !== today(sig));
		const date = showDate
			? `<span class="log-ts-date">${formatter('date', sig).format(d)}</span>`
			: '';
		const zone = logDisplay.zone === 'utc' ? '<span class="log-ts-zone">UTC</span>' : '';

		return `<span class="log-ts" data-ts="${ts}">${date}${timeWithMillis(d, sig)}${zone}</span>`;
	} catch {
		return ts;
	}
}

// Per-line conversion cache: log views re-render the same lines on every poll,
// so memoizing per line makes repeat conversions free. Bounded to keep memory
// in check; a full clear is fine because entries repopulate on next render.
const lineCache = new Map<string, string>();
const LINE_CACHE_MAX = 30_000;

function adaptGreys(html: string): string {
	return html.replace(/color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/g, (m, r, g, b) => {
		if (r !== g || g !== b) return m;
		return `color:var(${Number(r) < 128 ? '--text-faint' : '--text-muted'})`;
	});
}

function ansiLineToHtml(line: string): string {
	const key = `${logDisplaySignature()}\u0000${line}`;
	const cached = lineCache.get(key);
	if (cached !== undefined) return cached;
	const html = adaptGreys(ansi.ansi_to_html(line).replace(ISO_TS_RE, timestampPill));
	if (lineCache.size >= LINE_CACHE_MAX) lineCache.clear();
	lineCache.set(key, html);
	return html;
}

/** Convert ANSI log text to per-line HTML fragments, skipping empty lines. */
export function ansiToHtmlLines(text: string): string[] {
	if (!text) return [];

	const out: string[] = [];
	for (const line of text.replace(/\r/g, '').split('\n')) {
		const stripped = line.replace(ANSI_CODE_RE, '').replace(ISO_TS_RE, '').trim();
		if (!stripped) continue;
		out.push(ansiLineToHtml(line));
	}
	return out;
}

/** Convert ANSI escape codes to HTML with color spans and formatted timestamps */
export function ansiToHtml(text: string): string {
	return ansiToHtmlLines(text).join('\n');
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
		/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-.]+/gi,
		'$1 ***REDACTED***'
	);
	sanitized = sanitized.replace(
		/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
		'$1=***REDACTED***'
	);

	return sanitized;
}

/** Translate raw kubelet/controller messages into plain-English */
export type WarningSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface HumanizedWarning {
	title: string;
	hint: string;
	severity: WarningSeverity;
	action?: string;
}

export interface ExplainedExit {
	short: string;
	severity: WarningSeverity;
}

export function explainExitCode(
	code: number | null | undefined,
	reason?: string | null
): ExplainedExit | null {
	if (/oomkilled/i.test(reason ?? ''))
		return { short: 'Killed for going over its memory limit', severity: 'critical' };

	if (code == null) {
		if (!reason) return null;
		return { short: reason, severity: 'error' };
	}

	switch (code) {
		case 0:
			return { short: 'Exited on its own with no error', severity: 'warning' };
		case 1:
			return { short: 'Threw an unhandled error on startup', severity: 'error' };
		case 2:
			return { short: 'Start command was rejected as malformed', severity: 'error' };
		case 126:
			return { short: "Start command isn't executable", severity: 'error' };
		case 127:
			return { short: "Start command wasn't found in the image", severity: 'error' };
		case 139:
			return { short: 'Segfaulted on invalid memory access', severity: 'critical' };
		case 143:
			return { short: 'Stopped normally on a shutdown request', severity: 'info' };
		case 255:
			return { short: 'Died during startup without reporting a reason', severity: 'error' };
		default:
			break;
	}

	if (code > 128 && code < 165)
		return { short: `Killed by signal ${code - 128}`, severity: 'error' };

	return { short: `Stopped with exit code ${code}`, severity: 'error' };
}

export function humanizeWarning(msg: string): HumanizedWarning | null {
	const m = msg ?? '';

	// Critical: deployment is down or will be down imminently

	if (/oomkilled|out of memory/i.test(m)) {
		return {
			title: 'Out of memory: container killed',
			hint: 'Your app exceeded its memory limit and was terminated. Increase memory in Resources or fix the memory leak.',
			severity: 'critical',
			action: 'Increase memory'
		};
	}
	if (/back-?off.*restarting failed container/i.test(m) || /crashloopbackoff/i.test(m)) {
		return {
			title: 'Crash loop: app keeps crashing',
			hint: 'Your app crashes on startup, Kubernetes restarts it, and it crashes again. Check logs for the error.',
			severity: 'critical',
			action: 'View logs'
		};
	}
	if (/evicted/i.test(m)) {
		return {
			title: 'Pod evicted',
			hint: 'The node ran out of resources and removed this pod. Kubernetes moves it to another node. If this keeps happening, reduce resource usage.',
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

	// Error: something is broken but may self-heal

	const restarts = m.match(/has restarted (\d+) time\(s\)/i);
	if (restarts) {
		const count = parseInt(restarts[1], 10);
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
	if (/imagepullbackoff|errimagepull|failed to pull image|back-?off pulling image/i.test(m)) {
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
			title: 'Health check failing: restarting',
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
		if (
			/unbound immediate persistentvolumeclaim|persistentvolumeclaim .* (?:not found|is being deleted)/i.test(
				m
			)
		) {
			return {
				title: 'Waiting for storage',
				hint: "The pod is waiting on a volume that hasn't been created or bound yet. This usually clears on its own once the volume is ready.",
				severity: 'warning'
			};
		}
		if (/volume node affinity conflict/i.test(m)) {
			return {
				title: 'Volume is on another node',
				hint: "The pod can only run on the node holding its volume, and that node can't take it. Free capacity there, or recreate the volume.",
				severity: 'error'
			};
		}
		if (/insufficient cpu|insufficient memory/i.test(m)) {
			return {
				title: 'No available nodes',
				hint: 'No node has enough free CPU or memory to run this pod. Try reducing resource requests or wait for capacity.',
				severity: 'error',
				action: 'Check resources'
			};
		}
		if (/taint|toleration|node selector|nodeselector|node affinity/i.test(m)) {
			return {
				title: 'No node matches the scheduling rules',
				hint: 'Node selectors or taints are excluding every node. Check the node pool this deployment is pinned to.',
				severity: 'error'
			};
		}
		return {
			title: "Couldn't place the pod on a node",
			hint: "Kubernetes keeps retrying. The event text below says which constraint it couldn't satisfy.",
			severity: 'error'
		};
	}
	if (/multi-attach error/i.test(m)) {
		return {
			title: 'Volume still attached elsewhere',
			hint: "The volume can only be mounted by one pod at a time and the previous pod hasn't released it yet. It usually clears within a minute.",
			severity: 'warning'
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
			hint: 'The container is taking an unusually long time to start. This can be a slow image pull or volume mount.',
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

	// Warning: degraded but not broken

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
			hint: "A higher-priority workload needed this pod's resources. Kubernetes moves it automatically.",
			severity: 'warning'
		};
	}
	if (/insufficient cpu/i.test(m)) {
		return {
			title: 'Not enough CPU available',
			hint: 'No node has enough CPU to run this pod. Try lowering the CPU request.',
			severity: 'warning',
			action: 'Check resources'
		};
	}
	if (/insufficient memory/i.test(m)) {
		return {
			title: 'Not enough memory available',
			hint: 'No node has enough memory to run this pod. Try lowering the memory request.',
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
			hint: "The pod's network interface isn't configured yet. This usually clears once the node finishes starting.",
			severity: 'warning'
		};
	}

	// Info: transient or expected

	if (/pulling image/i.test(m)) {
		return {
			title: 'Pulling container image',
			hint: 'Downloading the container image. First pulls take longer.',
			severity: 'info'
		};
	}
	if (/successfully pulled/i.test(m)) {
		return {
			title: 'Image pulled',
			hint: 'The container image was downloaded and is ready to start.',
			severity: 'info'
		};
	}
	if (/created container|started container/i.test(m)) {
		return {
			title: 'Container starting',
			hint: 'The container is starting.',
			severity: 'info'
		};
	}
	if (/killing.*container.*with.*signal/i.test(m) || /stopping container/i.test(m)) {
		return {
			title: 'Container shutting down',
			hint: 'The container is stopping. This is normal during deploys and restarts.',
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
export { podLabel } from './log-lines';

/** Parse raw .env text into key-value pairs */
export function rawToEnvVars(raw: string): { key: string; value: string }[] {
	const lines = raw.split('\n');
	const parsed: { key: string; value: string }[] = [];
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
export function envVarsToRaw(vars: { key: string; value: string }[]): string {
	return vars
		.filter((e) => e.key.trim())
		.map((e) => `${e.key}=${e.value}`)
		.join('\n');
}

export function envBadgeColor(slug: string): string {
	const s = (slug || '').toLowerCase();
	if (s.startsWith('prod')) return 'var(--hue-emerald)';
	if (s.startsWith('stag')) return 'var(--hue-amber)';
	if (s.startsWith('dev')) return 'var(--hue-blue)';
	if (s.startsWith('test') || s.startsWith('qa')) return 'var(--hue-violet)';
	return 'var(--hue-slate)';
}

export function envDotColor(slug: string): string {
	const s = (slug || '').toLowerCase();
	if (s.startsWith('prod')) return 'var(--green-7)';
	if (s.startsWith('stag')) return 'var(--amber-7)';
	if (s.startsWith('dev')) return 'var(--blue-7)';
	if (s.startsWith('test') || s.startsWith('qa')) return 'var(--accent-7)';
	return 'var(--neutral-7)';
}
