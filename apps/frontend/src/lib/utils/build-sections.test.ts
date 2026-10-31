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
