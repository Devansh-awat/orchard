import { get, writable, derived, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { apiBase } from './api';
import { queryClient } from '../query';

export type OrgEventType =
	| 'deployment.changed'
	| 'database.changed'
	| 'build.changed'
	| 'project.changed'
	| 'pod.changed'
	| 'membership.changed'
	| 'deployment.metrics'
	| 'job.changed'
	| 'jobrun.changed'
	| 'environment.changed'
	| 'sharedvars.changed'
	| 'engine.changed'
	| 'heartbeat';

export interface OrgEvent {
	type: OrgEventType;
	id?: string;
	projectId?: string;
	organizationId?: string;
	payload?: any;
	ts: number;
}

export type SseStatus = 'connecting' | 'connected' | 'disconnected';

interface Subscription {
	source: EventSource | null;
	listeners: Set<(ev: OrgEvent) => void>;
	orgId: string;
	status: SseStatus;
	lastEventAt: number;
	lastEventId: string | null;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectAttempts: number;
}

const subscriptions = new Map<string, Subscription>();

// Reactive per-org SSE connection status. Components can subscribe to
// `sseStatusFor(orgId)` to render a "live"/"stale" indicator without poking
// at the internal Map.
const statusStore = writable<Record<string, SseStatus>>({});

export const sseStatus: Readable<Record<string, SseStatus>> = { subscribe: statusStore.subscribe };

export function sseStatusFor(orgId: string): Readable<SseStatus> {
	return derived(statusStore, ($s) => $s[orgId] ?? 'connecting');
}

function setStatus(orgId: string, next: SseStatus) {
	statusStore.update((s) => (s[orgId] === next ? s : { ...s, [orgId]: next }));
	const sub = subscriptions.get(orgId);
	if (sub) sub.status = next;
}

// If we don't see any event (data or heartbeat) for this long, treat the
// stream as dead even if the EventSource hasn't fired onerror — proxies
// sometimes wedge silently. The server sends heartbeats every 25s.
const STALE_THRESHOLD_MS = 60_000;

// Manual reconnect backoff. EventSource only auto-retries while CONNECTING;
// once it reaches CLOSED (e.g. a proxy returned an HTTP error) it is dead for
// good, so we have to recreate it ourselves.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function applyEventToCache(sub: Subscription, ev: OrgEvent) {
	if (ev.type === 'heartbeat' || ev.type === 'deployment.metrics') return;
	const qc = queryClient;
	switch (ev.type) {
		case 'deployment.changed':
		case 'build.changed':
		case 'database.changed':
		case 'project.changed':
			// (the overview page invalidates its own ['overview', slug] query,
			// debounced — no query uses an ['org', id, 'overview'] key)
			qc.invalidateQueries({ queryKey: ['projects', sub.orgId] });
			if (ev.id) qc.invalidateQueries({ queryKey: ['deployment', ev.id] });
			break;
		case 'pod.changed':
		case 'membership.changed':
			qc.invalidateQueries({ queryKey: ['projects', sub.orgId] });
			break;
		case 'job.changed':
			qc.invalidateQueries({ queryKey: ['jobs', sub.orgId] });
			if (ev.id) qc.invalidateQueries({ queryKey: ['job', ev.id] });
			break;
		case 'jobrun.changed': {
			qc.invalidateQueries({ queryKey: ['jobs', sub.orgId] });
			const jobId = ev.payload?.jobId;
			if (jobId) {
				qc.invalidateQueries({ queryKey: ['job', jobId] });
				qc.invalidateQueries({ queryKey: ['job-runs', jobId] });
			}
			if (ev.id) qc.invalidateQueries({ queryKey: ['job-run', ev.id] });
			break;
		}
		case 'environment.changed':
			if (ev.projectId) qc.invalidateQueries({ queryKey: ['environments', ev.projectId] });
			qc.invalidateQueries({ queryKey: ['projects', sub.orgId] });
			break;
		case 'sharedvars.changed':
			if (ev.id) qc.invalidateQueries({ queryKey: ['shared-vars', ev.id] });
			break;
		case 'engine.changed':
			qc.invalidateQueries({ queryKey: ['engine-health'] });
			break;
		default:
			break;
	}
}

