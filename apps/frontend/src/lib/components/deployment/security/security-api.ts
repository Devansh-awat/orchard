import { apiFetch } from '$lib/stores/api';
import type { Severity } from '$lib/components/ui/severity';
import type { ScanState } from '$lib/components/ui/status';

export type ScanReason =
	| 'external_image'
	| 'no_image'
	| 'not_scannable'
	| 'not_configured'
	| 'not_found'
	| 'unauthorized'
	| 'unreachable';

export type ScanProvider = 'off' | 'harbor' | 'trivy';

export interface Vulnerability {
	id: string;
	package: string;
	version: string;
	fixVersion: string | null;
	severity: Severity;
	description: string | null;
	url: string | null;
	cvss: number | null;
}

export type PostureKind = 'plain-secret' | 'mutable-tag' | 'no-tls';

export interface PostureFinding {
	kind: PostureKind;
	severity: 'high' | 'medium' | 'low';
	subjects: string[];
}

export interface DeploymentSecurity {
	image: {
		ref: string | null;
		source: 'orchard' | 'external' | 'none';
		tag: string | null;
		digest: string | null;
		pushedAt: string | null;
		commitSha: string | null;
		commitMessage: string | null;
		builtAt: string | null;
	};
	scan: {
		state: ScanState;
		reason: ScanReason | null;
		severity: Severity | 'none' | null;
		counts: Record<Severity, number> & { total: number; fixable: number };
		progress: number | null;
		startedAt: string | null;
		finishedAt: string | null;
		scanner: { name: string; version: string | null } | null;
		canRescan: boolean;
		provider: ScanProvider;
		error: string | null;
	};
	vulnerabilities: Vulnerability[] | null;
	truncated: number;
	posture: PostureFinding[];
	checkedAt: string;
}

async function readError(res: Response, fallback: string): Promise<never> {
	const data = await res.json().catch(() => ({}));
	throw new Error((data as { message?: string }).message || fallback);
}

export async function fetchSecurity(deploymentId: string): Promise<DeploymentSecurity> {
	const res = await apiFetch(`/apiv1/deployments/${encodeURIComponent(deploymentId)}/security`);
	if (!res.ok) return readError(res, "Couldn't load the security report");
	return res.json();
}

export async function requestScan(deploymentId: string): Promise<DeploymentSecurity> {
	const res = await apiFetch(
		`/apiv1/deployments/${encodeURIComponent(deploymentId)}/security/scan`,
		{ method: 'POST' }
	);
	if (!res.ok) return readError(res, "Couldn't start a scan");
	return res.json();
}
