import assert from 'node:assert/strict';
import test from 'node:test';
import {
	computeHealth,
	type ContainerFact,
	type HealthInput,
	type HealthPod,
	type Rollout
} from './health.ts';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function pod(
	name: string,
	over: Partial<HealthPod> = {},
	web: Partial<ContainerFact> = {}
): HealthPod {
	return {
		name,
		revision: 'aaa',
		phase: 'Running',
		scheduled: true,
		createdAt: ago(3600),
		readySince: ago(3500),
		probes: { liveness: false, readiness: true, startup: false },
		containers: [
			{ name: 'web', ready: true, state: 'running', startedAt: ago(3550), restartCount: 0, ...web }
		],
		...over
	};
}

const ready = (name: string, revision = 'aaa') => pod(name, { revision });

const crashing = (name: string, revision = 'aaa', reason = 'Error', exitCode = 1) =>
	pod(
		name,
		{ revision, readySince: null, notReadySince: ago(300) },
		{
			ready: false,
			state: 'waiting',
			reason: 'CrashLoopBackOff',
			restartCount: 5,
			lastTermination: { reason, exitCode, finishedAt: ago(20) }
		}
	);

const booting = (name: string, revision = 'aaa', age = 20) =>
	pod(
		name,
		{ revision, createdAt: ago(age), readySince: null, notReadySince: ago(age) },
		{ ready: false, state: 'running', startedAt: ago(age - 2) }
	);

const health = (input: Partial<HealthInput> & Pick<HealthInput, 'pods'>) =>
	computeHealth({ replicas: input.pods.length, now: NOW, ...input });

function rollout(state: Rollout['state'], revs: [string, number, number, number][]): Rollout {
	const list = revs.map(([hash, number, replicas, ready]) => ({ hash, number, replicas, ready }));
	return {
		currentRevision: revs[0][0],
		revisions: list.filter((r, i) => i === 0 || r.replicas > 0),
		previous: list[1] ?? null,
		desired: 3,
		updated: revs[0][2],
		ready: 3,
		available: 3,
		state,
		reason: state === 'failed' ? 'ProgressDeadlineExceeded' : null
	};
}

test('all pods ready is healthy and quiet', () => {
	const h = health({ pods: [ready('a'), ready('b'), ready('c')] });
	assert.equal(h.app, 'healthy');
	assert.equal(h.deploy, null);
	assert.deepEqual(h.problems, []);
});

test('some pods crashing is degraded, not down', () => {
	const h = health({ pods: [ready('a'), ready('b'), crashing('c')] });
	assert.equal(h.app, 'degraded');
	assert.equal(h.problems.length, 1);
	assert.equal(h.problems[0].tone, 'warning');
	assert.match(h.problems[0].title, /1 pod of 3 keeps crashing/);
});

test('every pod crashing with no deploy is down, and only one alert', () => {
	const h = health({ pods: [crashing('a'), crashing('b'), crashing('c')] });
	assert.equal(h.app, 'down');
	assert.equal(h.problems.length, 1);
	assert.match(h.problems[0].title, /down: it keeps crashing/);
	assert.equal(h.problems[0].pods?.length, 3);
});

test('a pod that crashed long ago but is ready now raises nothing', () => {
	const h = health({
		pods: [
			pod(
				'a',
				{},
				{
					restartCount: 4,
					lastTermination: { reason: 'Error', exitCode: 1, finishedAt: ago(3000) }
				}
			)
		]
	});
	assert.equal(h.app, 'healthy');
	assert.deepEqual(h.problems, []);
});

test('one out of memory kill that recovered is silent', () => {
	const h = health({
		pods: [
			pod(
				'a',
				{},
				{
					restartCount: 1,
					lastTermination: { reason: 'OOMKilled', exitCode: 137, finishedAt: ago(60) }
				}
			)
		]
	});
	assert.deepEqual(h.problems, []);
});

test('repeated out of memory kills alert even while running', () => {
	const h = health({
		pods: [
			ready('a'),
			pod(
				'b',
				{},
				{
					restartCount: 3,
					lastTermination: { reason: 'OOMKilled', exitCode: 137, finishedAt: ago(90) }
				}
			)
		]
	});
	assert.equal(h.app, 'degraded');
	assert.equal(h.problems[0].problem, 'out-of-memory');
});

test('crash loop alerts right away, even on a young pod', () => {
	const young = crashing('a');
	young.createdAt = ago(15);
	const h = health({ pods: [young] });
	assert.equal(h.app, 'down');
	assert.equal(h.problems[0].problem, 'crash-loop');
});

test('a liveness kill is named as the health check, not a crash', () => {
	const p = crashing('a', 'aaa', 'Error', 137);
	p.probes = { liveness: true };
	const h = health({ pods: [ready('b'), p] });
	assert.equal(h.problems[0].problem, 'liveness');
});