function scheduleReconnect(sub: Subscription) {
	// Subscription was torn down (last listener left) — don't resurrect it.
	if (subscriptions.get(sub.orgId) !== sub) return;
	if (sub.reconnectTimer) return;
	const delay = Math.min(
		RECONNECT_MAX_MS,
		RECONNECT_BASE_MS * 2 ** Math.min(sub.reconnectAttempts, 5)
	);
	sub.reconnectAttempts += 1;
	sub.reconnectTimer = setTimeout(() => {
		sub.reconnectTimer = null;
		if (subscriptions.get(sub.orgId) !== sub) return;
		setStatus(sub.orgId, 'connecting');
		connect(sub);
	}, delay);
}

function connect(sub: Subscription) {
	const base = get(apiBase) ?? '';
	// Encode orgId so a value containing path-special chars can't escape
	// the route segment (defense-in-depth — orgIds are server-issued UUIDs
	// today, but the boundary is the safer place to enforce it).
	const resume = sub.lastEventId ? `?lastEventId=${encodeURIComponent(sub.lastEventId)}` : '';
	const source = new EventSource(
		`${base}/apiv1/events/orgs/${encodeURIComponent(sub.orgId)}${resume}`,
		{ withCredentials: true }
	);
	sub.source = source;
	source.onopen = () => {
		sub.lastEventAt = Date.now();
		sub.reconnectAttempts = 0;
		setStatus(sub.orgId, 'connected');
	};
	source.onmessage = (e) => {
		sub.lastEventAt = Date.now();
		sub.reconnectAttempts = 0;
		if (e.lastEventId) sub.lastEventId = e.lastEventId;
		if (sub.status !== 'connected') setStatus(sub.orgId, 'connected');
		let ev: OrgEvent;
		try {
			ev = JSON.parse(e.data);
		} catch {
			return;
		}
		applyEventToCache(sub, ev);
		for (const l of sub.listeners) l(ev);
	};
	source.onerror = () => {
		if (source.readyState === EventSource.CLOSED) {
			// EventSource never recovers from CLOSED on its own — recreate it
			// with backoff. Until then the UI shows the stale-data warning.
			setStatus(sub.orgId, 'disconnected');
			sub.source = null;
			scheduleReconnect(sub);
		} else {
			// CONNECTING — the browser is auto-retrying; just surface the gap.
			setStatus(sub.orgId, 'connecting');
		}
	};
}

/**
 * Subscribe to server-sent events for an organization. Multiple callers for the
 * same orgId share one EventSource.
 */
export function subscribeOrgEvents(orgId: string, listener: (ev: OrgEvent) => void): () => void {
	if (!browser) return () => {};
	if (typeof window.location !== 'undefined' && window.location.search.includes('nosse')) {
		return () => {};
	}

	let sub = subscriptions.get(orgId);
	if (!sub) {
		setStatus(orgId, 'connecting');
		sub = {
			source: null,
			listeners: new Set(),
			orgId,
			status: 'connecting',
			lastEventAt: Date.now(),
			lastEventId: null,
			heartbeatTimer: null,
			reconnectTimer: null,
			reconnectAttempts: 0
		};
		connect(sub);
		// Stale-detection: if heartbeats stop landing (proxies can wedge a
		// stream without erroring), tear the connection down and reconnect.
		sub.heartbeatTimer = setInterval(() => {
			if (!sub) return;
			if (Date.now() - sub.lastEventAt > STALE_THRESHOLD_MS && sub.status === 'connected') {
				setStatus(orgId, 'disconnected');
				sub.source?.close();
				sub.source = null;
				scheduleReconnect(sub);
			}
		}, 10_000);
		subscriptions.set(orgId, sub);
	}

	sub.listeners.add(listener);
	return () => {
		const s = subscriptions.get(orgId);
		if (!s) return;
		s.listeners.delete(listener);
		if (s.listeners.size === 0) {
			s.source?.close();
			s.source = null;
			if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
			if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
			subscriptions.delete(orgId);
			statusStore.update((st) => {
				if (!(orgId in st)) return st;
				const next = { ...st };
				delete next[orgId];
				return next;
			});
		}
	};
}
