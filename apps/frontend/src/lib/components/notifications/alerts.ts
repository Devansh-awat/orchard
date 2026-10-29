import { apiFetch } from '$lib/stores';
import type { NotificationScopeType } from './types';

export type AlertMetricId =
	| 'cpu_percent'
	| 'memory_percent'
	| 'request_rate'
	| 'error_rate'
	| 'latency_avg_ms'
	| 'latency_max_ms'
	| 'cpu_throttled_percent'
	| 'memory_forecast_hours';

export type AlertComparator = 'gt' | 'lt';

export interface AlertMetric {
	id: AlertMetricId;
	label: string;
	unit: '%' | 'req/s' | 'ms' | 'h';
	comparators: AlertComparator[];
	needsIngress: boolean;
	requestRateGuard: boolean;
	defaultThreshold: number;
	defaultForSeconds: number;
	maxThreshold: number | null;
}

export interface AlertRule {
	id: string;
	scopeType: NotificationScopeType;
	scopeId: string | null;
	metric: AlertMetricId;
	comparator: AlertComparator;
	threshold: number;
	forSeconds: number;
	minRequestRate: number | null;
	enabled: boolean;
	inherited: boolean;
	description: string;
	activeEpisodes: number;
	createdAt: string;
}

export type AlertStatus = 'ok' | 'pending' | 'firing' | 'recovering' | 'unknown' | 'off';

export interface AlertState {
	ruleId: string;
	metric: AlertMetricId;
	label: string;
	inherited: boolean;
	status: AlertStatus;
	value: number | null;
	valueLabel: string | null;
	since: string | null;
	notifiedAt: string | null;
	lastEvaluatedAt: string | null;
}

export interface AlertRulePayload {
	scopeType: NotificationScopeType;
	scopeId: string | null;
	metric: AlertMetricId;
	comparator: AlertComparator;
	threshold: number;
	forSeconds: number;
	minRequestRate?: number | null;
}

async function json<T>(res: Response, fallback: string): Promise<T> {
	const body = await res.json().catch(() => ({}) as any);
	if (!res.ok) throw new Error(body?.message || body?.error || fallback);
	return body as T;
}

const base = (organizationId: string) => `/apiv1/organizations/${organizationId}/metric-alerts`;

export async function fetchAlertCatalogue(organizationId: string): Promise<AlertMetric[]> {
	const res = await apiFetch(`${base(organizationId)}/catalogue`);
	return json(res, 'Could not load the alert metrics');
}

export async function fetchAlertRules(
	organizationId: string,
	scopeType: NotificationScopeType,
	scopeId: string | null
): Promise<AlertRule[]> {
	const params = new URLSearchParams({ scopeType });
	if (scopeId) params.set('scopeId', scopeId);
	const res = await apiFetch(`${base(organizationId)}?${params}`);
	return json(res, 'Could not load alert rules');
}

export async function fetchAlertStates(
	organizationId: string,
	deploymentId: string
): Promise<AlertState[]> {
	const params = new URLSearchParams({ deploymentId });
	const res = await apiFetch(`${base(organizationId)}/states?${params}`);
	return json(res, 'Could not load alert states');
}

export async function createAlertRule(
	organizationId: string,
	payload: AlertRulePayload
): Promise<AlertRule> {
	const res = await apiFetch(base(organizationId), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return json(res, 'Could not create the alert');
}

export async function updateAlertRule(
	organizationId: string,
	ruleId: string,
	patch: Partial<AlertRulePayload> & { enabled?: boolean }
): Promise<AlertRule> {
	const res = await apiFetch(`${base(organizationId)}/${ruleId}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patch)
	});
	return json(res, 'Could not update the alert');
}

export async function deleteAlertRule(organizationId: string, ruleId: string): Promise<void> {
	const res = await apiFetch(`${base(organizationId)}/${ruleId}`, { method: 'DELETE' });
	if (!res.ok) await json(res, 'Could not delete the alert');
}

export function formatAlertValue(unit: AlertMetric['unit'], value: number): string {
	const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return unit === 'req/s' ? `${rounded} req/s` : `${rounded}${unit}`;
}

export function windowLabel(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600} h`;
	if (seconds % 60 === 0) return `${seconds / 60} min`;
	return `${seconds}s`;
}

export const WINDOW_OPTIONS = [60, 120, 300, 600, 900, 1800, 3600] as const;

export function statusTone(
	status: AlertStatus
): 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'progress' {
	switch (status) {
		case 'firing':
			return 'error';
		case 'pending':
			return 'warning';
		case 'recovering':
			return 'progress';
		case 'unknown':
			return 'neutral';
		case 'off':
			return 'neutral';
		default:
			return 'success';
	}
}

export function statusLabel(status: AlertStatus): string {
	switch (status) {
		case 'firing':
			return 'Firing';
		case 'pending':
			return 'Over threshold';
		case 'recovering':
			return 'Recovering';
		case 'unknown':
			return 'No data';
		case 'off':
			return 'Off';
		default:
			return 'OK';
	}
}
