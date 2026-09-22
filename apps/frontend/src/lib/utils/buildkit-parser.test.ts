import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildkitLogs, createBuildkitParser } from './buildkitParser';

test('transcoded hex step ids parse the same as plain counter ids', () => {
	const { steps } = parseBuildkitLogs(
		[
			'#a91f0c3e [builder 2/5] RUN pnpm install',
			'#a91f0c3e 2.500 added 400 packages',
			'#a91f0c3e DONE 8.4s',
			'#12 [runner 1/2] COPY --from=builder /app /app',
			'#12 CACHED'
		].join('\n')
	);

	assert.deepEqual(
		steps.map((s) => [s.id, s.stage, s.stagePos, s.status, s.durationSec]),
		[
			['a91f0c3e', 'builder', '2/5', 'done', 8.4],
			['12', 'runner', '1/2', 'cached', null]
		]
	);
	assert.deepEqual(steps[0].output, ['2.500 added 400 packages']);
});

test('the transferred badge follows the latest reading, not the first', () => {
	const { steps } = parseBuildkitLogs(
		[
			'#0c1d2e3f internal load build context',
			'#0c1d2e3f transferring context 0.04kB',
			'#0c1d2e3f transferring context 69.57kB done',
			'#0c1d2e3f DONE 1.2s'
		].join('\n')
	);
	assert.equal(steps[0].transferred, '69.57kB');
});

test('a step the build never closed reads as canceled, not running', () => {
	const { steps } = parseBuildkitLogs(
		['#0c1d2e3f exporting to oci image format', '#0c1d2e3f CANCELED'].join('\n')
	);
	assert.equal(steps[0].status, 'canceled');
	assert.equal(steps[0].command, 'Exporting image layers');
});

test('an errored step keeps its own output alongside the error', () => {
	const { steps } = parseBuildkitLogs(
		[
			'#a91f0c3e [builder 2/5] RUN pnpm build',
			'#a91f0c3e 7.102 error during build:',
			'#a91f0c3e ERROR: process "pnpm build" did not complete successfully: exit code: 1'
		].join('\n')
	);
	assert.equal(steps[0].status, 'error');
	assert.match(steps[0].error ?? '', /exit code: 1/);
	assert.deepEqual(steps[0].output, ['7.102 error during build:']);
});

test('the incremental parser reaches the same state as a full reparse', () => {
	const chunks = [
		'#a91f0c3e [builder 2/5] RUN pnpm install\n',
		'#a91f0c3e 2.500 added 400 packages\n#a91f0c3e DONE 8.4s\n',
		'#0c1d2e3f exporting to oci image format\n#0c1d2e3f DONE 0.9s\n'
	];
	const parse = createBuildkitParser();
	let raw = '';
	let incremental = parse(raw);
	for (const chunk of chunks) {
		raw += chunk;
		incremental = parse(raw);
	}
	assert.deepEqual(incremental, parseBuildkitLogs(raw));
});
