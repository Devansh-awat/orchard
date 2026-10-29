import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHealth, type HealthPod, type Rollout } from './health.ts';

const ready = (name: string, revision = 'aaa'): HealthPod => ({ name, status: 'ready', revision });
const crashing = (name: string, revision = 'aaa', reason = 'Error'): HealthPod => ({
	name,
	status: 'crashing',
	revision,
	containers: [
		{ name: 'web', lastTermination: { reason, exitCode: reason === 'OOMKilled' ? 137 : 1 } }
	]
});

function rollout(state: Rollout['state'], revs: [string, number, number, number][]): Rollout {
	return {
		currentRevision: revs[0][0],
		revisions: revs.map(([hash, number, replicas, ready]) => ({ hash, number, replicas, ready })),
		desired: 3,
		updated: revs[0][2],
		ready: 3,
		available: 3,
		state,
		reason: state === 'failed' ? 'ProgressDeadlineExceeded' : null
	};
}

test('1. all pods ready is healthy and quiet', () => {
	const h = computeHealth({ pods: [ready('a'), ready('b'), ready('c')], replicas: 3 });
	assert.equal(h.app, 'healthy');
	assert.equal(h.deploy, null);
	assert.deepEqual(h.problems, []);
});

test('2. some pods crashing is degraded, not down', () => {
	const h = computeHealth({ pods: [ready('a'), ready('b'), crashing('c')], replicas: 3 });
	assert.equal(h.app, 'degraded');
	assert.equal(h.problems[0].scope, 'app');
	assert.equal(h.problems[0].tone, 'warning');
});

test('3. every pod crashing with no deploy is down', () => {
	const h = computeHealth({ pods: [crashing('a'), crashing('b')], replicas: 2 });
	assert.equal(h.app, 'down');
	assert.match(h.problems[0].title, /down/);
});

test('9. a pod that crashed earlier but is ready now raises nothing', () => {
	const h = computeHealth({
		pods: [
			{
				...ready('a'),
				restartCount: 4,
				containers: [{ name: 'web', lastTermination: { reason: 'Error', exitCode: 1 } }]
			}
		],
		replicas: 1
	});
	assert.equal(h.app, 'healthy');
	assert.deepEqual(h.problems, []);
});

test('12. zero replicas is stopped, not down', () => {
	const h = computeHealth({ pods: [], replicas: 0, stopped: true });
	assert.equal(h.app, 'stopped');
	assert.deepEqual(h.problems, []);
});

test('14. old ready and new starting is a normal deploy', () => {
	const h = computeHealth({
		pods: [ready('a'), ready('b'), ready('c'), { name: 'n', status: 'starting', revision: 'bbb' }],
		replicas: 3,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 3, 3]
		])
	});
	assert.equal(h.app, 'healthy');
	assert.equal(h.deploy, 'deploying');
	assert.deepEqual(h.problems, []);
	assert.equal(h.pods.find((p) => p.name === 'n')?.version, 'new');
	assert.equal(h.pods.find((p) => p.name === 'a')?.version, 'old');
});

test('15. new version crashing while old serves is a failed deploy, app still up', () => {
	const h = computeHealth({
		pods: [ready('a'), ready('b'), ready('c'), crashing('n', 'bbb')],
		replicas: 3,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 3, 3]
		])
	});
	assert.equal(h.app, 'healthy');
	assert.equal(h.deploy, 'failed');
	assert.equal(h.problems.length, 1);
	assert.equal(h.problems[0].scope, 'deploy');
	assert.match(h.problems[0].hint, /build succeeded/i);
	assert.match(h.problems[0].hint, /Still serving v1/);
});

test('16. new image that cannot be pulled names the image problem', () => {
	const h = computeHealth({
		pods: [ready('a'), { name: 'n', status: 'crashing', revision: 'bbb' }],
		warnings: [{ podName: 'n', message: 'web: Back-off pulling image "web:2"' }],
		replicas: 1,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 1]
		])
	});
	assert.equal(h.deploy, 'failed');
	assert.equal(h.problems[0].problem, 'image-pull');
});

test('18. new pod with no room is a stuck deploy, a warning', () => {
	const h = computeHealth({
		pods: [ready('a'), { name: 'n', status: 'pending', revision: 'bbb' }],
		warnings: [
			{ podName: 'n', message: 'FailedScheduling: 0/3 nodes are available: 3 Insufficient memory.' }
		],
		replicas: 1,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 1]
		])
	});
	assert.equal(h.deploy, 'stuck');
	assert.equal(h.problems[0].tone, 'warning');
});

test('21. old crashing and new ready is a fix rolling out, no app alert', () => {
	const h = computeHealth({
		pods: [crashing('a'), crashing('b'), ready('n', 'bbb')],
		replicas: 2,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 1],
			['aaa', 1, 2, 0]
		])
	});
	assert.equal(h.deploy, 'deploying');
	assert.notEqual(h.app, 'down');
	assert.equal(h.problems.filter((p) => p.scope === 'app').length, 0);
});

test('22. old and new both crashing is down and the deploy failed', () => {
	const h = computeHealth({
		pods: [crashing('a'), crashing('n', 'bbb')],
		replicas: 1,
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 0]
		])
	});
	assert.equal(h.app, 'down');
	assert.equal(h.deploy, 'failed');
	assert.match(h.problems[0].title, /new version fails too/);
});

test('23. deadline exceeded is a failed deploy even with nothing crashing', () => {
	const h = computeHealth({
		pods: [ready('a'), { name: 'n', status: 'starting', revision: 'bbb' }],
		replicas: 1,
		rollout: rollout('failed', [
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 1]
		])
	});
	assert.equal(h.deploy, 'failed');
	assert.match(h.problems[0].title, /never became ready/);
});

test('two deploys in a second mark the middle revision as replaced', () => {
	const h = computeHealth({
		pods: [
			ready('a'),
			{ name: 'm', status: 'terminating', revision: 'bbb' },
			{ name: 'n', status: 'starting', revision: 'ccc' }
		],
		replicas: 1,
		rollout: rollout('progressing', [
			['ccc', 3, 1, 0],
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 1]
		])
	});
	assert.equal(h.pods.find((p) => p.name === 'm')?.version, 'replaced');
	assert.equal(h.pods.find((p) => p.name === 'n')?.version, 'new');
	assert.equal(h.current?.number, 3);
	assert.equal(h.previous?.number, 1);
});

test('build failure while the app runs keeps the app healthy', () => {
	const h = computeHealth({ pods: [ready('a')], replicas: 1, buildStatus: 'failed' });
	assert.equal(h.app, 'healthy');
	assert.equal(h.build, 'failed');
	assert.equal(h.problems[0].scope, 'build');
});

test('a restart where nothing is ready yet is starting, not down', () => {
	const h = computeHealth({ pods: [{ name: 'a', status: 'starting' }], replicas: 1 });
	assert.equal(h.app, 'starting');
	assert.deepEqual(h.problems, []);
});
