const SEED = 0x9e3779b9;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

function series(
	start: number,
	end: number,
	step: number,
	base: number,
	spread: number,
	seed: number,
	opts: { floor?: number; spike?: boolean } = {}
) {
	const r = rng(seed);
	const points: { x: number; y: number }[] = [];
	let value = base;
	const count = Math.max(2, Math.round((end - start) / step));
	for (let i = 0; i <= count; i++) {
		const x = start + i * step;
		const wave = Math.sin(i / 7) * spread * 0.4 + Math.sin(i / 23) * spread * 0.25;
		value = base + wave + (r() - 0.5) * spread * 0.5;
		if (opts.spike && i > count * 0.62 && i < count * 0.72) value += spread * 2.2;
		points.push({ x, y: Math.max(opts.floor ?? 0, +value.toFixed(3)) });
	}
	return points;
}

export function demoHttpMetrics(start: number, end: number, step: number) {
	return {
		requestRate: series(start, end, step, 42, 18, SEED + 1, { floor: 0 }),
		errorRate: series(start, end, step, 0.6, 0.5, SEED + 2, { floor: 0, spike: true }),
		latencyAvg: series(start, end, step, 84, 26, SEED + 3, { floor: 4 }),
		latencyMax: series(start, end, step, 340, 160, SEED + 4, { floor: 20, spike: true })
	};
}

export function demoResourceSeries(start: number, end: number, step: number) {
	return {
		cpu: series(start, end, step, 520, 220, SEED + 11, { floor: 20, spike: true }),
		mem: series(start, end, step, 1840, 260, SEED + 12, { floor: 200 }),
		rx: series(start, end, step, 128, 90, SEED + 13, { floor: 0 }),
		tx: series(start, end, step, 74, 58, SEED + 14, { floor: 0 })
	};
}

const DEMO_PODS = [
	'worker-main-7d9c4b8f5-z2shm',
	'worker-main-7d9c4b8f5-q4x1t',
	'worker-main-7d9c4b8f5-h8m3p'
];

export function demoResourceSeriesByPod(start: number, end: number, step: number) {
	const mk = (base: number, spread: number, seedBase: number, floor: number) =>
		DEMO_PODS.map((key, i) => ({
			key,
			points: series(start, end, step, base * (0.7 + i * 0.3), spread, seedBase + i * 17, {
				floor,
				spike: i === 1
			})
		}));
	return {
		cpu: mk(190, 80, SEED + 31, 10),
		mem: mk(640, 90, SEED + 41, 80),
		rx: mk(46, 32, SEED + 51, 0),
		tx: mk(26, 20, SEED + 61, 0)
	};
}

export function demoOverview() {
	return {
		cpuPercent: 63,
		memoryPercent: 74,
		uptime: new Date(Date.now() - (26 * 3600 + 14 * 60) * 1000).toISOString(),
		httpRequestRate: 41.8,
		httpErrorRate: 0.7,
		httpAvgLatency: 86
	};
}

const STACK_A = `FetchError: request to https://auth.hackclub.com/oauth/token failed
    at ClientRequest.<anonymous> (/app/node_modules/node-fetch/lib/index.js:1501:11)
    at ClientRequest.emit (node:events:531:35)
    at TLSSocket.socketErrorListener (node:_http_client:518:9)
    at TLSSocket.emit (node:events:519:28)
    at emitErrorNT (node:internal/streams/destroy:170:8)`;

const STACK_B = `TypeError: Cannot read properties of undefined (reading 'id')
    at syncHcaIdentity (/app/.output/server/chunks/nitro/nitro.mjs:26503:10)
    at async tick$1 (/app/.output/server/chunks/nitro/nitro.mjs:34376:22)
    at async runTask (/app/.output/server/chunks/nitro/nitro.mjs:8585:15)`;

const STACK_C = `Error: connect ETIMEDOUT 10.42.0.19:5432
    at Socket.<anonymous> (/app/node_modules/pg/lib/connection.js:64:14)
    at Object.onceWrapper (node:events:634:26)
    at Socket.emit (node:events:519:28)`;

export function demoErrors(windowMinutes: number) {
	const now = Date.now();
	const span = windowMinutes * 60_000;
	return [
		{
			fingerprint: '4cb17be8f2a94d01',
			type: 'FetchError',
			message:
				'[hca/sync] refreshAccessToken failed 7b234076-95ed-4715-9659-39d307dc000d FetchError: [POST] "https://auth.hackclub.com/oauth/token": 400 Bad Request',
			count: 34,
			firstSeen: new Date(now - span * 0.94).toISOString(),
			lastSeen: new Date(now - 62_000).toISOString(),
			samples: [
				{ timestamp: new Date(now - 62_000).toISOString(), stackTrace: STACK_A },
				{ timestamp: new Date(now - 540_000).toISOString(), stackTrace: STACK_A }
			]
		},
		{
			fingerprint: '5ad3d9bb7c104e22',
			type: 'TypeError',
			message: "[cron-streak-reminder] Cannot read properties of undefined (reading 'id')",
			count: 9,
			firstSeen: new Date(now - span * 0.71).toISOString(),
			lastSeen: new Date(now - 240_000).toISOString(),
			samples: [{ timestamp: new Date(now - 900_000).toISOString(), stackTrace: STACK_B }]
		},
		{
			fingerprint: '3ac64c6d18f0aa73',
			type: 'DatabaseError',
			message: '[pg] connect ETIMEDOUT 10.42.0.19:5432 while acquiring pool client',
			count: 3,
			firstSeen: new Date(now - span * 0.38).toISOString(),
			lastSeen: new Date(now - span * 0.12).toISOString(),
			samples: [{ timestamp: new Date(now - span * 0.12).toISOString(), stackTrace: STACK_C }]
		}
	];
}

