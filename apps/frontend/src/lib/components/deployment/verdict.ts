import { statusMeta, type StatusMeta } from '$lib/components/ui/status';

export type VerdictLine = {
	dimension: 'p95' | 'errors' | 'restarts' | 'memory';
	status: 'regressed' | 'improved' | 'unchanged' | 'insufficient' | 'notable';
	text: string;
};

export type ReleaseVerdict = {
	releaseId?: string;
	imageHistoryId?: string | null;
	at?: string;
	status: 'regressed' | 'improved' | 'unchanged' | 'insufficient';
	summary: string;
	version?: string;
	lines: VerdictLine[];
	newErrorGroups?: number;
	after?: { from: number; to: number };
};

const DIMENSION_PANELS: Record<VerdictLine['dimension'], string> = {
	p95: 'panel-response-time',
	errors: 'panel-error-rate',
	restarts: 'panel-restarts-and-out-of-memory-kills',
	memory: 'panel-memory'
};

export function verdictMoment(v: ReleaseVerdict): { at: number; panel: string | null } | null {
	const at = v.after?.from ?? (v.at ? Date.parse(v.at) : NaN);
	if (!Number.isFinite(at)) return null;
	const line =
		v.lines.find((l) => l.status === 'regressed') ?? v.lines.find((l) => l.status === 'improved');
	return { at, panel: line ? DIMENSION_PANELS[line.dimension] : null };
}

const REGRESSED: Record<VerdictLine['dimension'], string> = {
	p95: 'Slower',
	errors: 'More errors',
	restarts: 'Restarting',
	memory: 'More memory'
};

const IMPROVED: Record<VerdictLine['dimension'], string> = {
	p95: 'Faster',
	errors: 'Fewer errors',
	restarts: 'Steadier',
	memory: 'Less memory'
};

export function worthShowing(v: ReleaseVerdict | null | undefined): v is ReleaseVerdict {
	if (!v) return false;
	return (
		v.status === 'regressed' ||
		v.status === 'improved' ||
		v.lines.some((l) => l.status === 'notable')
	);
}

export function verdictBadge(v: ReleaseVerdict): StatusMeta | null {
	const worse = v.lines.find((l) => l.status === 'regressed');
	if (worse) return statusMeta('warning', REGRESSED[worse.dimension]);
	const better = v.lines.find((l) => l.status === 'improved');
	if (better) return statusMeta('success', IMPROVED[better.dimension]);
	return null;
}

export function verdictText(v: ReleaseVerdict): string {
	const prefix = v.version ? `${v.version}: ` : '';
	const text = prefix && v.summary.startsWith(prefix) ? v.summary.slice(prefix.length) : v.summary;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function headerVerdict(v: ReleaseVerdict | null | undefined, now: number): string | null {
	if (!v || v.status !== 'regressed' || !v.at) return null;
	if (now - new Date(v.at).getTime() > 24 * 60 * 60_000) return null;
	const worse = v.lines.find((l) => l.status === 'regressed');
	const what = worse ? REGRESSED[worse.dimension] : 'Worse';
	return v.version ? `${what} since ${v.version}` : what;
}
