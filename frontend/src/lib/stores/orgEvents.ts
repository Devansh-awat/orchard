import { browser } from '$app/environment';
import { invalidate } from '$app/navigation';
import type { QueryClient } from '@tanstack/svelte-query';
import { get } from 'svelte/store';
import { apiBase } from './api';

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

interface Subscription {
	source: EventSource;
	listeners: Set<(ev: OrgEvent) => void>;
	queryClient?: QueryClient;
	orgId: string;
	dependencies: Set<string>;
}

const subscriptions = new Map<string, Subscription>();

function applyEventToCache(sub: Subscription, ev: OrgEvent) {
	if (!sub.queryClient) return;
	if (ev.type === 'heartbeat' || ev.type === 'deployment.metrics') return;
	const qc = sub.queryClient;
	switch (ev.type) {
		case 'deployment.changed':
		case 'build.changed':
		case 'database.changed':
		case 'project.changed':
		case 'pod.changed':
			qc.invalidateQueries({ queryKey: ['org', sub.orgId, 'overview'] });
			if (ev.id) qc.invalidateQueries({ queryKey: ['deployment', ev.id] });
			if (ev.projectId) qc.invalidateQueries({ queryKey: ['project', ev.projectId] });
			break;
		case 'membership.changed':
			qc.invalidateQueries({ queryKey: ['org', sub.orgId] });
			break;
	}
}

function applyEventToLoaders(sub: Subscription, ev: OrgEvent) {
	// Metrics events are high-frequency and consumed directly by listeners; skip
	// loader invalidation for them so we don't re-run +page.ts loaders every 10s.
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
	// Diagnostic kill-switch: ?nosse in the URL disables SSE entirely so we
	// can confirm whether SSE is what's freezing the tab.
	if (typeof location !== 'undefined' && location.search.includes('nosse')) {
		return () => {};
	}

	let sub = subscriptions.get(orgId);
	if (!sub) {
		const base = get(apiBase) ?? '';
		const source = new EventSource(`${base}/apiv1/events/orgs/${orgId}`, { withCredentials: true });
		sub = {
			source,
			listeners: new Set(),
			queryClient: opts?.queryClient,
			orgId,
			dependencies: new Set(opts?.invalidateDependencies ?? []),
		};
		source.onmessage = (e) => {
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
			// Browser auto-reconnects; nothing to do.
		};
		subscriptions.set(orgId, sub);
	} else {
		if (opts?.queryClient && !sub.queryClient) sub.queryClient = opts.queryClient;
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
			subscriptions.delete(orgId);
		}
	};
}
