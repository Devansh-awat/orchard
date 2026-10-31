import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildkitLogs } from './buildkitParser';
import { diagnoseBuild } from './build-failure';

function diagnose(logs: string[], error: string | null = null, extra = {}) {
	return diagnoseBuild({ parsed: parseBuildkitLogs(logs.join('\n')), error, ...extra });
}

test('a missing Dockerfile is named under the daemon noise around it', () => {
	const error = [
		'Build failed: error: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory',
		'Container buildkit terminated: Error - exit code 1',
		'Container pusher terminated: StartError - failed to start containerd task "94fe": 429 ',
		'=== Build failed (exit code: 1) ===',
		'time="2026-10-29T00:18:57Z" level=warning msg="CDI setup error /etc/buildkit/cdi: failed to monitor for changes: no such file or directory"'
	].join('\n');
	const f = diagnose(
		[
			'[1793233141187] [ERROR] Build job image-builder-soft-pause-1fcc4925 failed',
			'[1793233141230] [ERROR] Error type: BadRequestException',
			"❌ Build failed at step 'failed'"
		],
		error,
		{ buildStep: 'failed', timestamps: { cloning: 1, building: 2 } }
	);
	assert.equal(f.canceled, false);
	assert.equal(f.title, 'There is no Dockerfile in the repo');
	assert.equal(f.setting, 'source');
	assert.equal(f.phase, 'build');
	assert.ok(f.evidence.every((l) => !/429|CDI|BadRequestException|terminated/.test(l)));
	assert.match(f.evidence[0], /^failed to solve: failed to read dockerfile/);
});

test('a canceled build reads as canceled, not failed', () => {
	const f = diagnose(
		[
			'#4fd418dc exporting to image',
			'#4fd418dc DONE 0.0s',
			'[1793233309481] [INFO] Build cancelled by user',
			'[1793233309487] [ERROR] Build failed: Build failed: build cancelled'
		],
		'Build failed: build cancelled'
	);
	assert.equal(f.canceled, true);
	assert.equal(f.title, 'This build was canceled');
});

test('a failing RUN names its command, exit code and the lines that matter', () => {
	const f = diagnose([
		'#a91f0c3e [build 5/6] RUN pnpm build',
		'#a91f0c3e 4.120 vite v8.3.4 building for production...',
		'#a91f0c3e 9.884 src/routes/+page.svelte (12:4): Unexpected token',
		'#a91f0c3e 9.901 error during build:',
		'#a91f0c3e ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1'
	]);
	assert.equal(f.phase, 'build');
	assert.equal(f.step?.id, 'a91f0c3e');
	assert.equal(f.title, '`pnpm build` failed with exit code 1');
	assert.equal(f.fix, 'Run `pnpm build` locally to reproduce it.');
	assert.deepEqual(f.evidence.slice(-1), ['error during build:']);
	assert.ok(f.evidence.every((l) => !/^\d+\.\d{3}/.test(l)));
});

test('an outdated pnpm lockfile says which file to commit', () => {
	const f = diagnose([
		'#5 [deps 3/6] RUN pnpm install --frozen-lockfile',
		'#5 1.100 Lockfile is up to date, resolution step is skipped',
		'#5 1.204 ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
		'#5 1.205 Failure reason:',
		'#5 1.205 specifiers in the lockfile do not match specs in package.json',
		'#5 ERROR: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully: exit code: 1'
	]);
	assert.equal(f.title, "pnpm-lock.yaml doesn't match package.json");
	assert.equal(f.fix, 'Run `pnpm install` locally and commit pnpm-lock.yaml.');
	assert.match(f.evidence[0], /^ERR_PNPM_OUTDATED_LOCKFILE/);
	assert.equal(f.evidence.at(-1), 'specifiers in the lockfile do not match specs in package.json');
});

test('npm ci out of sync points at package-lock.json', () => {
	const f = diagnose([
		'#5 [3/5] RUN npm ci',
		'#5 2.1 npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
		'#5 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1'
	]);
	assert.equal(f.fix, 'Run `npm install` locally and commit package-lock.json.');
});

