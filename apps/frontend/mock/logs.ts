import { sha } from './ids.ts';
import type { MockDeployment } from './types.ts';

const BUCKET_MS = 2_500;

const ROUTES = [
	'GET /',
	'GET /api/projects',
	'GET /api/projects/42',
	'POST /api/votes',
	'GET /healthz',
	'GET /assets/index-4f2a9c1.js',
	'GET /api/leaderboard?limit=50',
	'POST /api/auth/session',
	'GET /favicon.ico',
	'PATCH /api/me'
];

const WORKER = [
	'picked up job sync-scores (attempt 1)',
	'fetched 1284 records from airtable in 812ms',
	'upserted 1284 rows into leaderboard',
	'job sync-scores finished in 2.31s',
	'queue depth 3, 2 workers busy'
];

function rand(seed: string) {
	return parseInt(sha(seed).slice(0, 8), 16) / 0xffffffff;
}

export interface LogLine {
	ts: string;
	pod: string;
	level: 'info' | 'warn' | 'error' | 'debug';
	message: string;
	line: string;
}

function lineAt(d: MockDeployment, pod: string, bucket: number): LogLine {
	const r = rand(`${d.id}:${bucket}`);
	const ts = new Date(bucket * BUCKET_MS + Math.floor(r * 900)).toISOString();
	let level: LogLine['level'] = 'info';
	let message: string;
	if (d.crash) {
		const step = bucket % 6;
		if (step === 5) {
			level = 'error';
			message = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
		} else if (step === 4) {
			level = 'warn';
			message = `heap used ${(230 + r * 20).toFixed(0)}MB of 256MB, gc took ${(180 + r * 300).toFixed(0)}ms`;
		} else {
			message = WORKER[bucket % WORKER.length];
		}
	} else if (!d.host) {
		message = WORKER[bucket % WORKER.length];
		if (r > 0.93) {
			level = 'warn';
			message = 'slack api returned 429, retrying in 2s';
		}
	} else {
		const route = ROUTES[Math.floor(r * ROUTES.length)];
		const slow = r > 0.9;
		const failed = r > 0.97;
		const status = failed ? 500 : route.startsWith('POST') && r > 0.8 ? 201 : 200;
		level = failed ? 'error' : slow ? 'warn' : 'info';
		message = `${route} ${status} ${slow ? (380 + r * 900).toFixed(0) : (4 + r * 60).toFixed(0)}ms`;
		if (failed)
			message +=
				' - PrismaClientKnownRequestError: Unique constraint failed on the fields: (`slug`)';
	}
	const line =
		d.framework === 'rails'
			? `${level.toUpperCase().padEnd(5)} -- : ${message}`
			: `${level.padEnd(5)} ${message}`;
	return { ts, pod, level, message, line };
}

export function tail(d: MockDeployment, pods: string[], count: number, until = Date.now()) {
	if (pods.length === 0) return [];
	const last = Math.floor(until / BUCKET_MS);
	const first = Math.max(last - count + 1, Math.ceil(Date.parse(d.podStartedAt) / BUCKET_MS));
	const out: LogLine[] = [];
	for (let b = first; b <= last; b++) {
		out.push(lineAt(d, pods[Math.abs(b) % pods.length], b));
	}
	return out;
}

export function since(d: MockDeployment, pods: string[], fromMs: number, toMs = Date.now()) {
	if (pods.length === 0) return [];
	const out: LogLine[] = [];
	for (let b = Math.floor(fromMs / BUCKET_MS) + 1; b <= Math.floor(toMs / BUCKET_MS); b++) {
		out.push(lineAt(d, pods[Math.abs(b) % pods.length], b));
	}
	return out;
}

export function structured(l: LogLine) {
	return {
		timestamp: l.ts,
		level: l.level,
		message: l.message,
		lines: [l.message],
		raw: l.line,
		metadata: { pod: l.pod }
	};
}

export { BUCKET_MS };