test('exit 127 says the start command is missing', () => {
	const h = health({ pods: [crashing('a', 'aaa', 'Error', 127)] });
	assert.match(h.problems[0].hint, /start command wasn't found/);
});

test('a booting app inside the grace window is starting with no alerts', () => {
	const h = health({ pods: [booting('a'), booting('b')] });
	assert.equal(h.app, 'starting');
	assert.deepEqual(h.problems, []);
});

test('a running pod not ready for over two minutes is a health check problem', () => {
	const h = health({ pods: [ready('a'), booting('b', 'aaa', 200)] });
	assert.equal(h.app, 'degraded');
	assert.equal(h.problems[0].problem, 'not-ready');
});

test('a startup probe owns slow starts, so no not-ready alert', () => {
	const slow = booting('b', 'aaa', 400);
	slow.probes = { startup: true };
	const h = health({ pods: [ready('a'), slow] });
	assert.deepEqual(h.problems, []);
});

test('unschedulable waits 30s, then names the shortage', () => {
	const pending = (since: number) =>
		pod('b', {
			phase: 'Pending',
			scheduled: false,
			createdAt: ago(since + 1),
			unschedulableSince: ago(since),
			schedulingMessage: '0/3 nodes are available: 3 Insufficient memory.',
			readySince: null,
			containers: [{ name: 'web', state: 'waiting', ready: false }]
		});
	assert.deepEqual(health({ pods: [ready('a'), pending(10)] }).problems, []);
	const h = health({ pods: [ready('a'), pending(45)] });
	assert.equal(h.problems[0].problem, 'unschedulable');
	assert.match(h.problems[0].hint, /enough memory/);
});

test('image pull back-off waits a minute, then reads the registry message', () => {
	const pulling = (age: number) =>
		pod(
			'a',
			{ createdAt: ago(age), readySince: null },
			{
				state: 'waiting',
				ready: false,
				reason: 'ImagePullBackOff',
				message: 'Back-off pulling image "web:2": toomanyrequests: rate limit'
			}
		);
	assert.equal(health({ pods: [pulling(30)] }).app, 'starting');
	const h = health({ pods: [pulling(70)] });
	assert.equal(h.app, 'down');
	assert.match(h.problems[0].hint, /rate limiting/);
});

test('missing secret names the secret', () => {
	const h = health({
		pods: [
			pod(
				'a',
				{ createdAt: ago(40), readySince: null },
				{
					state: 'waiting',
					ready: false,
					reason: 'CreateContainerConfigError',
					message: 'secret "web-env" not found'
				}
			)
		]
	});
	assert.equal(h.problems[0].problem, 'missing-config');
	assert.match(h.problems[0].hint, /Secret web-env doesn't exist/);
});

test('a crashing init container is named as the setup step', () => {
	const p = pod(
		'a',
		{ phase: 'Pending', readySince: null },
		{ state: 'waiting', ready: false, reason: 'PodInitializing' }
	);
	p.containers = [
		{
			name: 'migrate',
			init: true,
			state: 'waiting',
			reason: 'CrashLoopBackOff',
			restartCount: 3,
			lastTermination: { reason: 'Error', exitCode: 1, finishedAt: ago(10) }
		},
		...(p.containers ?? [])
	];
	const h = health({ pods: [p] });
	assert.equal(h.problems[0].problem, 'crash-loop');
	assert.match(h.problems[0].hint, /migrate step that runs before your app/);
});

test('a crashing sidecar is named', () => {
	const p = ready('a');
	p.containers = [
		...(p.containers ?? []),
		{
			name: 'proxy',
			state: 'waiting',
			ready: false,
			reason: 'CrashLoopBackOff',
			restartCount: 3,
			lastTermination: { reason: 'Error', exitCode: 1, finishedAt: ago(10) }
		}
	];
	const h = health({ pods: [ready('b'), p] });
	assert.match(h.problems[0].hint, /proxy sidecar/);
});

test('evicted leftovers are history: hidden and silent', () => {
	const evicted = pod('x', { phase: 'Failed', reason: 'Evicted', notReadySince: ago(30) });
	const h = health({ pods: [ready('a'), evicted], replicas: 1 });
	assert.equal(h.app, 'healthy');
	assert.equal(h.pods.length, 1);
	assert.deepEqual(h.problems, []);
});

test('repeated evictions in ten minutes raise one warning', () => {
	const evicted = (n: string) =>
		pod(n, { phase: 'Failed', reason: 'Evicted', notReadySince: ago(120) });
	const h = health({ pods: [ready('a'), evicted('x'), evicted('y')], replicas: 1 });
	assert.equal(h.problems.length, 1);
	assert.equal(h.problems[0].problem, 'evicted');
});

test('a node that stops reporting is silent for a minute, then one warning', () => {
	const stale = (s: number) => pod('b', { readySince: null, notReadySince: ago(s) });
	const quiet = health({ pods: [ready('a'), stale(20)] });
	assert.deepEqual(quiet.problems, []);
	assert.equal(quiet.serving, 1);
	const h = health({ pods: [ready('a'), stale(90)] });
	assert.equal(h.problems.length, 1);
	assert.equal(h.problems[0].problem, 'lost');
});

test('a pod being drained is just stopping', () => {
	const h = health({
		pods: [ready('a'), pod('b', { disruption: 'EvictionByEvictionAPI' })],
		replicas: 1
	});
	assert.equal(h.app, 'healthy');
	assert.deepEqual(h.problems, []);
});

test('a pod stuck terminating past its grace warns once', () => {
	assert.deepEqual(
		health({ pods: [ready('a'), pod('b', { deletingAt: ago(10) })], replicas: 1 }).problems,
		[]
	);
	const h = health({ pods: [ready('a'), pod('b', { deletingAt: ago(120) })], replicas: 1 });
	assert.equal(h.problems[0].problem, 'stuck-terminating');
});

test('quota blocking a scale-up is a warning, not a deploy', () => {
	const h = health({
		pods: [ready('a')],
		replicas: 3,
		rollout: {
			...rollout('stable', [['aaa', 1, 1, 1]]),
			reason: 'pods "web-x" is forbidden: exceeded quota: compute'
		}
	});
	assert.equal(h.deploy, null);
	assert.equal(h.problems[0].problem, 'quota');
	assert.match(h.problems[0].title, /2 pods of 3/);
});

test('zero replicas is stopped, not down', () => {
	const h = health({ pods: [], replicas: 0, stopped: true });
	assert.equal(h.app, 'stopped');
	assert.deepEqual(h.problems, []);
});

test('old ready and new starting is a normal deploy', () => {
	const h = health({
		pods: [ready('a'), ready('b'), ready('c'), booting('n', 'bbb')],
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

test('new version crashing while old serves is a failed deploy, app still up', () => {
	const h = health({
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

test('new pod with no room is a stuck deploy, a warning', () => {
	const h = health({
		pods: [
			ready('a'),
			pod('n', {
				revision: 'bbb',
				phase: 'Pending',
				scheduled: false,
				createdAt: ago(60),
				unschedulableSince: ago(58),
				schedulingMessage: '0/3 nodes are available: 3 Insufficient cpu.',
				readySince: null,
				containers: [{ name: 'web', state: 'waiting' }]
			})
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

test('old crashing and new ready is a fix rolling out, no app alert', () => {
	const h = health({
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

test('old and new both crashing is down and the deploy failed', () => {
	const h = health({
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

test('a recreate deploy whose new version crashes says the old one was stopped', () => {
	const h = health({
		pods: [crashing('n', 'bbb')],
		replicas: 1,
		strategy: 'recreate',
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 0, 0]
		])
	});
	assert.equal(h.app, 'down');
	assert.equal(h.deploy, 'failed');
	assert.equal(h.pods[0].version, 'new');
	assert.match(h.problems[0].hint, /v1 was stopped/);
});

test('a recreate deploy booting is starting, not down', () => {
	const h = health({
		pods: [booting('n', 'bbb')],
		replicas: 1,
		strategy: 'recreate',
		rollout: rollout('progressing', [
			['bbb', 2, 1, 0],
			['aaa', 1, 0, 0]
		])
	});
	assert.equal(h.app, 'starting');
	assert.equal(h.deploy, 'deploying');
	assert.deepEqual(h.problems, []);
});

test('deadline exceeded is a failed deploy even with nothing crashing', () => {
	const h = health({
		pods: [ready('a'), booting('n', 'bbb')],
		replicas: 1,
		rollout: rollout('failed', [
			['bbb', 2, 1, 0],
			['aaa', 1, 1, 1]
		])
	});
	assert.equal(h.deploy, 'failed');
	assert.match(h.problems[0].title, /never became ready/);
});

test('two deploys in a second mark the middle revision as replaced, and it never alerts', () => {
	const h = health({
		pods: [ready('a'), crashing('m', 'bbb'), booting('n', 'ccc')],
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
	assert.deepEqual(h.problems, []);
});

test('build failure while the app runs keeps the app healthy', () => {
	const h = health({ pods: [ready('a')], buildStatus: 'failed' });
	assert.equal(h.app, 'healthy');
	assert.equal(h.build, 'failed');
	assert.equal(h.problems[0].scope, 'build');
});

test('pods without facts fall back to their status', () => {
	const h = computeHealth({ pods: [{ name: 'a', status: 'starting' }], replicas: 1, now: NOW });
	assert.equal(h.app, 'starting');
	assert.deepEqual(h.problems, []);
});
