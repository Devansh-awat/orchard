import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhases, formatPhase } from './build-phases';

const T = 1_700_000_000_000;

test('a finished build splits into every phase it recorded', () => {
	const phases = buildPhases({
		__start: T,
		submitted: T + 2_000,
		scheduled: T + 20_000,
		cloning: T + 24_000,
		building: T + 30_000,
		pushing: T + 90_000,
		deploying: T + 100_000,
		complete: T + 112_000
	});
	assert.deepEqual(
		phases.map((p) => [p.id, p.ms]),
		[
			['queue', 2_000],
			['schedule', 18_000],
			['start', 4_000],
			['clone', 6_000],
			['build', 60_000],
			['push', 10_000],
			['rollout', 12_000]
		]
	);
});

test('an old build without the new marks still reads, folding the missing phases forward', () => {
	const phases = buildPhases({
		__start: T,
		cloning: T + 20_000,
		building: T + 25_000,
		pushing: T + 80_000,
		deploying: T + 90_000,
		complete: T + 95_000
	});
	assert.deepEqual(
		phases.map((p) => p.id),
		['queue', 'clone', 'build', 'push', 'rollout']
	);
	assert.equal(phases[0].ms, 20_000);
});

test('a running build ends on a live phase measured to now', () => {
	const phases = buildPhases(
		{ __start: T, submitted: T + 1_000, scheduled: T + 9_000 },
		T + 15_000,
		true
	);
	assert.equal(phases.at(-1)?.id, 'start');
	assert.equal(phases.at(-1)?.live, true);
	assert.equal(phases.at(-1)?.ms, 6_000);
});

test('durations read as people say them', () => {
	assert.equal(formatPhase(400), '<1s');
	assert.equal(formatPhase(18_400), '18s');
	assert.equal(formatPhase(102_000), '1m 42s');
});
