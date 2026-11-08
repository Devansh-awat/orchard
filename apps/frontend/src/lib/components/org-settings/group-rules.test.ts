import test from 'node:test';
import assert from 'node:assert/strict';
import {
	describePreview,
	describeSaveError,
	describeSignInError,
	duplicateValue,
	missingOrganization,
	newRow,
	parseGroupList,
	rulesFromRows,
	snapshot
} from './group-rules';

test('blank rows are dropped and an org provider pins the organization', () => {
	const rows = [newRow({ value: ' eng ', role: 'admin' }), newRow({ value: '   ' })];
	assert.deepEqual(rulesFromRows(rows, 'org-1'), [
		{ value: 'eng', role: 'admin', organizationId: 'org-1' }
	]);
});

test('an instance rule keeps the organization picked on the row', () => {
	const rows = [newRow({ value: 'eng', organizationId: 'org-9' })];
	assert.equal(rulesFromRows(rows, null)[0].organizationId, 'org-9');
	assert.equal(missingOrganization(rows, null), false);
	assert.equal(missingOrganization([newRow({ value: 'eng' })], null), true);
	assert.equal(missingOrganization([newRow({ value: 'eng' })], 'org-1'), false);
});

test('duplicates are found per organization, after trimming', () => {
	const a = newRow({ value: 'eng', organizationId: 'o1' });
	const b = newRow({ value: ' eng ', organizationId: 'o1' });
	const c = newRow({ value: 'eng', organizationId: 'o2' });
	assert.equal(duplicateValue([a, c], null), null);
	assert.equal(duplicateValue([a, b], null), 'eng');
});

test('the snapshot ignores blank rows and claim whitespace', () => {
	const rows = [newRow({ value: 'eng' })];
	const base = snapshot('groups', rows, 'o');
	assert.equal(snapshot(' groups ', [...rows, newRow()], 'o'), base);
	assert.notEqual(snapshot('roles', rows, 'o'), base);
});

test('group lists split on lines and commas and drop repeats', () => {
	assert.deepEqual(parseGroupList('eng, ops\nops\n  \nsales'), ['eng', 'ops', 'sales']);
	assert.equal(
		parseGroupList(Array.from({ length: 600 }, (_, i) => `g${i}`).join(',')).length,
		500
	);
});

test('a preview with no rules says everyone gets the default role', () => {
	const line = describePreview({ hasRules: false, allowed: true, matches: [] }, () => null);
	assert.equal(line.tone, 'info');
});

test('a preview that matches nothing explains sso_not_mapped and the claim name', () => {
	const line = describePreview({ hasRules: true, allowed: false, matches: [] }, () => null);
	assert.equal(line.tone, 'warning');
	assert.match(line.title, /sso_not_mapped/);
	assert.match(line.detail ?? '', /group claim name/);
});

test('a matching preview names the role and the organization', () => {
	const line = describePreview(
		{
			hasRules: true,
			allowed: true,
			matches: [{ organizationId: 'o1', role: 'admin', ruleIds: [] }]
		},
		(id) => (id === 'o1' ? 'Acme' : null)
	);
	assert.equal(line.tone, 'success');
	assert.equal(line.title, 'Signs in as admin in Acme');
});

test('sign-in and save errors read as plain sentences', () => {
	assert.match(describeSignInError('sso_not_mapped') ?? '', /none of your groups/);
	assert.equal(describeSignInError('other'), null);
	assert.match(
		describeSaveError('Rules can grant admin, member or guest, never owner'),
		/never owner/
	);
	assert.match(
		describeSaveError('Another identity provider already has group rules for this organization'),
		/Remove its rules first/
	);
	assert.equal(describeSaveError('Unknown organization'), 'Unknown organization');
});
