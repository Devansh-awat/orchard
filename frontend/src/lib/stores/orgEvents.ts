import { browser } from '$app/environment';
import { invalidate } from '$app/navigation';
import type { QueryClient } from '@tanstack/svelte-query';
import { get, writable, derived, type Readable } from 'svelte/store';
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
	source: EventSource;
	listeners: Set<(ev: OrgEvent) => void>;
	orgId: string;
	dependencies: Set<string>;
	status: SseStatus;
	lastEventAt: number;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
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

function applyEventToCache(sub: Subscription, ev: OrgEvent) {
	if (ev.type === 'heartbeat' || ev.type === 'deployment.metrics') return;
	const qc = queryClient;
	switch (ev.type) {
		case 'deployment.changed':
		case 'build.changed':
		case 'database.changed':
		case 'project.changed':
		case 'pod.changed':
			// (the overview page invalidates its own ['overview', slug] query,
			// debounced — no query uses an ['org', id, 'overview'] key)
			qc.invalidateQueries({ queryKey: ['projects', sub.orgId] });
			if (ev.id) qc.invalidateQueries({ queryKey: ['deployment', ev.id] });
			if (ev.projectId) qc.invalidateQueries({ queryKey: ['project', ev.projectId] });
			break;
		case 'membership.changed':
			qc.invalidateQueries({ queryKey: ['org', sub.orgId] });
			qc.invalidateQueries({ queryKey: ['projects', sub.orgId] });
			break;
	}
}

function applyEventToLoaders(sub: Subscription, ev: OrgEvent) {
	if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
	for (const dep of sub.dependencies) invalidate(dep);
}

/**
 * Subscribe to server-sent events for an organization. Multiple callers for the
 * same orgId share one EventSource.
 */
export function subscribeOrgEvents(
	orgId: string,
	listener: (ev: OrgEvent) => void,
	opts?: { queryClient?: QueryClient; invalidateDependencies?: string[] },
): () => void {
	if (!browser) return () => {};
	if (typeof location !== 'undefined' && location.search.includes('nosse')) {
		return () => {};
	}

	let sub = subscriptions.get(orgId);
	if (!sub) {
		const base = get(apiBase) ?? '';
		setStatus(orgId, 'connecting');
		// Encode orgId so a value containing path-special chars can't escape
		// the route segment (defense-in-depth — orgIds are server-issued UUIDs
		// today, but the boundary is the safer place to enforce it).
		const source = new EventSource(
			`${base}/apiv1/events/orgs/${encodeURIComponent(orgId)}`,
			{ withCredentials: true },
		);
		sub = {
			source,
			listeners: new Set(),
			orgId,
			dependencies: new Set(opts?.invalidateDependencies ?? []),
			status: 'connecting',
			lastEventAt: Date.now(),
			heartbeatTimer: null,
		};
		source.onopen = () => {
			sub!.lastEventAt = Date.now();
			setStatus(orgId, 'connected');
		};
		source.onmessage = (e) => {
			sub!.lastEventAt = Date.now();
			if (sub!.status !== 'connected') setStatus(orgId, 'connected');
			let ev: OrgEvent;
			try {
				ev = JSON.parse(e.data);
			} catch {
				return;
			}
			applyEventToCache(sub!, ev);
			applyEventToLoaders(sub!, ev);
			for (const l of sub!.listeners) l(ev);
		};
		source.onerror = () => {
			// EventSource auto-reconnects; surface the gap so the UI can warn that
			// data may be stale until the next message arrives.
			setStatus(orgId, source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting');
		};
		// Stale-detection: if heartbeats stop landing, mark disconnected so
		// adaptive polling on the page can take over.
		sub.heartbeatTimer = setInterval(() => {
			if (!sub) return;
			if (Date.now() - sub.lastEventAt > STALE_THRESHOLD_MS && sub.status === 'connected') {
				setStatus(orgId, 'disconnected');
			}
		}, 10_000);
		subscriptions.set(orgId, sub);
	} else {
		if (opts?.invalidateDependencies) {
			for (const d of opts.invalidateDependencies) sub.dependencies.add(d);
		}
	}

	sub.listeners.add(listener);
	return () => {
		const s = subscriptions.get(orgId);
		if (!s) return;
		s.listeners.delete(listener);
		if (s.listeners.size === 0) {
			s.source.close();
			if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
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
