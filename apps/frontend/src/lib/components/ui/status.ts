import { CircleCheck, CircleDashed, CircleX, Info, Loader2, TriangleAlert } from 'lucide-svelte';
import type { RunStatus } from '$lib/types/jobs';

export type StatusKind = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'progress';

export interface StatusMeta {
	kind: StatusKind;
	label: string;
	icon: typeof CircleCheck;
	pulse?: boolean;
}

const KIND_ICONS: Record<StatusKind, typeof CircleCheck> = {
	success: CircleCheck,
	warning: TriangleAlert,
	error: CircleX,
	info: Info,
	neutral: CircleDashed,
	progress: Loader2
};

export function statusMeta(kind: StatusKind, label: string, pulse = false): StatusMeta {
	return { kind, label, icon: KIND_ICONS[kind], pulse };
}

const meta = statusMeta;

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function resourceStatus(status?: string, buildStatus?: string): StatusMeta {
	const bs = buildStatus?.toLowerCase();
	if (bs === 'building' || bs === 'pending') return meta('progress', 'Building', true);
	const s = status?.toLowerCase();
	if (!s) return meta('neutral', 'Unknown');
	switch (s) {
		case 'running':
		case 'ready':
		case 'active':
		case 'succeeded':
			return meta('success', capitalize(s));
		case 'pending':
		case 'scaling':
		case 'restarting':
		case 'scheduled':
		case 'starting':
		case 'deploying':
		case 'updating':
		case 'building':
		case 'creating':
		case 'provisioning':
		case 'restoring':
		case 'upgrading':
			return meta('progress', capitalize(s), true);
		case 'unhealthy':
			return meta('warning', 'Unhealthy');
		case 'stopped':
			return meta('neutral', 'Stopped');
		case 'failed':
		case 'error':
		case 'crashing':
			return meta('error', capitalize(s));
		case 'deleting':
			return meta('error', 'Deleting', true);
		default:
			return meta('neutral', capitalize(s));
	}
}

export function buildStatusMeta(buildStatus?: string): StatusMeta {
	switch (buildStatus?.toLowerCase()) {
		case 'succeeded':
			return meta('success', 'Succeeded');
		case 'building':
			return meta('progress', 'Building', true);
		case 'failed':
			return meta('error', 'Failed');
		case 'canceled':
			return meta('neutral', 'Canceled');
		default:
			return meta('neutral', buildStatus ? capitalize(buildStatus) : 'Unknown');
	}
}

export type BuildRunStatus =
	| 'scheduled'
	| 'building'
	| 'succeeded'
	| 'failed'
	| 'skipped'
	| 'canceled';

export function buildRunStatus(status: string): StatusMeta {
	switch (status) {
		case 'building':
			return meta('progress', 'Building', true);
		case 'succeeded':
			return meta('success', 'Succeeded');
		case 'failed':
			return meta('error', 'Failed');
		case 'skipped':
			return meta('neutral', 'Skipped');
		case 'canceled':
			return meta('neutral', 'Canceled');
		case 'scheduled':
		default:
			return meta('info', 'Scheduled');
	}
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
	pending: 'Queued',
	running: 'Running',
	succeeded: 'Succeeded',
	failed: 'Failed',
	canceled: 'Canceled',
	skipped: 'Skipped',
	timed_out: 'Timed out'
};

export function runStatus(status: RunStatus): StatusMeta {
	switch (status) {
		case 'succeeded':
			return meta('success', RUN_STATUS_LABELS[status]);
		case 'failed':
		case 'timed_out':
			return meta('error', RUN_STATUS_LABELS[status]);
		case 'running':
			return meta('progress', RUN_STATUS_LABELS[status], true);
		case 'canceled':
			return meta('neutral', RUN_STATUS_LABELS[status], false);
		default:
			return meta('neutral', RUN_STATUS_LABELS[status] ?? capitalize(status));
	}
}

export type PreviewDeployStatus =
	| 'building'
	| 'deploying'
	| 'ready'
	| 'failed'
	| 'stopped'
	| 'gone';

export function previewStatus(status: PreviewDeployStatus | null | undefined): StatusMeta {
	switch (status) {
		case 'building':
			return meta('progress', 'Building', true);
		case 'deploying':
			return meta('progress', 'Deploying', true);
		case 'ready':
			return meta('success', 'Live');
		case 'failed':
			return meta('error', 'Failed');
		case 'stopped':
			return meta('neutral', 'Stopped');
		case 'gone':
			return meta('neutral', 'Removed');
		default:
			return meta('neutral', 'Pending');
	}
}

export function podStatus(phase?: string): StatusMeta {
	const p = phase?.toLowerCase();
	if (!p) return meta('neutral', 'Unknown');
	switch (p) {
		case 'running':
		case 'ready':
			return meta('success', capitalize(p));
		case 'starting':
			return meta('progress', 'Starting', true);
		case 'pending':
		case 'scheduled':
			return meta('progress', capitalize(p), true);
		case 'succeeded':
			return meta('success', 'Succeeded');
		case 'failed':
		case 'error':
		case 'crashing':
			return meta('error', capitalize(p));
		case 'terminating':
			return meta('error', 'Terminating', true);
		default:
			return meta('neutral', capitalize(p));
	}
}

export type ScanState =
	| 'clean'
	| 'vulnerable'
	| 'scanning'
	| 'not_scanned'
	| 'failed'
	| 'unsupported'
	| 'off'
	| 'error';

export function scanStatus(state: ScanState, worst?: string | null): StatusMeta {
	switch (state) {
		case 'clean':
			return meta('success', 'No known vulnerabilities');
		case 'vulnerable':
			return worst === 'critical' || worst === 'high'
				? meta('error', 'Vulnerable')
				: meta('warning', 'Vulnerable');
		case 'scanning':
			return meta('progress', 'Scanning', true);
		case 'failed':
			return meta('error', 'Scan failed');
		case 'error':
			return meta('warning', 'Scanner unavailable');
		case 'off':
			return meta('neutral', 'Scanning off');
		case 'unsupported':
		case 'not_scanned':
		default:
			return meta('neutral', 'Not scanned');
	}
}

export function httpStatus(code: number): StatusMeta {
	const kind: StatusKind =
		code >= 500
			? 'error'
			: code >= 400
				? 'warning'
				: code >= 300
					? 'info'
					: code >= 200
						? 'success'
						: 'neutral';
	return statusMeta(kind, code ? String(code) : 'No response');
}
