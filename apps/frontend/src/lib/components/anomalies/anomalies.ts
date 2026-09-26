import { apiFetch } from '$lib/stores';

export type AnomalySeverity = 'critical' | 'error' | 'warning';

export interface Anomaly {
	id: string;
	kind: string;
	severity: AnomalySeverity;
	resource: { kind: 'deployment' | 'database'; id: string; name: string };
	title: string;
	detail: string;
	since: string | null;
	href: string;
	action: { label: string; href: string } | null;
}

export type AnomalyScope = { kind: 'project' | 'deployment' | 'database'; id: string };

export async function fetchAnomalies(scope: AnomalyScope): Promise<Anomaly[]> {
	const base =
		scope.kind === 'project'
			? 'projects'
			: scope.kind === 'deployment'
				? 'deployments'
				: 'databases';
	const res = await apiFetch(`/apiv1/${base}/${encodeURIComponent(scope.id)}/anomalies`);
	if (!res.ok) throw new Error(`anomalies ${res.status}`);
	const body = (await res.json()) as { anomalies?: Anomaly[] };
	return body.anomalies ?? [];
}

export function anomalyAge(since: string | null, now = Date.now()): string | null {
	if (!since) return null;
	const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}
