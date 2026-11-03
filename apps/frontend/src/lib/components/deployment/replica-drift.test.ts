import test from 'node:test';
import assert from 'node:assert/strict';
import { replicaDrift } from './deployment-helpers';

test('agreement is silent', () => {
	assert.equal(replicaDrift({ replicas: 1, specReplicas: 1, stopped: false }), null);
	assert.equal(replicaDrift({ replicas: 3, specReplicas: 3, stopped: false }), null);
});

test('an unmirrored deployment says nothing rather than guessing', () => {
	// No k8s_workloads row yet: a deployment whose first build has not landed.
	assert.equal(replicaDrift({ replicas: 1, specReplicas: null, stopped: false }), null);
	assert.equal(replicaDrift({ replicas: 1, stopped: false }), null);
});

test('an external scale to zero is reported, not hidden behind intent', () => {
	// The nemo-bot case: kubectl scaled it to 0, the row still said 1, and the
	// UI showed 1 with no pods.
	assert.deepEqual(replicaDrift({ replicas: 1, specReplicas: 0, stopped: false }), {
		observed: 0,
		desired: 1,
		stopped: false
	});
});

test('a stopped deployment is reported even though the row is correct', () => {
	// `stopped` deliberately keeps replicas as the restore point, so the numbers
	// disagree by design, which is exactly why it needs saying out loud.
	assert.deepEqual(replicaDrift({ replicas: 1, specReplicas: 0, stopped: true }), {
		observed: 0,
		desired: 1,
		stopped: true
	});
});

test('a scale up that has not landed yet is drift too', () => {
	assert.deepEqual(replicaDrift({ replicas: 3, specReplicas: 1, stopped: false }), {
		observed: 1,
		desired: 3,
		stopped: false
	});
});
