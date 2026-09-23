import assert from 'node:assert/strict';
import test from 'node:test';
import { CueGate, cueForBuildEvent, cueForBuildStatus } from './sound-cues';

test('only a finished build has a sound; every intermediate status is silent', () => {
	assert.equal(cueForBuildStatus('succeeded'), 'success');
	assert.equal(cueForBuildStatus('failed'), 'error');
	assert.equal(cueForBuildStatus('building'), null);
	assert.equal(cueForBuildStatus('queued'), null);
	assert.equal(cueForBuildStatus(undefined), null);
});

test('a build cues only for the app on screen or one this browser started', () => {
	const ctx = { focusedDeploymentId: 'dep-a', watched: new Set(['dep-b']) };
	const done = (id: string) => ({
		type: 'build.changed',
		id,
		payload: { buildStatus: 'succeeded' }
	});
	assert.equal(cueForBuildEvent(done('dep-a'), ctx), 'success');
	assert.equal(cueForBuildEvent(done('dep-b'), ctx), 'success');
	assert.equal(cueForBuildEvent(done('dep-c'), ctx), null);
	assert.equal(
		cueForBuildEvent(
			{ type: 'build.changed', id: 'dep-a', payload: { buildStatus: 'building' } },
			ctx
		),
		null
	);
	assert.equal(cueForBuildEvent({ type: 'deployment.changed', id: 'dep-a' }, ctx), null);
	assert.equal(cueForBuildEvent({ type: 'build.changed', id: 'dep-a' }, ctx), null);
});

test('a burst of events for the same cue collapses into one sound', () => {
	const gate = new CueGate(2000);
	assert.equal(gate.allow('success', 1000), true);
	assert.equal(gate.allow('success', 1500), false);
	assert.equal(gate.allow('error', 1500), true);
	assert.equal(gate.allow('success', 3001), true);
});
