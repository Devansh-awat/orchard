export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export type SeverityTone = 'error' | 'warning' | 'neutral';

export interface SeverityMeta {
	severity: Severity;
	label: string;
	tone: SeverityTone;
	level: 0 | 1 | 2 | 3 | 4;
}

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

const META: Record<Severity, SeverityMeta> = {
	critical: { severity: 'critical', label: 'Critical', tone: 'error', level: 4 },
	high: { severity: 'high', label: 'High', tone: 'error', level: 3 },
	medium: { severity: 'medium', label: 'Medium', tone: 'warning', level: 2 },
	low: { severity: 'low', label: 'Low', tone: 'neutral', level: 1 },
	unknown: { severity: 'unknown', label: 'Unknown', tone: 'neutral', level: 0 }
};

export function severityMeta(raw: string | null | undefined): SeverityMeta {
	const key = String(raw ?? '').toLowerCase();
	return key in META ? META[key as Severity] : META.unknown;
}

export function severityRank(raw: string | null | undefined): number {
	return 4 - severityMeta(raw).level;
}