test('typescript errors are counted and become the evidence', () => {
	const f = diagnose([
		'#7 [build 4/4] RUN npx tsc',
		'#7 3.2 src/index.ts(4,7): error TS2322: Type string is not assignable to type number.',
		'#7 3.2 src/db.ts(9,1): error TS2304: Cannot find name foo.',
		'#7 ERROR: process "/bin/sh -c npx tsc" did not complete successfully: exit code: 2'
	]);
	assert.equal(f.title, 'TypeScript found 2 errors');
	assert.equal(f.evidence.length, 2);
	assert.match(f.fix ?? '', /`npx tsc` fails the same way locally/);
});

test('a missing package and a missing file get different fixes', () => {
	const pkg = diagnose([
		'#8 [6/6] RUN node build.js',
		"#8 0.4 Error: Cannot find module 'esbuild'",
		'#8 ERROR: process "/bin/sh -c node build.js" did not complete successfully: exit code: 1'
	]);
	assert.equal(pkg.fix, 'Add `esbuild` to dependencies in package.json.');
	const file = diagnose([
		'#8 [6/6] RUN node build.js',
		"#8 0.4 Error: Cannot find module './Config'",
		'#8 ERROR: process "/bin/sh -c node build.js" did not complete successfully: exit code: 1'
	]);
	assert.match(file.fix ?? '', /case sensitive/);
});

test('a COPY of a path that is not in the context names the path', () => {
	const f = diagnose([
		'#6 [4/5] COPY dist ./dist',
		'#6 ERROR: failed to calculate checksum of ref abc::xyz: "/dist": not found'
	]);
	assert.equal(f.title, '`dist` is not in the build');
});

test('a missing binary and an out of memory kill', () => {
	assert.equal(
		diagnose([
			'#4 [3/4] RUN make all',
			'#4 0.1 /bin/sh: 1: make: not found',
			'#4 ERROR: process "/bin/sh -c make all" did not complete successfully: exit code: 127'
		]).title,
		"`make` isn't installed in the image"
	);
	assert.equal(
		diagnose([
			'#4 [3/4] RUN pnpm build',
			'#4 40.2 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
			'#4 ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 134'
		]).title,
		'The build ran out of memory'
	);
});

test('a base image that does not exist names the image without the docker.io prefix', () => {
	const f = diagnose([
		'#2 [internal] load metadata for docker.io/library/nod:22-slim',
		'#2 ERROR: docker.io/library/nod:22-slim: failed to resolve source metadata for docker.io/library/nod:22-slim: pull access denied, repository does not exist or may require authorization'
	]);
	assert.equal(f.title, "The base image `nod:22-slim` can't be pulled");
});

test('clone failures land on the clone phase even without a buildkit step', () => {
	const f = diagnose(
		['Cloning https://github.com/hackclub/app (branch dev)'],
		'fatal: Remote branch dev not found in upstream origin',
		{ timestamps: { cloning: 1 } }
	);
	assert.equal(f.phase, 'clone');
	assert.equal(f.title, "The branch `dev` doesn't exist");
	assert.equal(f.setting, 'source');
});

test('an unknown failure falls back to the cleaned error, not a fake cause', () => {
	const f = diagnose([], 'Build failed: Build failed: something odd happened\nError Type: Error', {
		timestamps: { cloning: 1, building: 2, pushing: 3 }
	});
	assert.equal(f.title, 'something odd happened');
	assert.equal(f.fix, null);
	assert.equal(f.phase, 'push');
});

test('a deploy that never got ready is not called a build failure', () => {
	const f = diagnose(
		['#9 exporting to image', '#9 DONE 0.4s', 'Rolling out web (strategy: blueGreen)'],
		'Deploy failed: the new pods crashed on start (exit 1). The previous release kept serving.',
		{ timestamps: { cloning: 1, building: 2, pushing: 3, deploying: 4 } }
	);
	assert.equal(f.phase, 'deploy');
	assert.equal(f.setting, 'crash');
	assert.match(f.title, /never became ready/);
	assert.deepEqual(f.evidence, ['the new pods crashed on start (exit 1)']);
});
