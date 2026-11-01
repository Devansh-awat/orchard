import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildkitLogs } from './buildkitParser';
import { buildSections } from './build-sections';

const REAL = [
	'Auto-deploy triggered by push to main',
	'Commit: a2bc1df - Merge pull request #1 from IzieStratt/fix/hardening',
	'[1793318823376] [INFO] Using Kubernetes BuildKit builder for https://github.com/x/y@main',
	'[1793318824661] [INFO] Started a build VM in 1.2s',
	'=== Fetching source ===',
	'Repository: https://***@github.com/x/y',
	'Branch: main',
	'Commit: a2bc1df479a094d428d4237cbe49e3b48b76ae00',
	'#c3a49305 [internal] load build definition from Dockerfile',
	'#c3a49305 DONE 0.0s',
	'#34020c3e [build 5/8] RUN npm ci',
	'#34020c3e CACHED',
	'#0616c67c exporting to image',
	'#0616c67c DONE 0.4s',
	'[1793318835956] [INFO] Image: soft-pause:v20261030T00070',
	'[1793318835956] [INFO] Build and push completed successfully.',
	'[INFO] Creating Kubernetes deployment...',
	'Image applied; Kubernetes is rolling the new pods out',
	'Rebuild complete. Deployment is live.'
].join('\n');

test('a real build log splits into its phases in order', () => {
	const sections = buildSections(parseBuildkitLogs(REAL));
	assert.deepEqual(
		sections.map((s) => [s.phase, s.items.length]),
		[
			['queue', 4],
			['clone', 4],
			['build', 3],
			['push', 2],
			['deploy', 3]
		]
	);
	const build = sections.find((s) => s.phase === 'build')!;
	assert.equal(build.steps, 3);
	assert.equal(build.cached, 1);
});

test('lines never move back to an earlier phase', () => {
	const sections = buildSections(
		parseBuildkitLogs(
			['#1 [base 1/2] FROM node', '#1 DONE 0.1s', 'Cloning again for no reason'].join('\n')
		)
	);
	assert.deepEqual(
		sections.map((s) => s.phase),
		['build']
	);
});

const MULTI_STAGE = [
	'=== Building image ===',
	'#c3a49305 [internal] load build definition from Dockerfile',
	'#c3a49305 DONE 0.1s',
	'#5d0e7a12 [internal] load metadata for docker.io/library/node:22-slim',
	'#5d0e7a12 DONE 0.6s',
	'#e1f7c204 [deps 1/4] FROM docker.io/library/node:22-slim',
	'#e1f7c204 CACHED',
	'#07c3f5aa [deps 2/4] WORKDIR /app',
	'#07c3f5aa CACHED',
	'#d4a9e0b2 [runner 1/3] FROM gcr.io/distroless/nodejs22-debian12',
	'#d4a9e0b2 CACHED',
	'#4b2d9e61 [internal] load build context',
	'#4b2d9e61 DONE 0.4s',
	'#b8e2d013 [deps 3/4] COPY package.json pnpm-lock.yaml ./',
	'#b8e2d013 CACHED',
	'#2f6a8c91 [deps 4/4] RUN pnpm install --frozen-lockfile',
	'#2f6a8c91 12.410 Packages: +612',
	'#2f6a8c91 DONE 18.4s',
	'#3e9f07b5 [build 1/2] COPY . .',
	'#3e9f07b5 DONE 0.4s',
	'#8e5c1d73 [build 2/2] RUN pnpm build',
	'#8e5c1d73 DONE 11.6s',
	'#c90a2e64 [runner 2/3] COPY --from=build /app/build ./build',
	'#c90a2e64 CACHED',
	'#0616c67c exporting to image',
	'#0616c67c DONE 0.9s'
].join('\n');

function stagesOf(raw: string) {
	const build = buildSections(parseBuildkitLogs(raw)).find((s) => s.phase === 'build')!;
	return build.items.flatMap((i) => (i.kind === 'stage' ? [i.stage] : []));
}

test('the image build splits into its Dockerfile stages in the order they started', () => {
	const stages = stagesOf(MULTI_STAGE);
	assert.deepEqual(
		stages.map((s) => [s.kind, s.name, s.items.length]),
		[
			['setup', null, 3],
			['stage', 'deps', 4],
			['stage', 'runner', 2],
			['stage', 'build', 2],
			['export', null, 1]
		]
	);
});

test('each stage counts its cached steps and times only the ones that ran', () => {
	const byName = new Map(stagesOf(MULTI_STAGE).map((s) => [s.key, s]));
	const deps = byName.get('g:stage:deps')!;
	assert.deepEqual([deps.cached, deps.total, deps.durationSec, deps.status], [3, 4, 18.4, 'done']);
	const build = byName.get('g:stage:build')!;
	assert.equal(build.cached, 0);
	assert.equal(build.durationSec, 12);
	const runner = byName.get('g:stage:runner')!;
	assert.deepEqual(
		[runner.cached, runner.total, runner.durationSec, runner.status],
		[2, 3, null, 'cached']
	);
	assert.deepEqual(
		deps.items.map((i) => i.step.status),
		['cached', 'cached', 'cached', 'done']
	);
});

test('a failing step marks its stage, and a running one keeps it open', () => {
	const stages = stagesOf(
		[
			'#e1f7c204 [deps 1/2] FROM node',
			'#e1f7c204 CACHED',
			'#2f6a8c91 [deps 2/2] RUN pnpm install',
			'#2f6a8c91 ERROR: process "pnpm install" did not complete successfully: exit code: 1',
			'#3e9f07b5 [build 1/2] COPY . .'
		].join('\n')
	);
	assert.deepEqual(
		stages.map((s) => [s.name, s.status]),
		[
			['deps', 'error'],
			['build', 'running']
		]
	);
});

test('a log without Dockerfile stages stays a flat list of steps', () => {
	const build = buildSections(
		parseBuildkitLogs(
			['#1 [internal] load build definition from Dockerfile', '#1 DONE 0.1s'].join('\n')
		)
	).find((s) => s.phase === 'build')!;
	assert.deepEqual(
		build.items.map((i) => i.kind),
		['step']
	);
});

test('an unnamed single-stage Dockerfile still groups, with the position kept', () => {
	const { steps } = parseBuildkitLogs(
		[
			'#4 [ 1/12] FROM docker.io/library/node:22',
			'#4 CACHED',
			'#5 [linux/amd64 builder 2/3] RUN make',
			'#5 DONE 1.0s'
		].join('\n')
	);
	assert.deepEqual(
		steps.map((s) => [s.stage, s.stagePos]),
		[
			[null, '1/12'],
			['builder', '2/3']
		]
	);
	const stages = stagesOf(['#4 [ 1/12] FROM docker.io/library/node:22', '#4 CACHED'].join('\n'));
	assert.deepEqual(
		stages.map((s) => [s.kind, s.name, s.total, s.cached]),
		[['stage', null, 12, 1]]
	);
});