export function demoKilled() {
	const now = Date.now();
	const h = (n: number) => new Date(now - n * 3600_000).toISOString();
	return [
		{
			entryId: 'demo-killed-1',
			pod: 'worker-main-7d9c4b8f5-z2shm',
			container: 'worker-main',
			reason: 'OOMKilled',
			exitCode: 137,
			finishedAt: h(0.4),
			capturedAt: h(0.4)
		},
		{
			entryId: 'demo-killed-2',
			pod: 'worker-main-7d9c4b8f5-q4x1t',
			container: 'worker-main',
			reason: 'Error',
			exitCode: 1,
			finishedAt: h(2.1),
			capturedAt: h(2.1)
		},
		{
			entryId: 'demo-killed-3',
			pod: 'worker-main-6c81f0a24-h8m3p',
			container: 'worker-main',
			reason: 'Error',
			exitCode: 255,
			finishedAt: h(5.6),
			capturedAt: h(5.6)
		},
		{
			entryId: 'demo-killed-4',
			pod: 'worker-main-6c81f0a24-t7k2w',
			container: 'migrations',
			reason: 'Error',
			exitCode: 127,
			finishedAt: h(9.2),
			capturedAt: h(9.2)
		},
		{
			entryId: 'demo-killed-5',
			pod: 'worker-main-6c81f0a24-b4n9d',
			container: 'worker-main',
			reason: 'Error',
			exitCode: 139,
			finishedAt: h(14.8),
			capturedAt: h(14.8)
		},
		{
			entryId: 'demo-killed-6',
			pod: 'worker-main-5f3ba917e-x1c8p',
			container: 'worker-main',
			reason: 'Completed',
			exitCode: 143,
			finishedAt: h(21.5),
			capturedAt: h(21.5)
		}
	];
}

export const DEMO_KILLED_LOGS: Record<string, string> = {
	'demo-killed-1': `[entrypoint] starting nitro server
Listening on http://0.0.0.0:3000
[streaks] heartbeat fetch truncated at the 50000-beat cap for hackatime_id=57287
[streaks] rebuilding leaderboard for 12841 users
<--- Last few GCs --->
[31:0x7f2c] 41822 ms: Mark-Compact 2043.1 (2077.5) -> 2042.4 (2078.2) MB, 1821.4 / 0.0 ms
[31:0x7f2c] 43910 ms: Mark-Compact 2044.8 (2078.2) -> 2044.1 (2078.9) MB, 2020.7 / 0.0 ms
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`,

	'demo-killed-2': `[entrypoint] starting nitro server
[config] loaded 47 environment variables
Error: Redis connection to redis-master.orchard-cache:6379 failed - connect ECONNREFUSED
    at Socket.<anonymous> (/app/node_modules/ioredis/built/Redis.js:170:41)
    at Object.onceWrapper (node:events:634:26)
    at Socket.emit (node:events:519:28)
[entrypoint] fatal during boot, exiting`,

	'demo-killed-3': `[entrypoint] running drizzle-kit migrate (max 120s)
No config path provided, using default 'drizzle.config.ts'
Reading config file '/app/drizzle.config.ts'
error: connect ETIMEDOUT 10.42.0.19:5432
[entrypoint] migration step failed, aborting boot`,

	'demo-killed-4': `/app/entrypoint.sh: line 12: drizzle-kit: command not found
[entrypoint] migration step failed, aborting boot`,

	'demo-killed-5': `[entrypoint] starting nitro server
Listening on http://0.0.0.0:3000
[image] decoding avatar batch (312 images)

PID 31 received SIGSEGV, faulting address 0x0
/app/node_modules/sharp/build/Release/sharp-linux-x64.node(+0x1c4f1)[0x7f9c2a41c4f1]
/lib/x86_64-linux-gnu/libc.so.6(+0x3c050)[0x7f9c2be3c050]`,

	'demo-killed-6': `[entrypoint] starting nitro server
Listening on http://0.0.0.0:3000
[cron-fraud] scheduled run: scanned=100 approved=0 rejected=0
[signal] received SIGTERM, draining connections
[signal] 4 in-flight requests completed
[entrypoint] shutdown complete`
};
