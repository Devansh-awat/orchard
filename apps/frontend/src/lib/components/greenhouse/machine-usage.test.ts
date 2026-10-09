import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, minutesLabel, usageView, type MachineUsage } from './machine-usage';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-10-08T12:00:00Z');

function vercel(overrides: Partial<NonNullable<MachineUsage['vercel']>> = {}): MachineUsage {
	return {
		runner: 'vercel',
		status: 'running',
		startedAt: new Date(NOW - 77 * 60_000).toISOString(),
		uptimeSeconds: 77 * 60,
		lastActiveAt: new Date(NOW - 60_000).toISOString(),
		idleTimeoutMinutes: 60,
		stopsAt: new Date(NOW + 59 * 60_000).toISOString(),
		maxLifetimeHours: 168,
		lifetimeEndsAt: new Date(NOW + 160 * 3600_000).toISOString(),
		machines: { count: 2, limit: 3 },
		kubernetes: null,
		vercel: {
			vcpus: 2,
			memoryBytes: 4 * GIB,
			cpu: { usedCores: 0.42, totalCores: 2 },
			memory: { usedBytes: 1.2 * GIB, totalBytes: 4 * GIB },
			sessionExpiresAt: new Date(NOW + 42 * 60_000).toISOString(),
			sessionTimeoutMinutes: 60,
			activeCpuMs: 180_000,
			totalActiveCpuMs: null,
			networkIngressBytes: 1024 * 1024,
			networkEgressBytes: 4.8 * 1024 * 1024,
			totalIngressBytes: null,
			totalEgressBytes: null,
			disk: { usedBytes: 4.5 * GIB, capacityBytes: 64 * GIB },
			...overrides
		},
		fetchedAt: new Date(NOW).toISOString()
	};
}

function kubernetes(overrides: Partial<MachineUsage> = {}): MachineUsage {
	return {
		...vercel(),
		runner: 'kubernetes',
		vercel: null,
		kubernetes: {
			cpu: { usedMillicores: 1960, limitMillicores: 2000, requestMillicores: 250 },
			memory: { usedBytes: 3.5 * GIB, limitBytes: 4 * GIB },
			disk: { usedBytes: null, capacityBytes: 10 * GIB }
		},
		...overrides
	};
}

test('a running vercel machine gets cpu, memory and disk meters and no session countdown', () => {
	const view = usageView(vercel(), NOW, true);
	assert.deepEqual(
		view.measured.map((m) => [m.key, m.value, m.level]),
		[
			['cpu', '0.4 of 2 cores', null],
			['memory', '1.2 of 4 GB', null],
			['disk', '4.5 of 64 GB', null]
		]
	);
	assert.deepEqual(view.time, ['Up 1h 17m', 'Sleeps after 60m idle']);
	assert.equal(view.footer, '2 of 3 machines · 4.8 MB out');
	assert.equal(view.network?.summary, '4.8 MB out · 1 MB in');
	assert.equal(view.meters[0].caption, '2 vCPU · Vercel');
	assert.equal(view.meters[2].percent, 7);
	assert.ok(!JSON.stringify(view).includes('Session'));
});

test('sleep switches to a countdown only in the last ten minutes', () => {
	const soon = vercel();
	soon.stopsAt = new Date(NOW + 4 * 60_000 + 10_000).toISOString();
	assert.equal(usageView(soon, NOW, true).time[1], 'Sleeps in 4m');
	soon.stopsAt = new Date(NOW + 11 * 60_000).toISOString();
	assert.equal(usageView(soon, NOW, true).time[1], 'Sleeps after 60m idle');
	soon.stopsAt = new Date(NOW - 1000).toISOString();
	assert.equal(usageView(soon, NOW, true).time[1], 'Sleeping soon');
	soon.idleTimeoutMinutes = null;
	soon.stopsAt = null;
	assert.equal(usageView(soon, NOW, true).time[1], 'Never sleeps when idle');
});

test('kubernetes meters flag near and at the limit, and skip what was not measured', () => {
	const view = usageView(kubernetes(), NOW, false);
	assert.deepEqual(
		view.measured.map((m) => [m.key, m.value, m.level, m.percent]),
		[
			['cpu', '2 of 2 cores', 'full', 98],
			['memory', '3.5 of 4 GB', 'near', 88]
		]
	);
	assert.equal(view.meters.length, 3);
	assert.equal(view.meters[2].value, '10 GB');
	assert.equal(view.meters[0].caption, 'Kubernetes limit · 0.25 reserved');
	assert.equal(view.machines, 'Host has 2 of 3 machines');
	assert.equal(view.network, null);
});

test('a stopped machine shows its static limits and no live numbers', () => {
	const stopped = vercel({ cpu: { usedCores: null, totalCores: 2 } });
	stopped.status = 'stopped';
	stopped.startedAt = null;
	stopped.stopsAt = null;
	const view = usageView(stopped, NOW, true);
	assert.equal(view.live, false);
	assert.deepEqual(view.measured, []);
	assert.deepEqual(view.time, []);
	assert.equal(view.limits, '2 cores · 4 GB memory · 64 GB disk');
	assert.ok(view.meters.every((m) => m.fraction === null && m.used === null));
	assert.equal(view.runtime.up, null);
	assert.equal(view.runtime.sleep, 'Sleeps after 60m idle');
	assert.equal(view.runtime.lifetime, 'Runs at most 7d');
	assert.equal(view.machinesDetail, 'Room for 1 more');
});

test('an older server without live cpu or memory still shows the allocation', () => {
	const old = vercel();
	delete old.vercel!.cpu;
	delete old.vercel!.memory;
	const view = usageView(old, NOW, true);
	assert.deepEqual(
		view.measured.map((m) => m.key),
		['disk']
	);
	assert.equal(view.meters[0].value, '2 cores');
	assert.equal(view.meters[1].value, '4 GB');
});

test('the lifetime only joins the menu line in its final hour', () => {
	const ending = vercel();
	ending.lifetimeEndsAt = new Date(NOW + 30 * 60_000).toISOString();
	assert.deepEqual(usageView(ending, NOW, true).time, [
		'Up 1h 17m',
		'Sleeps after 60m idle',
		'Lifetime ends in 30m'
	]);
	assert.equal(usageView(ending, NOW, true).runtime.lifetime, 'Runs at most 7d, stops in 30m');
});

test('byte and minute labels stay short and never drop trailing zeros of whole numbers', () => {
	assert.equal(formatBytes(10 * GIB), '10 GB');
	assert.equal(formatBytes(100 * 1024 * 1024), '100 MB');
	assert.equal(formatBytes(1.5 * GIB), '1.5 GB');
	assert.equal(minutesLabel(60), '60m');
	assert.equal(minutesLabel(180), '3h');
	assert.equal(minutesLabel(10_080), '7d');
});
