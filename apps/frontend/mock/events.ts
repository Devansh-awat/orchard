import type { ServerResponse } from 'node:http';

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
	| 'audit.created';

export interface OrgEvent {
	organizationId: string;
	type: OrgEventType;
	id?: string;
	projectId?: string;
	payload?: unknown;
	ts: number;
}

interface Entry {
	id: string;
	event: OrgEvent;
}

const HISTORY = 500;
const HEARTBEAT_MS = 15_000;

export function openStream(res: ServerResponse) {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		'x-accel-buffering': 'no'
	});
	res.flushHeaders?.();
	res.write(': mock stream open\n\n');
}

export function writeMessage(res: ServerResponse, data: unknown, id?: string, event?: string) {
	let frame = '';
	if (id) frame += `id: ${id}\n`;
	if (event) frame += `event: ${event}\n`;
	frame += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
	res.write(frame);
}

export class EventHub {
	private seq = 0;
	private history: Entry[] = [];
	private subscribers = new Map<string, Set<ServerResponse>>();

	emit(event: Omit<OrgEvent, 'ts'>) {
		const entry: Entry = {
			id: `${Date.now()}-${++this.seq}`,
			event: { ...event, ts: Date.now() }
		};
		this.history.push(entry);
		if (this.history.length > HISTORY) this.history.shift();
		for (const res of this.subscribers.get(event.organizationId) ?? []) {
			writeMessage(res, entry.event, entry.id);
		}
	}

	subscribe(orgId: string, res: ServerResponse, lastEventId: string | null) {
		openStream(res);
		if (lastEventId) {
			const at = this.history.findIndex((e) => e.id === lastEventId);
			if (at >= 0) {
				for (const entry of this.history.slice(at + 1)) {
					if (entry.event.organizationId === orgId) writeMessage(res, entry.event, entry.id);
				}
			}
		}
		let set = this.subscribers.get(orgId);
		if (!set) {
			set = new Set();
			this.subscribers.set(orgId, set);
		}
		set.add(res);
		const heartbeat = setInterval(() => {
			writeMessage(res, { type: 'heartbeat', ts: Date.now() });
		}, HEARTBEAT_MS);
		res.on('close', () => {
			clearInterval(heartbeat);
			set.delete(res);
		});
	}

	watching(orgId: string) {
		return (this.subscribers.get(orgId)?.size ?? 0) > 0;
	}
}
